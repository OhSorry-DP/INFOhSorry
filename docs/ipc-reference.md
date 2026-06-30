# IPC 레퍼런스 — main↔renderer 채널 전수 목록

> main 의 `ipcHandlers` 채널과 각 핸들러의 역할/시그니처, preload `window.infohsorry` API 매핑, HTTP `/api/ipc` bridge 를 정리합니다.
> 상위 조망: [`../../docs/INFOhSorry.md`](../../docs/INFOhSorry.md) · 인덱스: [README.md](README.md)

---

## 0. IPC 구조 요약

- **핸들러 정의**: `src/main/index.ts` 의 `ipcHandlers` 단일 객체(`src/main/index.ts:38`). 시그니처 `(...args) => Promise<any> | any`(event 파라미터 없음).
- **renderer 등록**: 부팅 시 모든 채널을 `ipcMain.handle(channel, (_evt, ...args) => fn(...args))`(`src/main/index.ts:499-501`). 단, `portable:download`/`portable:run` 은 `event.sender` 필요로 별도 등록(`src/main/index.ts:504-509`).
- **preload 노출**: `src/preload/index.ts` 가 `contextBridge.exposeInMainWorld('infohsorry', api)`(`src/preload/index.ts:207`). 각 API 는 `ipcRenderer.invoke(channel, ...args)` 한 줄.
- **LAN bridge**: `POST /api/ipc {channel, args}` 가 같은 `ipcHandlers` 호출(`src/main/http-server.ts:104-116`). 브라우저 polyfill(`src/renderer/src/api.ts:134-242`)이 `window.infohsorry` 를 동일 형태로 재구성.
- **main→renderer push 채널**(invoke 아님, `webContents.send`): `reflux:state`, `window:maximized`, `portable:progress`, `upload:final-request`(종료 시 마지막 업로드 요청). SSE `/api/events` 가 `reflux:state`·`me:update` 를 PC2 에 전달.
- **renderer→main send 채널**(`ipcRenderer.send`, invoke 아님): `upload:final-done`(마지막 업로드 ack). main 이 `ipcMain.once` 로 수신.

> 채널 응답 컨벤션: 대부분 `{ ok: boolean, ... }` 또는 `{ ok: false, error }`. 일부(상태 조회/단순 값)는 raw 값 반환.

---

## 1. Reflux

| 채널 | 핸들러 역할 | preload API |
|------|-------------|-------------|
| `reflux:start` | `refluxManager.startAll()` — 설치/config/offsets/spawn 일괄. `{ok, state}` | `reflux.start()` |
| `reflux:stop` | `refluxManager.stop()` — taskkill + 감시 정리. `{ok}` | `reflux.stop()` |
| `reflux:state` | `refluxManager.getState()` → `RefluxState` | `reflux.getState()` |
| `reflux:tsvPath` | `RefluxManager.tsvFilePath`(tracker.tsv 절대경로) | `reflux.getTsvPath()` |
| `reflux:offsets` | `readRefluxOffsets()` — offsets.txt 파싱. `{ok, version, entries, relative, mtime}`(bigint→string) | `reflux.getOffsets()` |
| (push) `reflux:state` | state 변경 시 `webContents.send` | `reflux.onState(cb)` |

정의: `src/main/index.ts:39-53`, `200-211`, push `556-560`. preload `src/preload/index.ts:28-49`.

---

## 2. 메모리 스캔/리딩

| 채널 | 핸들러 역할 | preload API |
|------|-------------|-------------|
| `memory:scan` | 문자열을 4 인코딩으로 프로세스 전체 스캔 → 매칭 절대주소 + module-base 상대 offset. `{ok, modBase, modSize, results[]}` | `memory.scan(exe, text)` |
| `memory:refine-scan` | 이전 매치 목록에서 새 값과 일치하는 것만 keep(CE next-scan). 빈 문자열은 NULL 매치 | `memory.refineScan(exe, text, prev)` |
| `memory:find-anchor` | heap 주소를 가리키는 정적 포인터 + Reflux anchor delta + valueOffset 계산. `{ok, modBase, candidates[], refluxVersion, directHits}` | `memory.findAnchor(exe, heapAddr)` |
| `memory:read-via-anchor` | `(anchor, delta, valueOffset)` 로 string 읽기(`modBase+anchorRel+delta → *ptr+valueOffset`) | `memory.readViaAnchor(exe, anchor, delta, enc, maxBytes, valueOffset)` |
| `memory:read-string` | 저장된 module-base 상대 offset 으로 직접 string 읽기 | `memory.readString(exe, offset, enc, maxBytes)` |
| `memory:probe` | 프로세스 진단 — pid/modBase/modSize/modName. `ProbeResult` | `probe(exe)` |

정의: `src/main/index.ts:216-495`. preload `src/preload/index.ts:115-182`. 메커니즘 상세는 [memory-reading.md](memory-reading.md) 3절.

- `exe` 인자 기본값 `bm2dx.exe`(없으면).
- `enc` = `'utf16le' | 'utf8' | 'ascii' | 'shiftjis'`(`StringEncoding`, `src/main/memory.ts:444`).
- 모든 메모리 핸들러는 `findInfinitas` 실패 시 `{ok:false, error}`, 성공 시 `finally { closeHandle }`.
- 주 사용처: `MemoryScanner.tsx`(개발 모드 `startdev()` 노출) + `useProfile`(`readViaAnchor`/`readString`).

---

## 3. 외부 데이터 (ereter / zasa / rating / spTier / serviceStatus / offsets)

모두 main 에서 fetch + 캐시(상세 [data-flow.md](data-flow.md) 1절). `get` 은 `force?:boolean` 인자.

| 채널 | 핸들러 역할 | preload API |
|------|-------------|-------------|
| `ereter:get` | `getEreterData(force)`. `{ok, data: EreterData}` | `ereter.get(force?)` |
| `ereter:status` | `getCacheStatus()` → `{mtime, isStale, exists}` | `ereter.status()` |
| `ereter:dataPath` | `getDataPath()` — 캐시 파일 경로 | `ereter.dataPath()` |
| `zasa:get` / `zasa:status` | `getZasaData`/`getCacheStatus` | `zasa.get(force?)` / `zasa.status()` |
| `rating:get` / `rating:status` | `getRatingData`/`getRatingCacheStatus`(ohSorryRating.json) | `rating.get(force?)` / `rating.status()` |
| `sptier:get` / `sptier:status` | `getSpTierData`/`getSpTierCacheStatus`(SP ☆12 서열표) | `spTier.get(force?)` / `spTier.status()` |
| `serviceStatus:get` | `fetchServiceStatus()` — fresh fetch, fail-closed. `ServiceStatus`(uploadEnabled/shelfEnabled/notInINF) | `serviceStatus.get()` |
| `offsets:getProfile` | `getRemoteProfileOffsets()` — gist offsets.json 의 profile 부분(or null) | `offsets.getProfile()` |

정의: `src/main/index.ts:81-137`, `offsets:getProfile` `105-106`. preload `src/preload/index.ts:51-87`.

---

## 4. TSV

| 채널 | 핸들러 역할 | preload API |
|------|-------------|-------------|
| `tsv:read` | `readTsv(path)` → `{ok, rows: SongRow[], headerColCount, mtime}` | `readTsv(path)` |
| `tsv:clear` | `fs.truncate(path, 0)` — 내용만 비움(파일 유지). IIDX ID 전환 가드. ENOENT 는 정상 취급. `{ok, cleared}` | `clearTsv(path)` |

정의: `src/main/index.ts:140-173`. preload `src/preload/index.ts:21-25`. 파싱 상세 [memory-reading.md](memory-reading.md) 2절, 가드 [data-flow.md](data-flow.md) 4절.

---

## 5. 창 컨트롤 (frameless)

| 채널 | 핸들러 역할 | preload API |
|------|-------------|-------------|
| `window:minimize` | `mainWindow.minimize()` | `window.minimize()` |
| `window:maximize-toggle` | maximize ↔ unmaximize 토글. `{ok, maximized}` | `window.maximizeToggle()` |
| `window:close` | `mainWindow.close()` | `window.close()` |
| `window:isMaximized` | 현재 maximized 여부 | `window.isMaximized()` |
| (push) `window:maximized` | maximize/unmaximize 이벤트 시 send | `window.onMaximizedChange(cb)` |

정의: `src/main/index.ts:176-190`, push `529-535`. preload `src/preload/index.ts:191-204`. frame:false 라 커스텀 헤더 버튼이 호출([architecture.md](architecture.md) 4절).

---

## 6. 업데이트 / 포터블 / 이미지 / 셸

| 채널 | 핸들러 역할 | preload API |
|------|-------------|-------------|
| `update:check` | `checkForUpdate()` — GitHub 최신 릴리즈 vs 현재 버전. `UpdateInfo`(hasUpdate/latestVersion/portableUrl 등). 알림 전용 | `update.check()` |
| `portable:download` | `downloadPortable(url, fileName, sender)` — Downloads 폴더에 다운로드, `portable:progress` push. 경로 반환. (별도 등록 — sender 필요) | `portable.download(url, fileName)` |
| `portable:run` | `runPortable(filePath)` — spawn detached + `app.quit()` | `portable.run(filePath)` |
| (push) `portable:progress` | 다운로드 진행률 `{downloaded, total}` | `portable.onProgress(cb)` |
| `image:save` | base64/ArrayBuffer PNG 를 Downloads 에 저장. `{ok, path}` | `saveImage(data, defaultName?)` |
| `shell:showInFolder` | `shell.showItemInFolder(path)` | `shell.showInFolder(path)` |

정의: `update:check` `src/main/index.ts:108-109`, `image:save` `56-78`, `shell:showInFolder` `193-198`, portable 별도 등록 `504-509`. 핸들러 본체: `updateCheck.ts`/`portableUpdate.ts`. preload `src/preload/index.ts:89-115`, `184-188`.

- `update:check` 는 draft/prerelease 제외, SemVer 비교(`updateCheck.ts:13-24`), portable asset 정규식 `portable.*\.exe$`(`updateCheck.ts:83`).
- `portable:download` 는 GitHub release S3 redirect 따라감 + 100ms 마다 진행률 push(`portableUpdate.ts:79-123`). 동일 파일명은 ` (N)` 접미사(`portableUpdate.ts:56-65`).
- `cleanupOldPortables()`(`portableUpdate.ts:25-48`)는 IPC 아님 — 부팅 시 main 이 직접 호출(자기 portable 패턴만 정리).

---

## 7. 원격모드 / 종료 업로드 / LAN 접속정보

원격모드(LAN 로컬보드) 본인 카드 push, 앱·INFINITAS 종료 시 마지막 업로드 왕복, 폰 QR 용 접속정보 채널입니다. 흐름은 [data-flow.md](data-flow.md) 3·5절.

| 채널 | 방향 | 핸들러 역할 | preload API |
|------|------|-------------|-------------|
| `remote:setUser` | invoke | renderer 가 계산한 오소리웹 user 객체(별값+charts_json)를 `remoteUser` 에 저장 + `notifyMeUpdate()`(SSE `me:update`). `GET /api/me` 가 노출. `{ok}` | `remote.setUser(user)` |
| `server:info` | invoke | `serverConnectInfo()`(=http-server `connectInfo()`) → `ConnectInfo` 또는 null(http-server 미시작=dev). | `server.info()` |
| `upload:final-request` | push (main→renderer) | 앱 창 close / before-quit / INFINITAS 종료 감지 시 main 이 "마지막 업로드 1회" 요청 | `upload.onFinalRequest(cb)` |
| `upload:final-done` | send (renderer→main) | renderer 가 마지막 업로드 완료 후 ack. main `requestFinalUpload` 가 `ipcMain.once` 로 수신(또는 6초 timeout) | `upload.finalDone()` |

`ConnectInfo`(`src/main/http-server.ts:29-37`): `{ ip: string|null, port: number(=3000), port80: boolean, localName: string(=ohsorry.local), url: string|null(IP 기반 권장), nameUrl: string(이름 기반), qr: string|null(url 의 QR data URL — main qrcode 생성) }`.

정의: `remote:setUser` `src/main/index.ts:512-516`, `server:info` `52`, `requestFinalUpload`(push 발신 + done 수신) `534-553`, 종료 호출부 `570-582`/`612-628`/`700-722`. preload `src/preload/index.ts:206-227`.

- `server:info` 의 `qr` 은 렌더러가 `qrcode` 를 import 하지 않으려고(타입 누수 회피) main 에서 생성해 data URL 로 전달. 헤더 📱 버튼 → `QrConnect` 모달이 소비([architecture.md](architecture.md) 6절).
- `upload.onFinalRequest`/`finalDone`·`server.info` 는 PC2(브라우저 원격) 브리지에선 no-op/의미 없음(`src/renderer/src/api.ts`).

---

## 8. 브라우저 원격(PC2)에서의 차이 (`src/renderer/src/api.ts`)

PC2 polyfill 이 host 와 다르게 처리하는 것:

| API | host(Electron) | PC2(브라우저) |
|-----|----------------|---------------|
| `reflux.onState` | `ipcRenderer.on` | SSE `EventSource('/api/events')` + 30초 polling fallback |
| `saveImage` | main 이 Downloads 저장 | Chrome 자체 다운로드(`a[download]`) |
| `portable.*` | 실제 다운로드/실행 | reject/noop (원격 자동 업데이트 불가) |
| `window.*` | 실제 창 컨트롤 | noop |
| 나머지 채널 | `ipcRenderer.invoke` | `POST /api/ipc {channel, args}` |

정의: `src/renderer/src/api.ts:129-245`. `IS_BROWSER_REMOTE`(`src/renderer/src/api.ts:247`)로 Supabase 업로드/devMode 등 host 전용 로직 분기. LAN 서버 상세 [data-flow.md](data-flow.md) 5절.

---

## 9. 주요 공유 타입 참조 (`src/shared/types.ts`)

IPC 응답에 쓰이는 타입 정의 위치:
- `SongRow` / `ChartCell` / `ChartSlot`(`src/shared/types.ts:10-28`)
- `RefluxState` / `RefluxStage`(`108-125`)
- `EreterData` / `ZasaData` / `RatingData` / `SpTierData`(`133-230`)
- `ServiceStatus` / `NotInInfChart`(`234-248`)
- `UpdateInfo`(`284-295`) — `updateCheck.ts` 와 단일 정의 공유(중복 방지)
- `StarResult`(`30-39`), `ProbeResult`(`90-97`), `TsvReadResult`(`99-105`)

preload 의 반환 타입은 이 `shared/types.ts` 를 import 해 일치시킵니다(`src/preload/index.ts:2-17`).
