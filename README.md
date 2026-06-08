# iOS LogCat

> 연결된 iOS 기기의 시스템 로그를 **실시간으로** 보여주는 Android Logcat 스타일 데스크톱 앱.
> `idevicesyslog`(libimobiledevice)를 감싸 만든 Tauri 앱으로, **Unity로 만든 iOS 게임/앱의 네이티브 크래시 추적**에 특히 유용합니다.

[![release](https://github.com/achieveonepark/ios-logcat/actions/workflows/release.yml/badge.svg)](https://github.com/achieveonepark/ios-logcat/actions/workflows/release.yml)
[![latest release](https://img.shields.io/github/v/release/achieveonepark/ios-logcat)](https://github.com/achieveonepark/ios-logcat/releases/latest)

---

## ✨ 기능

- 🔌📶 **기기 자동 인식** — USB / WiFi 기기를 목록에 표시(아이콘 구분), 선택 시 알맞은 모드로 자동 연결
- ⚡ **실시간 수집** — 초당 수천 줄도 100ms 배치 + 가상 스크롤로 끊김 없이
- 🎮 **보기 프리셋** — `Unity + 네이티브 크래시` / `Unity만` / `크래시만` / `전체`
- 🏷️ **레벨 필터** — ERROR / WARN / NOTICE / INFO / DEBUG / 기타 토글, 색상 구분
- 🔍 **검색** — 메시지·프로세스 텍스트, 정규식·대소문자 토글, 매칭 하이라이트
- 🧭 **프로세스 피커** — 실행 중인 프로세스(pidlist) 목록에서 클릭 → 자동 필터
- 🧩 **의존성 안내** — 실행 시 `libimobiledevice` CLI 누락 여부를 확인하고 설치 안내 팝업 표시
- 📋 행 더블클릭으로 원본 로그 복사, 자동 따라가기(tail)

---

## 📥 설치

### 1. 앱 다운로드

[**Releases**](https://github.com/achieveonepark/ios-logcat/releases/latest)에서 OS에 맞는 설치파일을 받으세요.

| OS | 파일 |
|----|------|
| macOS (Apple Silicon + Intel) | `iOS LogCat_x.y.z_universal.dmg` |
| Windows | `iOS LogCat_x.y.z_x64-setup.exe` / `.msi` |

> 코드 서명이 안 돼 있어 첫 실행 시 경고가 뜰 수 있습니다.
> **macOS**: 앱 우클릭 → *열기* · **Windows**: *추가 정보 → 실행*.

### 2. libimobiledevice 설치 (필수)

이 앱은 `idevicesyslog` / `idevice_id` / `ideviceinfo` CLI를 호출합니다. PATH에 있어야 합니다.

**macOS**
```bash
brew install libimobiledevice
```

**Windows**
- [libimobiledevice-win32](https://github.com/libimobiledevice-win32/imobiledevice-net/releases) 바이너리를 받아 PATH에 추가
- USB 인식을 위해 **Apple Mobile Device Support**(iTunes 또는 Apple Devices 앱) 설치

### 3. 기기 신뢰

iPhone을 USB로 연결하고 **"이 컴퓨터를 신뢰"** 를 누릅니다. (한 번만)

---

## 🚀 사용법

1. 기기를 연결하고 앱에서 선택 (`↻`로 새로고침)
2. **시작** → 로그가 실시간으로 흐름
3. 프리셋·레벨·검색으로 원하는 로그만 필터링

### WiFi(무선)로 연결하기

같은 WiFi에 있는 것만으로는 안 됩니다. 한 번 등록이 필요해요:

1. iPhone을 USB로 연결
2. **Finder** → 사이드바에서 기기 → `일반` 탭 → **"Wi-Fi에 연결되어 있을 때 이 iPhone 보기"** 체크 → 적용
   (또는 Xcode → *Devices and Simulators* → *Connect via network*)
3. 이제 USB 없이 같은 네트워크에서 📶 로 잡힙니다

---

## 🎮 Unity 앱/게임 디버깅 노트

| 빌드 종류 | `Debug.Log` 가 syslog에 보이나? |
|----------|-------------------------------|
| **Development Build** | ✅ 보임 (프로세스 = 앱 이름으로 표시) |
| **Release / 라이브 빌드** | ❌ 안 보임 — Unity가 NSLog로 안 내보냄 |

- **Unity 로그를 보려면**: Build Settings에서 **Development Build** 체크 후 빌드 → 프로세스 피커에서 앱 선택
- **라이브 빌드에서도 네이티브 크래시는 보입니다** — 앱이 죽으면 `ReportCrash`/`osanalyticshelper`/`SpringBoard`/`kernel`이 로그를 남깁니다.
  기본 프리셋 **`Unity + 네이티브 크래시`** + 앱 프로세스명 입력으로 추적하세요.
- 라이브 빌드의 Unity 로그가 꼭 필요하면 **Firebase Crashlytics** 또는 인앱 콘솔([IngameDebugConsole](https://github.com/yasirkula/UnityIngameDebugConsole))을 권장합니다.

### `<private>` 마스킹 해제

iOS 통합 로깅은 민감 값을 `<private>`로 가립니다. 실제 값을 보려면 [`profiles/enable-private-logging.mobileconfig`](profiles/enable-private-logging.mobileconfig)를 기기에 설치하세요:

1. 파일을 기기로 전송(에어드롭/메일)
2. 설정 → 일반 → VPN 및 기기 관리 → 프로파일 설치
3. ⚠️ 디버깅 후 **반드시 삭제** (민감정보 전역 노출)

완전한 심볼화 크래시 스택은 `.ips` 리포트 + dSYM 조합이 필요합니다:
```bash
idevicecrashreport -e ./crashlogs
```

---

## 🛠 소스에서 빌드

사전: [Node 20+](https://nodejs.org), [Rust](https://rustup.rs), [Tauri 사전요구사항](https://tauri.app/start/prerequisites/)

```bash
npm install
npm run tauri dev      # 개발 실행
npm run tauri build    # 설치파일 빌드 → src-tauri/target/release/bundle/
```

---

## 🧱 구조

| 경로 | 역할 |
|------|------|
| `src-tauri/src/lib.rs` | `idevicesyslog` 구동, 라인 파싱, 100ms 배치 이벤트, 기기/프로세스 목록 |
| `src/main.ts` | 가상 스크롤 로그 뷰어 + 필터/프리셋/프로세스 피커 |
| `src/styles.css` | 다크 테마 |
| `.github/workflows/release.yml` | 태그 푸시 시 macOS·Windows 설치파일 빌드·릴리스 |

---

## License

MIT
