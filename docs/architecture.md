# 아키텍처 — 3 프로세스 구조 / 빌드 / 부팅 시퀀스 / 탭 구성

> Electron main·preload·renderer 3 프로세스가 어떻게 나뉘고, electron-vite 로 어떻게 빌드되며, 앱이 부팅해서 5개 탭을 그릴 때까지 무슨 일이 일어나는지 다룹니다.
> 상위 조망: [`../../docs/INFOhSorry.md`](../../docs/INFOhSorry.md) · 인덱스: [README.md](README.md)

---

## 1. 3 프로세스 구조

전형적인 Electron contextIsolation 구성입니다.

```
┌─────────────────────────── main (Node.js) ────────────────────────────┐
│ src/main/index.ts                                                      │
│   - ipcHandlers map (단일 객체)  ──ipcMain.handle 등록                  │
│   - BrowserWindow 생성 (frameless)                                      │
│   - RefluxManager 인스턴스 1개 (메모리 리딩 백엔드)                     │
│   - production 시 startHttpServer (LAN :3000 + best-effort :80          │
│                                    + ohsorry.local mDNS + QR)           │
│   reflux.ts / memory.ts / ereter.ts / zasa.ts / rating.ts /            │
│   spTier.ts / serviceStatus.ts / offsetsRemote.ts / tsv.ts /           │
│   updateCheck.ts / portableUpdate.ts / http-server.ts                  │
└────────────────────────────────────────────────────────────────────────┘
              ▲  contextBridge.exposeInMainWorld('infohsorry', api)
              │
┌──────────── preload (src/preload/index.ts) ────────────────────────────┐
│   window.infohsorry.* → ipcRenderer.invoke(channel, ...args)           │
└────────────────────────────────────────────────────────────────────────┘
              ▲  window.infohsorry.*
              │
┌──────────── renderer (React 18, src/renderer/src/) ────────────────────┐
│   main.tsx → <App/>                                                     │
│   App.tsx (탭 관리 + Supabase orchestration + 추천/별값 통합)           │
│   탭 컴포넌트 / useProfile / supabaseSync / recommendCore / api.ts      │
└────────────────────────────────────────────────────────────────────────┘
```

- **main**: Node 전권(파일 시스템, 자식 프로세스 spawn, koffi Win32 호출, Node `fetch`). 외부 HTTP fetch 는 대부분 main 에서 수행 — renderer 의 Chromium CORS 정책 우회 목적(`src/main/serviceStatus.ts:1` 주석 참고).
- **preload**: `sandbox: false`, `contextIsolation: true` (`src/main/index.ts:521-525`). `window.infohsorry` 라는 단일 객체로만 IPC 노출(`src/preload/index.ts:207`).
- **renderer**: 순수 React. main 의 기능은 전부 `window.infohsorry.*` 경유. gist/Supabase 같은 외부 호출 중 일부는 renderer 에서 직접 fetch(추천 코어 `recommendCore.ts`, Supabase `supabaseSync.ts`).

### preload 의 thin-wrapper 원칙

`src/preload/index.ts` 는 로직이 없습니다. 각 메서드는 `ipcRenderer.invoke('channel', ...args)` 한 줄(또는 `ipcRenderer.on` 구독 헬퍼)뿐입니다. 채널별 상세는 [ipc-reference.md](ipc-reference.md) 참고.

이벤트 구독형(콜백) API 두 가지:
- `reflux.onState(cb)` — `ipcRenderer.on('reflux:state', ...)` (`src/preload/index.ts:42-48`)
- `window.onMaximizedChange(cb)` — `ipcRenderer.on('window:maximized', ...)` (`src/preload/index.ts:197-203`)
- `portable.onProgress(cb)` — `ipcRenderer.on('portable:progress', ...)` (`src/preload/index.ts:95-99`)

---

## 2. electron-vite 빌드

설정: `electron.vite.config.ts`. electron-vite 가 main / preload / renderer 세 entry 를 각각 번들합니다.

- `main` / `preload`: `externalizeDepsPlugin()` 적용 — `koffi` 같은 네이티브/Node 의존성을 번들하지 않고 `require` 로 남김(`electron.vite.config.ts:12-17`).
- `renderer`:
  - `@vitejs/plugin-react`
  - alias `@renderer` → `src/renderer/src` (`electron.vite.config.ts:19-21`)
  - `define.__APP_VERSION__` = `package.json` 의 `version` 을 JSON 문자열로 주입(`electron.vite.config.ts:25-27`). renderer 의 `App.tsx:87-88` 이 `declare const __APP_VERSION__` 로 받아 Supabase 업로드 버전에 사용. (이전엔 하드코드라 버전 bump 시 옛 버전이 올라가던 버그를 이 define 으로 해소 — 주석 `electron.vite.config.ts:9-10`.)

`package.json` 스크립트(`package.json:8-17`):
- `dev` — `electron-vite dev` (Vite HMR, renderer 는 `ELECTRON_RENDERER_URL` 로 dev 서버 로드)
- `build` — `electron-vite build` → `out/{main,preload,renderer}`
- `typecheck` — `typecheck:node`(tsconfig.node.json) + `typecheck:web`(tsconfig.web.json) 분리
- `release` — `build` 후 `electron-builder --win --publish=never`

### 패키징 (`package.json:37-78`)

- `appId`: `com.yenkara.infohsorry`, `productName`: `ohSorryScoreINF`
- `asarUnpack: ["**/*.node"]` — koffi prebuilt `.node` 는 asar 밖으로(네이티브 로드 위해)
- win target: `nsis`(설치형) + `portable`(단일 exe), 둘 다 x64
- portable artifact 명: `ohSorryScoreINF-${version}-portable.exe`

---

## 3. main 진입점과 IPC 등록 (`src/main/index.ts`)

### 단일 핸들러 맵

모든 IPC 핸들러는 `ipcHandlers` 라는 하나의 `Record<string, (...args) => unknown>` 객체에 모입니다(`src/main/index.ts:38`). 시그니처는 `(...args) => Promise<any> | any` — `event` 파라미터는 없습니다.

이 객체를 두 군데에서 소비합니다:
1. **electron renderer 용**: 부팅 시 모든 채널을 `ipcMain.handle` 에 등록(`src/main/index.ts:499-501`). wrapper 가 `event` 를 떼고 `fn(...args)` 호출.
2. **LAN HTTP bridge 용**: `startHttpServer(refluxManager, rendererDir, ipcHandlers)` 에 같은 객체를 넘김(`src/main/index.ts:576`). `POST /api/ipc { channel, args }` 가 동일 핸들러를 호출 → PC2(브라우저)가 같은 IPC 를 씀.

> 핵심 설계: **IPC 핸들러는 정의가 한 곳뿐**이고, ipcMain 과 HTTP 가 같은 함수를 공유합니다. 채널 추가 시 `ipcHandlers` 에만 넣으면 LAN 원격에서도 자동 동작.

예외(별도 등록): `portable:download` / `portable:run` 은 `event.sender`(진행률 push 대상 WebContents)가 필요해 `ipcMain.handle` 로 직접 등록(`src/main/index.ts:504-509`).

---

## 4. 앱 부팅 시퀀스

### main 측 (`app.whenReady().then(...)`, `src/main/index.ts:563-597`)

1. `Menu.setApplicationMenu(null)` — 메뉴 제거.
2. `createWindow()`:
   - `BrowserWindow` 1280×800, `minWidth:520`, `frame:false`(frameless — 커스텀 헤더 close/min/max), `roundedCorners:false` (`src/main/index.ts:511-526`).
   - dev: `ELECTRON_RENDERER_URL` 로 loadURL + devtools detach. prod: `loadFile(out/renderer/index.html)` (`src/main/index.ts:537-542`).
   - `Ctrl+Shift+I` 로 devtools 토글(`before-input-event`, `src/main/index.ts:548-554`). F12 는 INFINITAS 충돌 우려로 미등록.
   - `mainWindow.on('maximize'/'unmaximize')` → renderer 에 `window:maximized` push(`src/main/index.ts:529-535`).
   - `refluxManager.on('state', ...)` → renderer 에 `reflux:state` push(`src/main/index.ts:556-560`).
3. `cleanupOldPortables()` — 자기 실행 파일이 portable 패턴이면 같은 폴더의 옛 portable 정리(`src/main/index.ts:568`).
4. **production 빌드에서만** `startHttpServer(...)`(`src/main/index.ts:573-580`). dev 는 Vite 가 서버를 띄우므로 skip(`ELECTRON_RENDERER_URL` 존재로 판정).
5. ereter 캐시가 stale 이면 백그라운드 자동 갱신(`src/main/index.ts:586-596`).

또한 `startInfinitasWatch()`(`src/main/index.ts:659`)로 bm2dx.exe tasklist 30초 폴링을 시작 — INFINITAS 종료 감지 시 마지막 업로드(아래).

종료 처리(모두 "마지막 업로드 1회" 를 거침, [data-flow.md](data-flow.md) 3절):
- 창 닫기(X) → `mainWindow.on('close')` 가 `e.preventDefault()` 로 파괴를 미루고 `requestFinalUpload()`(렌더러 생존 시점) 후 `destroy()` (`src/main/index.ts:612-628`).
- `window-all-closed` → darwin 외 `app.quit()` (`src/main/index.ts:695-697`).
- `before-quit` → `e.preventDefault()` 후 `requestFinalUpload()`(렌더러 살아있으면) + Reflux 떠 있으면 `refluxManager.stop()`(자식 프로세스 정리) 하고 `app.exit(0)` (`src/main/index.ts:700-722`).
- INFINITAS(bm2dx.exe) 종료 감지 시 → `requestFinalUpload()`(앱은 유지, `src/main/index.ts:570-582`).

### renderer 측 (`App.tsx` mount effect 들)

`App` 컴포넌트가 마운트되며 여러 `useEffect` 가 병렬로 데이터를 끌어옵니다:

| effect | 동작 | 위치 |
|--------|------|------|
| Reflux 구독+자동시작 | `reflux.onState` 구독, `getTsvPath`/`getState`, 미spawn 이면 `reflux.start()` 자동 호출. spawn `false→true` transit 시 `readTsv` 1회 | `App.tsx:208-240` |
| ereter | `ereter.status()` → stale 면 `refreshEreter`, 아니면 `ereter.get(false)` | `App.tsx:243-254` |
| zasa | `zasa.get(false)` | `App.tsx:257-266` |
| rating | `rating.get(false)` | `App.tsx:269-278` |
| spTier | `spTier.get(false)` | `App.tsx:281-290` |
| serviceStatus | `serviceStatus.get()` → `notInINF` 세팅 | `App.tsx:294-303` |
| update check | 마운트 5초 후 1회 + 이후 10분마다 `update.check()`. 배너 띄우면 폴링 중단 | `App.tsx:307-336` |
| 별값 lib | gist `onlyOSR`/`OSR135`/`OhsorryNorm`/`onlyOSRtoEreter` 로드 | `App.tsx:724-746` |
| recommend lib | `loadRecLibs()` | `App.tsx:981-992` |
| INF 차트 판정기 | `getInfChartChecker()` (Supabase songs) | `App.tsx:996-1007` |
| tsv 실시간 reload | `refluxState.lastTsvMtime` 변경 감지 → debounce 400ms → `loadTsv` (host 전용) | `App.tsx` |
| Supabase 업로드 스케줄 | INF/데이터 감지 후 3분 뒤 첫 업로드 → 이후 15분 주기 (읽기 없음, host 전용) | `App.tsx:1025-1126` |
| 마지막 업로드 수신 | `upload.onFinalRequest` — 앱/INFINITAS 종료 시 main 요청 받아 1회 업로드 후 `finalDone` ack | `App.tsx:1082-1088` |

> tsv 읽기 정책: 마운트 즉시 readTsv 하지 않습니다. Reflux spawn 완료 시점에 1회 + 이후 **`tracker.tsv` 변경마다 실시간 reload**(debounce 400ms). 부팅 직후 잠깐 빈 화면 → spawn(10~30초) 후 채워짐. Supabase 업로드는 별도 스케줄(감지 후 3분 → 15분 주기 + 종료 시 1회, v0.0.100). 데이터 흐름 상세는 [data-flow.md](data-flow.md).

---

## 5. 5개 탭 구성

탭 타입은 `type Tab = 'sp' | 'dp' | 'dp12' | 'analysis' | 'recent' | 'playdata' | 'grid'`(`App.tsx:96`). 기본 탭은 `playdata`(`App.tsx:122`).

**사용자에게 보이는 탭은 5개**(헤더 버튼, `App.tsx:1508-1535`):

| 화면 라벨 | `tab` 값 | 컴포넌트 | 역할 |
|-----------|----------|----------|------|
| RECENT | `recent` | `Recent.tsx` | TSV 현재값 vs Supabase 마지막 업로드 diff + 과거 날짜 기록. DP/DBR 토글 |
| PLAYDATA | `playdata` | `PlayData.tsx` | 시리즈 폴더 아코디언 + 검색 네비게이터 + 곡 단위 표. (SP/DP 토글 로직은 보존되나 UI 숨김) |
| RECOMMEND | `dp12` | `RecommendByCore.tsx` + App 의 RecCard | EC/HC/EXH 클리어 추천 + 연습곡 + DP12 서열표(`DpTable`) |
| GRID | `grid` | `DpTable.tsx` | DP12/DP11/SP12 서열표(별값/tier 격자) + 캡처 |
| ANALYSIS | `analysis` | `Analysis.tsx` | 패턴 벡터 약점 분석 + percentile + 기여곡 + Supabase `user_ohsorry_radars` upsert |

**숨김 탭**: `dp` / `sp` 버튼은 `display:none` 등으로 숨겨져 있으나 `setTab('dp')`/`setTab('sp')` dispatch 분기는 유지됩니다(`App.tsx:1537-1551` 주석). 다른 컴포넌트가 곡 클릭 시 점프 타깃으로 호출할 수 있도록 `ChartTable` 렌더 경로가 살아있습니다.

탭 본문은 `tab` 값에 따른 조건부 렌더링(`App.tsx:1569` 이하). 탭 간 점프(서열표 곡 클릭 → PLAYDATA, 추천곡 클릭 → DP row 스크롤 등)는 `scrollTarget`/`playDataTarget` state 로 전달됩니다(`App.tsx:124-126`).

### 컴포넌트별 외부 의존 요약

| 컴포넌트 | 주요 외부 호출 |
|----------|----------------|
| `PlayData` | `getSongsById`/`ensureTextageMeta`(Supabase) + `fetchSeriesNames`(gist) + `saveImage`(IPC) |
| `Analysis` | gist `calcWeakness.js`/`analysisRender.js` + Supabase `user_ohsorry_radars` fetch + `upsert_user_feature_score` RPC |
| `Recent` | Supabase RPC `make_recent_dates`/`make_recent_data`/`make_grid_data` + gist DBR map |
| `DpTable` | `spTierData`/`ratingData` props + `html2canvas` → `saveImage`(IPC) |
| `RecommendByCore` | `recommendCore.ts`(gist `recommend.js`/`calcWeakness.js` 등) |
| `MemoryScanner` | `window.infohsorry.memory.*` IPC 5종 + `localStorage` |
| `ProfileCard`/`NotesRadar` | `useProfile`(메모리) + Supabase `user_radars`/`users` |

상세는 [data-flow.md](data-flow.md) 와 [memory-reading.md](memory-reading.md).

---

## 6. LAN 연결 — `ohsorry.local` + 앱 내 QR (v0.0.101)

폰/다른 PC 를 같은 네트워크의 INF 서버로 붙일 때 IP·포트를 외우지 않게 한 편의 기능입니다. 서버 자체(RPC bridge/SSE/오소리웹 서빙)는 [data-flow.md](data-flow.md) 5절, 통신은 동일.

### 포트 80 best-effort + mDNS

`startHttpServer`(`src/main/http-server.ts:251-430`)는 기본 `:3000`(`0.0.0.0`) listen 외에:
- **`:80` 도 별도 `http.createServer` 로 바인드 시도**(`src/main/http-server.ts:377-381`). 성공하면 포트 없이 `http://ohsorry.local` / `http://<IP>` 접속 가능. 이미 80 사용 중(EADDRINUSE 등)이면 `error` 핸들러가 경고만 찍고 무시 → `:3000` 으로 fallback. 둘 다 같은 `requestListener` 공유.
- **`ohsorry.local` mDNS 광고**(`multicast-dns`, `src/main/http-server.ts:383-400`) — A 쿼리에 대표 LAN IP 로 응답. `stop()` 이 mDNS·양 서버 정리.

### 앱 내 QR — main 에서 생성

헤더 **📱 버튼**(호스트 전용) → `QrConnect` 모달(`src/renderer/src/QrConnect.tsx`). 모달은 `window.infohsorry.server.info()`(IPC `server:info`)로 `ConnectInfo` 를 받아 QR + 주소(`url`)/이름(`nameUrl`) 표시. http-server 미시작(dev)이면 `null` → "LAN 서버 실행 중 아님" 안내.

- **QR 은 main(node) 에서 `qrcode` 로 생성**해 data URL 로 전달(`connectInfo()`, `src/main/http-server.ts:404-423`, url 별 캐시). 렌더러에서 `qrcode` 를 직접 import 하지 않는 이유: `@types/qrcode` 가 web 컴파일에 node 타입(`setTimeout` 등)을 끌어와 타이머 타입이 깨짐 → main 전용으로 격리.
- QR 내용은 **IP 기반 URL**(가장 확실). `ohsorry.local` 은 타이핑/병기용(mDNS 미동작 환경 대비).
- deps: `multicast-dns`, `qrcode` — 둘 다 main 전용(`externalizeDepsPlugin` 으로 번들 제외, 2절).
