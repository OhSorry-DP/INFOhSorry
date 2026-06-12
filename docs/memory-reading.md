# 메모리 리딩 — Reflux 관리 / tracker.tsv / koffi Win32 스캔 / 프로필 offset / gist 원격 갱신

> INFINITAS(`bm2dx.exe`) 메모리에서 플레이 데이터와 프로필을 어떻게 끌어오는지, 그리고 게임 패치로 offset 이 깨질 때 어떻게 자동 복구하는지를 다룹니다.
> 상위 조망: [`../../docs/INFOhSorry.md`](../../docs/INFOhSorry.md) · 인덱스: [README.md](README.md)

메모리 데이터는 두 경로로 들어옵니다:

1. **곡/점수 데이터** — INF오소리가 직접 메모리를 읽지 않습니다. 서드파티 **Reflux**(olji/Reflux)를 자식 프로세스로 띄워 `tracker.tsv` 를 dump 시키고, 그 TSV 를 파싱합니다.
2. **프로필(DJ NAME / IIDX ID / SP·DP 단위)** — INF오소리가 koffi 로 직접 `bm2dx.exe` 메모리를 읽습니다(`memory.ts` + `useProfile`).

---

## 1. Reflux 자동 다운로드 + 관리 (`src/main/reflux.ts`)

`RefluxManager`(EventEmitter, `src/main/reflux.ts:245`)가 Reflux.exe 의 설치·실행·감시 전체 생명주기를 관리합니다.

### 작업 디렉토리

`%APPDATA%/infohsorry/Reflux/`(= `app.getPath('userData')/Reflux`, `src/main/reflux.ts:29-31`). 주요 파일:
- `Reflux.exe`, `config.ini`, `tracker.tsv`, `offsets.txt`, `sessions/`, `tracker.db`

### `startAll()` 흐름 (`src/main/reflux.ts:293-317`)

1. `Reflux.exe` 없으면 `install()` — GitHub `olji/Reflux` 최신 릴리즈에서 `reflux.exe` asset 다운로드(`src/main/reflux.ts:380-394`, API `src/main/reflux.ts:26`).
2. `ensureConfig()` — `config.ini` 없으면 기본값 생성(`savelocal=true` 등, `src/main/reflux.ts:120-147`, `397-402`). 있으면 보존.
3. `ensureOffsets()` — offsets.txt + 보조 파일 확보. **버전 비교로 자동 갱신**(아래 4절).
4. offsets 가 갱신됐는데 Reflux 가 이미 떠 있으면 강제 재시작(새 offset 재로드, `src/main/reflux.ts:304-308`).
5. `spawnReflux()` — 기존 Reflux kill 후 새로 spawn.
6. `watchTsv()` — `tracker.tsv` 변경 감지.
7. `startHealthCheck()` — Reflux.exe 생존 감시.

### spawn 방식 (`spawnReflux`, `src/main/reflux.ts:539-584`)

PowerShell `Start-Process -WindowStyle Hidden` 으로 띄웁니다(`src/main/reflux.ts:551-569`). 이유(`src/main/reflux.ts:480-493` 주석):
- Reflux 는 hook 직후 `Console.Clear()` 를 호출 → 콘솔이 없으면 즉사(IOException). ShellExecute 류 launch 가 새 콘솔을 부여해야 동작.
- 트레이드오프: cmd/PowerShell 은 곧 종료되어 Reflux 본체의 PID 를 직접 모름 → cleanup 은 image name 기준 `taskkill /IM Reflux.exe`. stdout 도 캡처 안 됨(hooking stage 매칭 비활성). 대신 `tracker.tsv` watch 만으로 'ready' 감지.

`spawned` state 는 "뭔가 떠 있다" 신호이고 Reflux 본체는 별도 프로세스로 생존(`src/main/reflux.ts:570-578`).

### 세션 정리 정책 (`src/main/reflux.ts:498-518`, `cleanedUp` 플래그 `263`)

- `tracker.tsv` — 파일 자체는 유지하고 내용만 `truncateSync(path, 0)` 으로 비움. Reflux 의 watch handle / 새 파일 생성 race 회피.
- `tracker.db` / `sessions/` — `rmSync(recursive)` 로 제거.
- 이 정리는 **process lifetime 의 첫 spawn 1회만**(`cleanedUp` 가드). 이후 재spawn(health check 자동 재시작, 사용자 stop→start)에서는 tsv 보존 — 앱 재시작 때마다 데이터가 비워지는 문제 방지.

### Health check (`src/main/reflux.ts:322-377`)

- `tasklist /FI "IMAGENAME eq Reflux.exe"`(System32 절대경로, `src/main/reflux.ts:349-363`)로 생존 확인.
- tsv 첫 로드 전: `HEALTH_CHECK_INITIAL_MS = 30초`(IIDX 가 늦게 떴을 때 빠른 회복). tsv 첫 로드 후: `HEALTH_CHECK_STEADY_MS = 5분`(`src/main/reflux.ts:258-259`, transition `331-338`).
- 죽음 감지 시 자동 `spawnReflux()`(`src/main/reflux.ts:365-377`). 사용자가 명시적으로 stop 했으면(`spawned=false`) skip.
- tasklist 실행 실패 시 "alive 로 가정" → 무한 spawn 방지(`src/main/reflux.ts:358-362`).

### tsv watch (`watchTsv`, `src/main/reflux.ts:587-612`)

`fs.watch(workDir)` 로 디렉토리 감시(파일이 아직 없을 수 있어 디렉토리 단위). `tracker.tsv` mtime 변경 시 `stage:'ready'` + `lastTsvMtime` 갱신 + health check 를 STEADY 로 전환.

### RefluxState (`src/shared/types.ts:108-125`)

`stage`: `idle | downloading | starting | hooking | hooked | ready | error`. + `installed`/`spawned`/`download`/`lastTsvMtime`/`error`/`recentLines`. `getState()` 는 디스크에 exe 존재하면 `installed:true` 보강(`src/main/reflux.ts:265-273`).

---

## 2. tracker.tsv 파싱 (`src/main/tsv.ts`)

Reflux 의 TSV 를 곡별 `SongRow` 로 변환합니다. IPC `tsv:read` 가 호출(`src/main/index.ts:140-148`).

### 컬럼 구조 (`src/main/tsv.ts:1-7` 주석)

곡당 1행. 메타(`title`/`Type`/`Label`) + 9개 차트 slot(`SPB SPN SPH SPA SPL DPN DPH DPA DPL`, `src/main/tsv.ts:11`) 각각 8개 컬럼:
`Unlocked, Rating, Lamp, Letter, EX Score, Miss Count, Note Count, DJ Points`.

### 파싱 세부 (`parseRow`, `src/main/tsv.ts:33-60`)

- 헤더 라인으로 `col 이름 → index` 맵 빌드(`buildHeaderIndex`, `src/main/tsv.ts:26-31`) — 컬럼 위치가 아닌 이름 기준.
- **`Rating` 컬럼은 사실 게임 내 LEVEL(1~12 정수)** 입니다(`src/main/tsv.ts:51`, `ChartCell.level` 주석 `src/shared/types.ts:12`). 별값(★)과 혼동 주의.
- Lamp: Reflux 의 `PFC`(Perfect FC)는 `FC` 로 통합(`src/main/tsv.ts:45-46`).
- `Unlocked` 컬럼 자체가 없으면 그 slot skip(구버전 TSV 호환).

결과 `SongRow`(`src/shared/types.ts:23-28`): `{ title, type, label, charts: Partial<Record<ChartSlot, ChartCell>> }`. `ChartCell` 은 `{ unlocked, level, lamp, letter, exScore, missCount, noteCount, djPoints }`.

`extractCharts(rows, {slots, level?})`(`src/shared/types.ts:62-87`)로 차트 단위 평탄화(`SongChart`) — 별값 추정/추천 모델 input.

### tsv:clear (`src/main/index.ts:155-173`)

IIDX ID 전환 시 옛 데이터가 새 ID 로 잘못 업로드되는 것을 막기 위해 `fs.truncate(path, 0)` 으로 내용만 비웁니다(파일은 유지 → Reflux watch handle 보존). 가드 로직 상세는 [data-flow.md](data-flow.md) 의 "IIDX ID 전환 가드".

---

## 3. koffi Win32 메모리 스캔 (`src/main/memory.ts`)

`koffi`(prebuilt, 빌드 도구 불필요)로 `kernel32.dll` 함수를 직접 호출해 `bm2dx.exe` 에 attach 후 메모리를 읽습니다.

### 기본 흐름 (`src/main/memory.ts:1-11` 주석)

1. `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` → 프로세스 enum → exe 이름 매칭 PID(`findProcessId`, `src/main/memory.ts:114-147`).
2. `OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, ...)` → handle(`findInfinitas`, `src/main/memory.ts:246-269`).
3. `CreateToolhelp32Snapshot(TH32CS_SNAPMODULE|MODULE32, pid)` → 주 모듈 base/size(`findMainModule`, `src/main/memory.ts:199-243`).
4. `ReadProcessMemory(handle, base+offset, ...)`(`readBytes`, `src/main/memory.ts:273-282`).

API 바인딩은 `kernel32.func('... __stdcall ...')` 시그니처 문자열로(`src/main/memory.ts:58-80`). 구조체는 `koffi.struct`(`PROCESSENTRY32W` `src/main/memory.ts:30-41`, `MODULEENTRY32W` `44-55`, `MEMORY_BASIC_INFORMATION` `329-339`).

> 64-bit 주소는 모두 `bigint` 로 다룹니다(`InfinitasHandle.modBaseAddr: bigint`, `src/main/memory.ts:104-110`). 핸들은 `unknown` 으로 받아 그대로 `CloseHandle` 에 전달. 핸들 누수 방지 위해 호출부는 `finally { closeHandle(...) }`(예: `src/main/index.ts:250-252`).

### read 헬퍼

`readInt32`/`readUint32`/`readFloat`/`readDouble`/`readPointer`/`readStringW`/`readStringA`(`src/main/memory.ts:285-316`).

### 문자열 인코딩 (`StringEncoding`, `src/main/memory.ts:444`)

`utf16le | utf8 | ascii | shiftjis`. `encodeString`/`decodeString`(`src/main/memory.ts:446-471`) — shiftjis 는 `iconv-lite`. INFINITAS 곡명의 한자/가나를 위해 4 인코딩 모두 시도.

### region enumerate + 스캔

`listMemoryRegions`(`src/main/memory.ts:358-403`) — `VirtualQueryEx` 로 commit + readable 영역만 수집(`MEM_COMMIT`, `READABLE_MASK`, PAGE_GUARD/NOACCESS 제외).

스캔 함수 3종:
- `scanForBytes(handle, pattern, maxMatches=200)`(`src/main/memory.ts:407-441`) — 4MB 청크로 byte 패턴 검색. (청크 경계 걸침은 미처리 — 패턴이 짧아 false negative 확률 낮음, `src/main/memory.ts:427-428` 주석).
- `scanString(handle, text, encodings, maxMatches)`(`src/main/memory.ts:481-500`) — 인코딩별 매칭 그룹.
- `scanForPointer`(`src/main/memory.ts:545-579`) / `scanForPointersInRange`(`509-541`) — 정적 영역에서 heap 주소(또는 그 근처)를 가리키는 8-byte 포인터 검색. anchor 발견에 사용.

### ASLR 대응 + anchor 메커니즘

ASLR 때문에 절대 주소는 실행마다 바뀝니다. 그래서 **module base 기준 상대 offset** 으로 저장합니다(`memory:scan` 결과의 `relative`/`relativeRaw`, `src/main/index.ts:226-249`).

heap 값(매번 위치가 바뀌는 동적 버퍼)을 안정적으로 따라가기 위한 anchor 방식(`memory:find-anchor` `src/main/index.ts:332-414`, `memory:read-via-anchor` `421-450`):
1. heap 주소를 가리키는 정적 포인터를 찾고, 없으면 struct base(앞 0x1000 바이트)를 가리키는 포인터를 찾음 → `valueOffset = heapAddr - structBase`.
2. Reflux `offsets.txt` 의 가장 가까운 anchor 와의 `delta` 계산.
3. 다음 실행에서 `modBase + anchor의 현재 relative + delta` = 포인터 위치 → `*포인터 + valueOffset` = 문자열 위치.

이 anchor 발견 UI 가 `MemoryScanner.tsx`(개발 모드 `startdev()` 로 노출). 사용하는 IPC: `memory.scan`/`refineScan`/`findAnchor`/`readViaAnchor`/`readString`. 저장 키는 `localStorage`(아래 5절).

`memory:refine-scan`(`src/main/index.ts:261-325`) — Cheat Engine 의 next-scan 처럼 이전 매치 목록에서 새 값과 일치하는 것만 keep. 빈 문자열 검색은 NULL byte 매치(현재 안 보이는 상태)로 해석.

---

## 4. 프로필 offset + useProfile

### profileOffsets 상수 (`src/shared/profileOffsets.ts`)

`bm2dx.exe` modBase 기준 정적 offset 의 코드 fallback. `PROFILE_OFFSETS`(`src/shared/profileOffsets.ts:22-59`):
- `refluxVersion`: 발견 당시 게임 버전(`P2D:J:B:A:2026060300`).
- `djName`(offset `0x690d3e`, utf8), `iidxId`(`0x690d30`, utf8), `spRank`(`0x58d9f8`, utf16le), `dpRank`(`0x58d9f0`, utf16le).
- DJ NAME / IIDX ID 는 14 bytes 간격 인접 — 같은 player profile struct 필드(`src/shared/profileOffsets.ts:4`). SP/DP 단위는 한자(中伝/皆伝/十段 등) utf16le.
- **게임 패치로 `.data` section layout 이 바뀌면 깨짐** → MemoryScanner 로 재스캔(주석 `src/shared/profileOffsets.ts:6`). 2026-04-22 패치 때 struct 가 +0x80 이동했던 이력 기록(`src/shared/profileOffsets.ts:31-32`).

### useProfile (`src/renderer/src/useProfile.ts`)

`refluxState` 가 ready/hooked 일 때 5초 주기 polling(`POLL_INTERVAL_MS=5000`, `src/renderer/src/useProfile.ts:14`)으로 4 필드를 읽습니다.

offset 우선순위(`effective`, `src/renderer/src/useProfile.ts:79-90`):
1. **사용자 저장값**(`localStorage`, MemoryScanner 로 저장) — anchor 또는 direct 모드(`SavedSlot`, `src/renderer/src/useProfile.ts:24-37`).
2. **gist offsets.json 의 profile**(IPC `offsets:getProfile`, `pickDef` `src/renderer/src/useProfile.ts:66-77`).
3. **코드 상수** `PROFILE_OFFSETS`.

읽기(`readField`, `src/renderer/src/useProfile.ts:92-116`)는 anchor 면 `memory.readViaAnchor`, direct 면 `memory.readString` 호출. 인코딩별 제어문자 trim.

stage 가 idle/starting/downloading 이면 profile state 를 null 리셋(옛 값 sticky 방지, `src/renderer/src/useProfile.ts:155-161`).

`iidxIdFormatted`: 13자 `^[A-Z]\d{12}$` 면 `C-NNNN-NNNN-NNNN` 로 변환(`src/renderer/src/useProfile.ts:195-198`).

localStorage 키(`STORAGE_KEY`, `src/renderer/src/useProfile.ts:17-22`):
`infohsorry-scanner-djname-v2` / `-iidxid-v2` / `-sprank-v2` / `-dprank-v2`. (MemoryScanner 는 추가로 `-matches-v1` 류 스캔 매치 캐시도 저장.)

> SP/DP 단위는 메모리 리딩이 자주 실패합니다. 그래서 `ProfileCard` 는 Supabase `users.sp_rank/dp_rank`(eagate djdata 기반, ohSorryAdmin/getInfRadar.js 가 채움)를 `fetchUserPublic` 으로 받아 보강합니다. INF오소리 자체는 단위를 **업로드하지 않습니다**(`upsert_user` 에 `p_sp_rank:null`, `src/renderer/src/supabaseSync.ts:273-274`). 상세는 [data-flow.md](data-flow.md).

---

## 5. gist offsets.json 원격 갱신 (`src/main/offsetsRemote.ts`)

INFINITAS 패치로 메모리 offset 이 이동하면, **gist `offsets.json` 한 파일만 갱신**하면 앱이 다음 실행 때 자동 반영합니다(재빌드/재배포 불필요).

### gist 구조 (`src/main/offsetsRemote.ts:9-21`)

URL: `gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw/offsets.json`.
`RemoteOffsets`:
- `version`: `'P2D:J:B:A:YYYYMMDDxx'` — 끝 10자리가 클수록 최신.
- `reflux?`: `{ songList, unlockdata, ... }` = 절대주소 문자열.
- `profile?`: `{ djName, iidxId, spRank, dpRank }` 각각 `{ offset, encoding, maxBytes }`.

`getRemoteOffsets(force)`(`src/main/offsetsRemote.ts:26-43`) — fetch + 메모리 캐시(`_cache`). 실패 시 이전 캐시(or null). `getRemoteProfileOffsets()`(`46-49`) 가 IPC `offsets:getProfile` 로 노출되어 useProfile 의 기본값이 됨.

### Reflux offsets.txt 자동 갱신 (`ensureOffsetsFile`, `src/main/reflux.ts:433-478`)

게임 패치로 깨진 메모리 offset 을 앱을 켜기만 해도(startAll) 자동 복구하는 핵심 로직입니다.

후보 버전을 비교해 **가장 최신을 디스크에 덮어씁니다**:
1. **디스크** offsets.txt 의 버전(헤더 끝 10자리, `offsetsVersionNum` `src/main/reflux.ts:73-77`).
2. **번들** `BUNDLED_OFFSETS`(코드에 박힌 최신값, `src/main/reflux.ts:62-72`, 현재 `2026060300`).
3. **우리 gist** `offsets.json` 의 reflux(`refluxObjToTxt` 로 텍스트 변환, `src/main/reflux.ts:79-87`).
4. **olji/Reflux master** 의 `offsets.txt`(`src/main/reflux.ts:459-468`).

우선순위 = `max(디스크, 번들, gist, olji)`. olji 가 우리 번들 이상으로 올라오면 olji 존중(`src/main/reflux.ts:443-471`). 디스크보다 최신이면 덮어쓰고 `true` 반환 → `startAll` 이 Reflux 재시작.

### offsets.txt 파싱 (`readRefluxOffsets`, `src/main/reflux.ts:89-117`)

첫 줄 = version 헤더. 이후 `key = hex_address`. Reflux 는 preferred base `0x140000_0000`(`REFLUX_PREFERRED_BASE`, `src/main/reflux.ts:57`) 가정으로 절대주소 기록 → `relative = abs - preferredBase` 로 module-base 상대 offset 계산. anchor 매칭(`memory:find-anchor`)이 이 `relative` 를 사용.

### INFINITAS 패치 시 offset 깨짐 이슈

- **곡/점수(Reflux 경로)**: olji master 가 새 offset 을 올리기 전까지 라이브 트래킹이 깨질 수 있음. 대응 = 번들 `BUNDLED_OFFSETS` 갱신 또는 gist `offsets.json` 갱신(둘 다 `ensureOffsetsFile` 가 자동 반영). 패치마다 `src/main/reflux.ts:62-72` 의 `BUNDLED_OFFSETS` + `BUNDLED_OFFSETS_VERSION` 을 갱신(주석 `src/main/reflux.ts:59-61`).
- **프로필(직접 리딩 경로)**: `profileOffsets.ts` 상수가 깨짐 → gist `offsets.json` 의 profile 갱신 또는 MemoryScanner 재스캔.
- **확인 필요(메모리 노트)**: 라이브 트래킹 재패치(djName/iidxId 수동 갱신 외 전체) 는 별도 보류 작업으로 추적 중(`project_infohsorry_offset_repatch`). 코드 상으로는 자동 복구 메커니즘이 갖춰져 있으나, 새 패치의 실제 offset 값 발굴은 수동 단계가 필요합니다.
