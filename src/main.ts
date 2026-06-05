import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

interface LogLine {
  seq: number;
  ts: string;
  process: string;
  subsystem: string;
  pid: number;
  level: string;
  message: string;
  raw: string;
}

interface DeviceInfo {
  udid: string;
  name: string;
  network: boolean;
}

interface ProcInfo {
  pid: number;
  name: string;
}

type Cat = "error" | "warn" | "notice" | "info" | "debug" | "default";

const ROW_H = 22;
const OVERSCAN = 8;
const MAX_LOGS = 100_000;
const TRIM_CHUNK = 20_000;

// ---------------------------------------------------------------- state
const allLogs: LogLine[] = [];
let filtered: LogLine[] = [];

const enabledCats = new Set<Cat>([
  "error",
  "warn",
  "notice",
  "info",
  "debug",
  "default",
]);
let textQuery = "";
let textRegex: RegExp | null = null;
let useRegex = false;
let caseSensitive = false;
let procQuery = "";

// Source preset: which kind of lines to keep. Defaults to Unity + native crash.
type Preset = "all" | "unity-native" | "crash" | "unity";
let preset: Preset = "unity-native";
let appName = ""; // the Unity app's process name, e.g. "MapleIdleRPG"

// Heuristics for classifying a log line by source.
const UNITY_RE = /unity|il2cpp|\bmono\b|UnityFramework|UnityAds|burst|\bgame\b/i;
const CRASH_PROCS =
  /^(ReportCrash|osanalyticshelper|SpringBoard|kernel|watchdogd|dasd|runningboardd|symptomsd|CrashReporter)/i;
const CRASH_RE =
  /crash|exception|signal|abort|EXC_|backtrace|fatal|terminat|jetsam|SIGSEGV|SIGABRT|SIGBUS|killed|watchdog/i;

function appMatch(l: LogLine): boolean {
  if (!appName) return false;
  const a = appName.toLowerCase();
  return l.process.toLowerCase().includes(a) || l.raw.toLowerCase().includes(a);
}

function isUnity(l: LogLine): boolean {
  if (appMatch(l)) return true;
  return UNITY_RE.test(l.process) || UNITY_RE.test(l.subsystem) || UNITY_RE.test(l.message);
}

function isCrash(l: LogLine): boolean {
  const cat = levelToCat(l.level);
  if ((cat === "error" || cat === "default") && CRASH_RE.test(l.message)) return true;
  if (CRASH_PROCS.test(l.process) && (CRASH_RE.test(l.message) || appMatch(l))) return true;
  return false;
}

function passesPreset(l: LogLine): boolean {
  switch (preset) {
    case "all":
      return true;
    case "unity":
      return isUnity(l);
    case "crash":
      return isCrash(l);
    case "unity-native":
      return isUnity(l) || isCrash(l);
  }
}

let running = false;
let follow = true; // auto-scroll to bottom
let dirty = false;

// ---------------------------------------------------------------- helpers
function levelToCat(level: string): Cat {
  switch (level.toLowerCase()) {
    case "error":
    case "fault":
      return "error";
    case "warning":
    case "warn":
      return "warn";
    case "notice":
      return "notice";
    case "info":
      return "info";
    case "debug":
      return "debug";
    default:
      return "default";
  }
}

function fmtTime(ts: string): string {
  // "Jun  5 14:35:14.309072" -> "14:35:14.309"
  const m = ts.match(/(\d{2}:\d{2}:\d{2})(\.\d+)?/);
  if (!m) return ts;
  const frac = m[2] ? m[2].slice(0, 4) : "";
  return m[1] + frac;
}

function matches(l: LogLine): boolean {
  if (!passesPreset(l)) return false;
  if (!enabledCats.has(levelToCat(l.level))) return false;

  if (procQuery) {
    const p = caseSensitive ? l.process : l.process.toLowerCase();
    if (!p.includes(caseSensitive ? procQuery : procQuery.toLowerCase()))
      return false;
  }

  if (textQuery) {
    const hay = l.process + " " + l.message;
    if (useRegex) {
      if (textRegex && !textRegex.test(hay)) return false;
    } else {
      const h = caseSensitive ? hay : hay.toLowerCase();
      const q = caseSensitive ? textQuery : textQuery.toLowerCase();
      if (!h.includes(q)) return false;
    }
  }
  return true;
}

function rebuildFilter() {
  if (useRegex && textQuery) {
    try {
      textRegex = new RegExp(textQuery, caseSensitive ? "" : "i");
      filterInput.classList.remove("bad");
    } catch {
      textRegex = null;
      filterInput.classList.add("bad");
    }
  } else {
    textRegex = null;
  }
  filtered = allLogs.filter(matches);
  dirty = true;
  scheduleRender();
}

function ingest(batch: LogLine[]) {
  for (const l of batch) {
    allLogs.push(l);
    if (matches(l)) filtered.push(l);
  }

  if (allLogs.length > MAX_LOGS) {
    allLogs.splice(0, TRIM_CHUNK);
    const minSeq = allLogs.length ? allLogs[0].seq : Infinity;
    let drop = 0;
    while (drop < filtered.length && filtered[drop].seq < minSeq) drop++;
    if (drop) filtered.splice(0, drop);
  }

  dirty = true;
  scheduleRender();
}

// ---------------------------------------------------------------- DOM build
const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="toolbar">
    <span><span class="status-dot" id="dot"></span><b id="state-label">정지됨</b></span>
    <select id="device"></select>
    <button id="refresh" title="기기 목록 새로고침">↻</button>
    <button id="toggle" class="primary">시작</button>
    <div class="spacer"></div>
    <button id="clear">지우기</button>
    <button id="follow" class="toggle on" title="새 로그를 자동으로 따라갑니다">↓ 따라가기</button>
  </div>

  <div class="filterbar">
    <select id="preset" title="보기 프리셋">
      <option value="unity-native">🎮 Unity + 네이티브 크래시</option>
      <option value="unity">🎮 Unity 로그만</option>
      <option value="crash">💥 네이티브 크래시만</option>
      <option value="all">🌐 전체 로그</option>
    </select>
    <input type="text" id="app" class="filter-input" style="flex:0 0 170px"
           placeholder="앱 프로세스명 (예: MapleIdleRPG)" />
    <div class="proc-wrap">
      <button id="proc-btn" title="실행 중인 프로세스 목록">프로세스 ▾</button>
      <div class="proc-panel" id="proc-panel">
        <input type="text" id="proc-search" class="proc-search"
               placeholder="프로세스 검색…" />
        <div class="proc-list" id="proc-list"></div>
      </div>
    </div>
  </div>

  <div class="filterbar">
    <div class="chips" id="chips">
      <span class="chip error on"   data-cat="error">ERROR</span>
      <span class="chip warn on"    data-cat="warn">WARN</span>
      <span class="chip notice on"  data-cat="notice">NOTICE</span>
      <span class="chip info on"    data-cat="info">INFO</span>
      <span class="chip debug on"   data-cat="debug">DEBUG</span>
      <span class="chip default on" data-cat="default">기타</span>
    </div>
    <input type="text" id="proc" class="filter-input" style="flex:0 0 200px"
           placeholder="프로세스 필터 (예: SpringBoard)" />
    <input type="text" id="filter" class="filter-input"
           placeholder="메시지/프로세스 검색…" />
    <button id="regex" class="toggle" title="정규식 사용">.*</button>
    <button id="case" class="toggle" title="대소문자 구분">Aa</button>
  </div>

  <div class="log-head">
    <span class="col c-time">TIME</span>
    <span class="col c-pid">PID</span>
    <span class="col c-proc">PROCESS</span>
    <span class="col c-level">LEVEL</span>
    <span class="col c-msg">MESSAGE</span>
  </div>

  <div class="viewport" id="viewport">
    <div class="sizer" id="sizer">
      <div class="rows" id="rows"></div>
    </div>
    <div class="empty" id="empty">
      <div>로그가 없습니다</div>
      <div class="hint">기기를 선택하고 “시작”을 누르세요</div>
    </div>
  </div>

  <div class="statusbar">
    <span>총 <b id="cnt-all">0</b></span>
    <span>표시 <b id="cnt-shown">0</b></span>
    <span id="err-box" class="err"></span>
    <div class="spacer" style="flex:1"></div>
    <span id="dev-label"></span>
  </div>
`;

const deviceSel = document.getElementById("device") as HTMLSelectElement;
const refreshBtn = document.getElementById("refresh") as HTMLButtonElement;
const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const followBtn = document.getElementById("follow") as HTMLButtonElement;
const filterInput = document.getElementById("filter") as HTMLInputElement;
const procInput = document.getElementById("proc") as HTMLInputElement;
const presetSel = document.getElementById("preset") as HTMLSelectElement;
const appInput = document.getElementById("app") as HTMLInputElement;
const procBtn = document.getElementById("proc-btn") as HTMLButtonElement;
const procPanel = document.getElementById("proc-panel") as HTMLDivElement;
const procSearch = document.getElementById("proc-search") as HTMLInputElement;
const procList = document.getElementById("proc-list") as HTMLDivElement;
const regexBtn = document.getElementById("regex") as HTMLButtonElement;
const caseBtn = document.getElementById("case") as HTMLButtonElement;
const viewport = document.getElementById("viewport") as HTMLDivElement;
const sizer = document.getElementById("sizer") as HTMLDivElement;
const rowsEl = document.getElementById("rows") as HTMLDivElement;
const emptyEl = document.getElementById("empty") as HTMLDivElement;
const dot = document.getElementById("dot") as HTMLSpanElement;
const stateLabel = document.getElementById("state-label") as HTMLElement;
const cntAll = document.getElementById("cnt-all") as HTMLElement;
const cntShown = document.getElementById("cnt-shown") as HTMLElement;
const errBox = document.getElementById("err-box") as HTMLElement;
const devLabel = document.getElementById("dev-label") as HTMLElement;

// ---------------------------------------------------------------- rendering
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlight(msg: string): string {
  const safe = esc(msg);
  if (!textQuery) return safe;
  try {
    const re = useRegex
      ? new RegExp(`(${textQuery})`, caseSensitive ? "g" : "gi")
      : new RegExp(
          `(${textQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
          caseSensitive ? "g" : "gi"
        );
    return safe.replace(re, '<span class="highlight">$1</span>');
  } catch {
    return safe;
  }
}

function render() {
  dirty = false;
  const total = filtered.length;
  sizer.style.height = total * ROW_H + "px";
  emptyEl.style.display = allLogs.length === 0 ? "flex" : "none";

  cntAll.textContent = allLogs.length.toLocaleString();
  cntShown.textContent = total.toLocaleString();

  if (follow && total > 0) {
    viewport.scrollTop = total * ROW_H;
  }

  const scrollTop = viewport.scrollTop;
  const viewH = viewport.clientHeight;
  let start = Math.floor(scrollTop / ROW_H) - OVERSCAN;
  if (start < 0) start = 0;
  let end = Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN;
  if (end > total) end = total;

  rowsEl.style.transform = `translateY(${start * ROW_H}px)`;

  let html = "";
  for (let i = start; i < end; i++) {
    const l = filtered[i];
    const cat = levelToCat(l.level);
    const proc =
      l.subsystem && l.subsystem.length
        ? `${l.process}(${l.subsystem})`
        : l.process;
    html +=
      `<div class="row level-${cat}" title="${esc(l.raw)}">` +
      `<span class="col c-time">${esc(fmtTime(l.ts))}</span>` +
      `<span class="col c-pid">${l.pid || ""}</span>` +
      `<span class="col c-proc">${esc(proc)}</span>` +
      `<span class="col c-level lv lv-${cat}">${esc(l.level)}</span>` +
      `<span class="col c-msg">${highlight(l.message)}</span>` +
      `</div>`;
  }
  rowsEl.innerHTML = html;
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (dirty || follow) render();
  });
}
let renderQueued = false;

// ---------------------------------------------------------------- events: UI
viewport.addEventListener("scroll", () => {
  // Disable follow the moment the user scrolls away from the bottom.
  const atBottom =
    viewport.scrollTop + viewport.clientHeight >=
    sizer.offsetHeight - ROW_H * 2;
  if (follow !== atBottom) {
    follow = atBottom;
    followBtn.classList.toggle("on", follow);
  }
  scheduleRender();
});

followBtn.addEventListener("click", () => {
  follow = !follow;
  followBtn.classList.toggle("on", follow);
  if (follow) {
    viewport.scrollTop = filtered.length * ROW_H;
    scheduleRender();
  }
});

clearBtn.addEventListener("click", () => {
  allLogs.length = 0;
  filtered = [];
  dirty = true;
  render();
});

document.getElementById("chips")!.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!t.classList.contains("chip")) return;
  const cat = t.dataset.cat as Cat;
  if (enabledCats.has(cat)) enabledCats.delete(cat);
  else enabledCats.add(cat);
  t.classList.toggle("on", enabledCats.has(cat));
  rebuildFilter();
});

let debounce: number | undefined;
function onFilterChange() {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => {
    textQuery = filterInput.value.trim();
    procQuery = procInput.value.trim();
    rebuildFilter();
  }, 120);
}
filterInput.addEventListener("input", onFilterChange);
procInput.addEventListener("input", onFilterChange);

presetSel.addEventListener("change", () => {
  preset = presetSel.value as Preset;
  rebuildFilter();
});

let appDebounce: number | undefined;
appInput.addEventListener("input", () => {
  window.clearTimeout(appDebounce);
  appDebounce = window.setTimeout(() => {
    appName = appInput.value.trim();
    rebuildFilter();
  }, 150);
});

// ----- Process picker (pidlist) -----
let procCache: ProcInfo[] = [];

// App-like processes (capitalized, not a daemon) bubble to the top.
function isAppLike(name: string): boolean {
  return /^[A-Z]/.test(name) && !/d$/.test(name);
}

function renderProcList() {
  const q = procSearch.value.trim().toLowerCase();
  const items = procCache
    .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.pid).includes(q))
    .sort((a, b) => {
      const aa = isAppLike(a.name) ? 0 : 1;
      const bb = isAppLike(b.name) ? 0 : 1;
      if (aa !== bb) return aa - bb;
      return a.name.localeCompare(b.name);
    });

  if (items.length === 0) {
    procList.innerHTML = `<div class="proc-empty">결과 없음</div>`;
    return;
  }
  procList.innerHTML = items
    .map(
      (p) =>
        `<div class="proc-item ${isAppLike(p.name) ? "app" : ""}" data-name="${esc(
          p.name
        )}"><span class="pid">${p.pid}</span><span class="pname">${esc(
          p.name
        )}</span></div>`
    )
    .join("");
}

async function openProcPanel() {
  procPanel.classList.add("open");
  procSearch.value = "";
  procList.innerHTML = `<div class="proc-empty">불러오는 중…</div>`;
  procSearch.focus();
  try {
    const dev = selectedDevice();
    procCache = await invoke<ProcInfo[]>("list_processes", {
      udid: deviceSel.value || null,
      network: dev?.network ?? false,
    });
    renderProcList();
  } catch (e) {
    procList.innerHTML = `<div class="proc-empty">${esc(String(e))}</div>`;
  }
}

procBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (procPanel.classList.contains("open")) procPanel.classList.remove("open");
  else openProcPanel();
});

procSearch.addEventListener("input", renderProcList);

procList.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest(".proc-item") as HTMLElement | null;
  if (!item) return;
  const name = item.dataset.name!;
  appInput.value = name;
  appName = name;
  procPanel.classList.remove("open");
  rebuildFilter();
});

// Close the panel when clicking elsewhere.
document.addEventListener("click", (e) => {
  if (
    procPanel.classList.contains("open") &&
    !procPanel.contains(e.target as Node) &&
    e.target !== procBtn
  ) {
    procPanel.classList.remove("open");
  }
});

regexBtn.addEventListener("click", () => {
  useRegex = !useRegex;
  regexBtn.classList.toggle("on", useRegex);
  rebuildFilter();
});
caseBtn.addEventListener("click", () => {
  caseSensitive = !caseSensitive;
  caseBtn.classList.toggle("on", caseSensitive);
  rebuildFilter();
});

// Double-click a row to copy its raw line.
rowsEl.addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest(".row") as HTMLElement | null;
  if (row && row.title) navigator.clipboard?.writeText(row.title);
});

window.addEventListener("resize", scheduleRender);

// ---------------------------------------------------------------- backend wiring
function setRunning(on: boolean) {
  running = on;
  dot.classList.toggle("live", on);
  stateLabel.textContent = on ? "수집 중" : "정지됨";
  toggleBtn.textContent = on ? "중지" : "시작";
  toggleBtn.classList.toggle("primary", !on);
  toggleBtn.classList.toggle("danger", on);
  deviceSel.disabled = on;
}

let devices: DeviceInfo[] = [];

function selectedDevice(): DeviceInfo | undefined {
  return devices.find((d) => d.udid === deviceSel.value);
}

async function loadDevices() {
  errBox.textContent = "";
  try {
    devices = await invoke<DeviceInfo[]>("list_devices");
    deviceSel.innerHTML = "";
    if (devices.length === 0) {
      deviceSel.innerHTML = `<option value="">기기 없음 — USB 연결 후 새로고침</option>`;
      devLabel.textContent = "";
      return;
    }
    for (const d of devices) {
      const opt = document.createElement("option");
      opt.value = d.udid;
      const icon = d.network ? "📶" : "🔌";
      opt.textContent = `${icon} ${d.name}  (${d.udid.slice(0, 8)}…)`;
      deviceSel.appendChild(opt);
    }
    const usb = devices.filter((d) => !d.network).length;
    const net = devices.length - usb;
    devLabel.textContent = `USB ${usb} · WiFi ${net}`;
  } catch (e) {
    errBox.textContent = String(e);
  }
}

let watchdog: number | undefined;

async function start() {
  errBox.textContent = "";
  try {
    const before = allLogs.length;
    const dev = selectedDevice();
    await invoke("start_log", {
      udid: deviceSel.value || null,
      network: dev?.network ?? false,
    });
    setRunning(true);

    // If nothing arrives within a few seconds, surface the likely cause.
    window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      if (running && allLogs.length === before) {
        errBox.textContent = dev?.network
          ? "데이터 없음 — WiFi 기기 잠금 해제 / 같은 네트워크 / 'Wi-Fi 연결' 활성화 확인."
          : "데이터 없음 — 기기 잠금 해제 / '이 컴퓨터를 신뢰' 확인 후 재시도.";
      }
    }, 4000);
  } catch (e) {
    errBox.textContent = String(e);
  }
}

async function stop() {
  window.clearTimeout(watchdog);
  try {
    await invoke("stop_log");
  } catch (e) {
    errBox.textContent = String(e);
  }
  setRunning(false);
}

toggleBtn.addEventListener("click", () => (running ? stop() : start()));
refreshBtn.addEventListener("click", loadDevices);

listen<LogLine[]>("log-batch", (e) => {
  if (errBox.textContent) errBox.textContent = "";
  window.clearTimeout(watchdog);
  ingest(e.payload);
});
listen<string>("log-error", (e) => {
  errBox.textContent = e.payload;
});
listen("log-stopped", () => setRunning(false));

// ---------------------------------------------------------------- init
loadDevices();
render();
