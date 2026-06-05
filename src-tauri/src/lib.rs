use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// A single parsed syslog line.
#[derive(Clone, Serialize)]
struct LogLine {
    seq: u64,
    ts: String,
    process: String,
    subsystem: String,
    pid: u32,
    level: String,
    message: String,
    raw: String,
}

#[derive(Clone, Serialize)]
struct DeviceInfo {
    udid: String,
    name: String,
    network: bool,
}

#[derive(Clone, Serialize)]
struct ProcInfo {
    pid: u32,
    name: String,
}

struct AppState {
    child: Mutex<Option<Child>>,
    seq: Arc<AtomicU64>,
}

/// Parse a raw idevicesyslog line into structured fields.
///
/// Expected format:
///   `Jun  5 14:35:14.309072 backboardd(CoreBrightness)[71] <Debug>: message`
///   `Jun  5 14:35:14.286611 kernel()[0] <Notice>: message`
///   `Jun  5 14:35:14.309639 bluetoothd[97] <Info>:  message`
///
/// Connection markers like `[connected:UDID]` are surfaced as `Status` lines.
/// Anything that fails to parse is preserved verbatim with level `Unknown`.
fn parse_line(line: &str, seq: u64) -> LogLine {
    let raw = line.to_string();

    if line.starts_with('[') {
        return LogLine {
            seq,
            ts: String::new(),
            process: "syslog".into(),
            subsystem: String::new(),
            pid: 0,
            level: "Status".into(),
            message: line.to_string(),
            raw,
        };
    }

    let fallback = |level: &str| LogLine {
        seq,
        ts: String::new(),
        process: "?".into(),
        subsystem: String::new(),
        pid: 0,
        level: level.into(),
        message: line.to_string(),
        raw: raw.clone(),
    };

    // Timestamp ends at the first space *after* the time field (which contains ':').
    let colon = match line.find(':') {
        Some(c) => c,
        None => return fallback("Unknown"),
    };
    let after_time = match line[colon..].find(' ') {
        Some(i) => colon + i,
        None => return fallback("Unknown"),
    };
    let ts = line[..after_time].trim().to_string();
    let rest = line[after_time + 1..].trim_start();

    // `process(sub)[pid] <Level>: message`
    let lb = match rest.find('[') {
        Some(i) => i,
        None => return fallback("Unknown"),
    };
    let rb = match rest[lb..].find(']') {
        Some(i) => lb + i,
        None => return fallback("Unknown"),
    };

    let proc_part = &rest[..lb];
    let (process, subsystem) = match proc_part.find('(') {
        Some(p) => {
            let name = proc_part[..p].trim().to_string();
            let sub = proc_part[p + 1..]
                .trim_end_matches(')')
                .trim()
                .to_string();
            (name, sub)
        }
        None => (proc_part.trim().to_string(), String::new()),
    };

    let pid: u32 = rest[lb + 1..rb].parse().unwrap_or(0);

    // ` <Level>: message`
    let tail = rest[rb + 1..].trim_start();
    let (level, message) = match (tail.find('<'), tail.find('>')) {
        (Some(lt), Some(gt)) if gt > lt => {
            let level = tail[lt + 1..gt].to_string();
            let msg = tail[gt + 1..]
                .trim_start()
                .trim_start_matches(':')
                .trim_start()
                .to_string();
            (level, msg)
        }
        _ => ("Notice".to_string(), tail.to_string()),
    };

    LogLine {
        seq,
        ts,
        process,
        subsystem,
        pid,
        level,
        message,
        raw,
    }
}

fn list_udids(network: bool) -> Result<Vec<String>, String> {
    let flag = if network { "-n" } else { "-l" };
    let out = Command::new("idevice_id")
        .arg(flag)
        .output()
        .map_err(|e| format!("idevice_id 실행 실패: {e}. libimobiledevice가 설치돼 있나요?"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

fn device_name(udid: &str, network: bool) -> String {
    let mut cmd = Command::new("ideviceinfo");
    if network {
        cmd.arg("-n");
    }
    cmd.args(["-u", udid, "-k", "DeviceName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| udid.to_string())
}

#[tauri::command]
fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    // USB first, then WiFi. A device reachable both ways is listed once (USB wins).
    let usb = list_udids(false)?;
    let net = list_udids(true).unwrap_or_default();

    let mut devices = Vec::new();
    for udid in &usb {
        devices.push(DeviceInfo {
            udid: udid.clone(),
            name: device_name(udid, false),
            network: false,
        });
    }
    for udid in &net {
        if usb.contains(udid) {
            continue;
        }
        devices.push(DeviceInfo {
            udid: udid.clone(),
            name: device_name(udid, true),
            network: true,
        });
    }
    Ok(devices)
}

#[tauri::command]
fn list_processes(udid: Option<String>, network: bool) -> Result<Vec<ProcInfo>, String> {
    let mut cmd = Command::new("idevicesyslog");
    if let Some(u) = udid.as_ref().filter(|s| !s.is_empty()) {
        cmd.args(["-u", u]);
    }
    if network {
        cmd.arg("-n");
    }
    cmd.arg("pidlist");

    let out = cmd
        .output()
        .map_err(|e| format!("idevicesyslog pidlist 실행 실패: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(if err.trim().is_empty() {
            "프로세스 목록을 가져오지 못했습니다 (기기 연결/잠금 해제 확인)".into()
        } else {
            err.into_owned()
        });
    }

    let mut procs = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Format: "<pid> <name>"
        if let Some((pid, name)) = line.split_once(' ') {
            if let Ok(pid) = pid.trim().parse::<u32>() {
                procs.push(ProcInfo {
                    pid,
                    name: name.trim().to_string(),
                });
            }
        }
    }
    Ok(procs)
}

#[tauri::command]
fn start_log(
    app: AppHandle,
    state: State<AppState>,
    udid: Option<String>,
    network: bool,
) -> Result<(), String> {
    // Tear down any existing session first.
    stop_log(state.clone())?;

    let mut cmd = Command::new("idevicesyslog");
    cmd.arg("--no-colors");
    if let Some(u) = udid.as_ref().filter(|s| !s.is_empty()) {
        cmd.args(["-u", u]);
    }
    if network {
        cmd.arg("-n");
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("idevicesyslog 실행 실패: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout 파이프를 열 수 없습니다".to_string())?;

    // Surface idevicesyslog's own diagnostics (e.g. "No device found") to the UI.
    if let Some(stderr) = child.stderr.take() {
        let app_err = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if !line.is_empty() && line != "Exiting..." {
                    let _ = app_err.emit("log-error", line);
                }
            }
        });
    }

    *state.child.lock().unwrap() = Some(child);

    let seq = state.seq.clone();
    let (tx, rx) = mpsc::channel::<LogLine>();

    // Reader thread: parse each line and hand it to the batcher.
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let n = seq.fetch_add(1, Ordering::Relaxed);
                    if tx.send(parse_line(&l, n)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Batcher thread: coalesce lines into ~100ms / 500-line batches to keep
    // the UI responsive under high log volume (~2k lines/sec).
    let app2 = app.clone();
    thread::spawn(move || {
        let mut buf: Vec<LogLine> = Vec::with_capacity(512);
        let mut last = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(item) => {
                    buf.push(item);
                    while let Ok(x) = rx.try_recv() {
                        buf.push(x);
                        if buf.len() >= 1000 {
                            break;
                        }
                    }
                    if buf.len() >= 500 || last.elapsed() >= Duration::from_millis(100) {
                        let _ = app2.emit("log-batch", &buf);
                        buf.clear();
                        last = Instant::now();
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !buf.is_empty() {
                        let _ = app2.emit("log-batch", &buf);
                        buf.clear();
                    }
                    last = Instant::now();
                }
                Err(RecvTimeoutError::Disconnected) => {
                    if !buf.is_empty() {
                        let _ = app2.emit("log-batch", &buf);
                    }
                    let _ = app2.emit("log-stopped", ());
                    break;
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_log(state: State<AppState>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            child: Mutex::new(None),
            seq: Arc::new(AtomicU64::new(0)),
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            list_processes,
            start_log,
            stop_log
        ])
        .on_window_event(|window, event| {
            // Make sure the child process dies with the window.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if let Some(mut child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
