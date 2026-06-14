# INFOhSorry 변경 이력

INFINITAS DP 뷰어 앱의 버전별 변경 내역입니다. 사용 방법은 [README.md](README.md) 를 참고하세요.

### v0.0.81 — 2026-06-14 SP10~12 기록 supabase 적재 (play_style:0)
- `supabaseSync.ts`: `uploadProfile` 에 `spCharts` 입력 추가 → SP 채보 중 **gameLevel 10·11·12** 만 추려 `upsert_scores` 에 **`play_style:0`** 으로 함께 전송(played_version=0 INF, song_id 는 곡 단위라 DP 와 공유, songs 미등록 곡은 skip). dedup 키에 play_style 포함(SP/DP 클라단 충돌 방지). `ScoreRow` 에 play_style 필드, DP 행은 play_style:1 명시.
- `App.tsx`: 3분 주기 업로드 `uploadStateRef` 에 `spAllCharts` 추가 → 최신 SP 기록으로 업로드. (오소리웹 DP 화면은 RPC 의 play_style=1 필터로 SP 안 섞임 — ohSorryAdmin sql/04·05.)

### v0.0.80 — 2026-06-14 원격모드 setUser push dedup (카드 무한 재렌더 수정)
- `App.tsx`: 원격모드 실시간 setUser effect 가 `profile`(useProfile, 매 렌더 새 객체) 의존으로 **매 렌더 fire → setUser 폭주 → SSE me:update 폭주 → 오소리웹 카드가 계속 재렌더**되던 문제. 내용 시그니처(iidx·star·charts 길이/exScore합·SP 길이·tier)로 dedup — 실제로 바뀔 때만 push.

### v0.0.79 — 2026-06-14 /osr 프록시 네트워크 우선(stale 웹 수정)
- `http-server.ts` `serveOsr`: **캐시 우선 → 네트워크 우선**으로 변경. 매 요청마다 cache-bust 쿼리(`?t=`)로 오소리웹을 받아 항상 최신 서빙, 네트워크 실패 시에만 디스크 캐시 fallback. (이전엔 캐시가 있으면 영원히 stale, 또는 CDN edge 가 옛 파일을 캐시해 새 배포(SP 토글·본인행 핀 등)가 폰에 안 뜨던 문제.) `OSR_ORIGIN` 을 정본 도메인 `ohsorry.iidx.in`(vercel.app 은 여기로 308)로 직접 지정해 리다이렉트 라운드트립 제거.

### v0.0.78 — 2026-06-14 원격모드 ⑤본인 카드 진입 + ⑥SSE 실시간 갱신 + SP 데이터 토대
- **SP 데이터 노출(원격모드)** — `remoteUser.ts`: `spChartToJson` + `buildRemoteUser(…, spCharts, spTier12)` 로 `/api/me` 에 `sp_charts_json`(친 모든 SP 채보, DP charts_json 과 동일 형식 + playStyle:'SP') + `sp_tier12`(SP12 서열표) 추가. `App.tsx`: `spAllCharts`(전 레벨/시리즈 SP 플레이 채보) + setUser 에 spTierData 전달. 소스 비종속 설계 — 추후 오소리본체가 supabase 에 SP 백필(play_style 컬럼) 시 같은 필드 재사용. (오소리웹 SP 모드 UI 는 ohSorryWeb CHANGELOG.)
- **⑥ SSE 실시간 갱신** — `http-server.ts`: `setupSseBroadcast` 에 `notifyMeUpdate()`(SSE `me:update` 이벤트) 추가, `startHttpServer` 가 이를 반환. `index.ts`: `remote:setUser` IPC 가 호출될 때마다 `me:update` broadcast → PC2(오소리웹 `?remote`)가 보고 있는 본인 카드를 새로고침 없이 조용히 다시 그림.
- **⑥ 실시간 push 분리** — `App.tsx`: 원격모드 본인 카드(`setUser`)를 3분 supabase 업로드 타이머에서 떼어내 **dp12(별값/매칭) 재계산 즉시** push 하는 별도 effect 로 이동. 플레이 직후 곧장 반영(이전엔 최대 3분 지연), supabase 업로드는 그대로 3분 주기.
- (⑤ 본인 카드 자동 진입 / 유저 목록 최상단 핀 / 조용한 제자리 갱신 UI 는 오소리웹쪽 변경 — ohSorryWeb CHANGELOG 참고.)

### v0.0.77 — 2026-06-14 원격모드(LAN 로컬보드) 오소리웹 카드 — 본인 실시간 표시
- LAN 원격모드(`http://PC-IP:3000`)에서 INF 자체 UI 대신 **오소리웹 카드**를 띄우고 본인 플레이데이터·별값을 **실시간** 표시 (매번 오소리웹→INF 포팅을 없애고 UI 를 오소리웹 단일 소스로).
- `http-server.ts`: `GET /api/me`(renderer 가 계산한 별값 + charts_json 을 로컬 실시간 노출) + `/osr/*` 오소리웹 서빙(vercel 캐시/프록시 — 오프라인 캐시 A + 최신화 B). `remote:setUser` IPC 로 renderer→main user push.
- `remoteUser.ts`: INF 로컬값(별값 `StarResult` + `RecInputChart[]`) → 오소리웹 `user` 객체 어댑터(charts_json rename). `App.tsx` 가 supabase 업로드 시점에 함께 push.
- 사용: 폰 등 원격 클라이언트 → `http://PC-IP:3000/osr/?remote` → 오소리웹 + 본인 카드. (오소리웹은 `?remote` 일 때만 `/api/me` 분기 — 일반 사용자 무영향.)

### v0.0.76 — 2026-06-13 tracker.tsv 실시간 reload + 문서 구조 개편
- `tracker.tsv` 변경 시 **실시간 reload**(debounce 400ms) 부활 — UI 곡 표/별값을 즉시 갱신. Supabase 업로드는 3분 주기로 분리(이전엔 3분 timer 가 읽기+업로드를 함께 처리). 옛 ID 오업로드는 `rowsSourceIidxIdRef` 태깅 + 업로드 가드가 그대로 방어.
- 문서: README 를 앱 사용법 중심으로 정리, 개발 상세는 `docs/`(architecture / memory-reading / data-flow / ipc-reference) 로 분리, 변경 이력은 `CHANGELOG.md` 로 분리.
- 이번 릴리즈에 직전 미릴리즈 항목 포함 — patterns 레벨 구간 3분할 lazy 로드, offsets gist 연동(아래 항목).

### (미릴리즈) patterns 레벨 구간 분할 lazy 로드 (평소 11·12 만 fetch)
- gist patterns 를 레벨 구간 3분할(1112/0810/rest)한 것에 맞춰, 평소엔 `patterns-dp-1112`(1.8MB)만 fetch (기존 `patterns-all-slim` 7MB).
- `recommendCore`: 1112 기본 + `ensurePatternsLevel(libs, band)` 로 0810/rest 를 `libs.patterns` 에 in-place lazy 병합 (ohSorry / ohSorryWeb 과 동일 구조).
- `App`: 추천 baseStar<6 또는 약점 zasaMin<11 일 때만 하위 구간 lazy 로드 후 recCtx 재생성. 평소(11·12)엔 미발생.
- `Analysis` / `PlayData`: 약점 분석은 고렙 기준이라 1112 로 충분 (lazy 불필요).

### (미릴리즈) offsets gist 연동 — Reflux + 프로필 메모리 offset 원격 관리
- gist `offsets.json` 한 파일로 **Reflux offsets + 프로필(djName/iidxId/단위) 메모리 offset** 통합 관리. INFINITAS 패치 시 gist 만 갱신하면 양쪽 자동 반영(재빌드 불필요).
- `main/offsetsRemote.ts` 추가 — gist `offsets.json` fetch+캐시 (`{ version, reflux, profile }`).
- `reflux.ts` `ensureOffsetsFile` 버전비교 후보에 gist 추가 → `max(디스크, olji master, gist, 번들)`.
- `useProfile` 이 gist profile offset 을 기본값으로 사용 (사용자 저장 > gist > `profileOffsets.ts` 상수 fallback).
- gist: `OhSorry-DP/30c3ba6…/offsets.json`. (MemoryScanner 수동 스캔 보조 UI 는 코드 상수 유지)

### 0.0.75 — Reflux offsets 자동 갱신 (게임 패치 시 앱만 켜면 복구)
- 게임 패치로 메모리 offset 이 이동하면 olji/Reflux master 가 따라잡기 전까지 라이브 트래킹(곡/점수)이 깨지던 문제 해소.
- 최신 offsets 를 앱에 **번들**하고, 앱 시작(startAll)마다 **디스크 / olji master / 번들 버전을 비교**해 디스크가 구버전이면 자동으로 최신 덮어쓰기. olji 가 더 최신이면 olji 우선(버전비교 우선).
- offsets 가 실제로 갱신되면 Reflux 를 **재시작**해 새 offset 을 다시 읽도록 처리.
- 현재 번들: `P2D:J:B:A:2026060300`(6/3 INFINITAS 패치). 이후 패치 시 reflux.ts 의 `BUNDLED_OFFSETS` 갱신.

### 0.0.74 — 별값(★) 파이프라인 v3.4.0 교체 + RECENT DP/DBR 토글
- **별값 파이프라인 v3.4.0(onlyOSR + toEreter) 전면 교체**
  - 별값 계산을 본체 v3.4.0(core 0.0.368) 방식으로 통일 — gist `onlyOSR.js` + `onlyOSRtoEreter.js` 2개 lib 의 `inferEreter` 단일 호출로 표시 별값(ereterStar)과 추천 base 를 산출.
  - 옛 다단계 파이프라인 **완전 제거**: osr / OSR13.5+ / oldOSR / adopt 4-lib + `estimateStar` / `calc-osrating` / `star-estimator` / `adopt`. gist lib 가 UMD(`require`) 참조로 eval 되며 `require is not defined` 로 별값이 N/A 되던 문제 해소. (의존 lib 로딩은 recommendCore 의 `loadGistModule` 로 일원화)
  - 추천곡 base = 표시 별값(ereterStar) 사용. dp12Match / 추천 / 업로드 경로는 그대로 유지.
  - (보류) supabase `native_star` 업로드 정렬 — RPC `upsert_user` 시그니처 확인 후 후속.
- **RECENT 탭 DP/DBR 토글 추가** (오소리웹 동일)
  - 헤더 우측 `DBR` 버튼 — OFF: DP(일반)만, ON: DBR(배틀, `played_version=-10`)만. 그동안 DP 탭에 DBR 기록이 섞여 보이던 문제 해소.
  - DBR 모드는 DBR 난이도(dbr-inf-recommend.json) 표시 + 그 기준 정렬, EX 2채보 합산 보정(djLevel/등급차를 노트수×2 기준 재계산), prev 는 같은 시즌(-10)만 비교.
- Reflux offsets `P2D:J:B:A:2026060300`(6/3 INFINITAS 패치) 반영 + `profileOffsets.refluxVersion` 갱신 (djName/iidxId 메모리 offset 은 변동 없어 유지).

### 0.0.73 — 서열표 곡 클릭 시 플레이데이터에서 자동 검색·선택(점프)
- 0.0.72 에서 서열표 곡 클릭 시 검색창에 곡명 **입력**까지만 됐는데, 이제 **드롭다운 결과를 자동 선택해 해당 곡으로 점프**(폴더 열림 + 스크롤 + 하이라이트)까지 수행.
- 곡 마스터 / 검색 인덱스 로딩 전 클릭이면 대기했다가 준비되는 즉시 실행. `norm()` 매칭으로 곡을 찾고 기존 검색 선택 동작(`onPickSearch`)을 그대로 재사용.

### 0.0.72 — 서열표 곡 클릭 → 플레이데이터 점프 + 검색 정규화
- **GRID 서열표(DP/SP 전부) 곡명 클릭 → PLAYDATA 탭으로 이동** — 기존 DP 차트뷰어 점프 대신 플레이데이터로 통일. 클릭한 곡의 slot 접두사(DP/SP)로 **플레이데이터 토글(SP/DP) 자동 전환 + diff 필터 자동 맞춤 + 검색창에 곡명 입력**(드롭다운 표시 → 항목 클릭 시 해당 곡으로 점프).
- **플레이데이터 검색 `norm()` 정규화 매칭** — 공백/특수문자/전각 차이를 무시해, 서열표에서 넘어온 곡명도 마스터 곡명과 정확히 매칭. raw 부분일치도 fallback 으로 유지.

### 0.0.71 — 계정 전환 시 옛 점수 잘못 업로드 버그 수정
- **A→B 계정 전환 감지 추가** — INF오소리를 켜둔 채 게임만 다른 IIDX 계정으로 다시 켰을 때, 기존엔 `iidxId` 가 5초 이상 null 로 지속될 때만 정리해서 A→B 직접 전환은 누락 → 옛 ID 의 TSV 점수가 새 ID 로 잘못 업로드되던 문제. 이제 prev/now 가 둘 다 유효 13자 ID 인데 서로 다르면 **즉시** rows/tsv 비우기 + 재업로드 활성화.
- **rows 출처 ID 태깅 + 업로드 게이트 (이중 안전장치)** — TSV read 시점의 live ID 를 기록(`rowsSourceIidxIdRef`)하고, 업로드 직전 *출처 ID ≠ 현재 ID* 면 업로드를 건너뜀(새 Reflux 덤프 대기). 비동기 업로드 도중 ID 가 바뀌는 경쟁 상황까지 차단.

### 0.0.70 — RECENT 탭 렉 개선 + 추천 탭 UI 정리
- **RECENT "오늘(라이브)" 박스 렉 해소** — 기존엔 supabase latest(DB) 도착 전에 플레이한 모든 차트를 먼저 렌더했다가, DB 도착 후 변동 곡만 필터링해 재렌더 → 큰 목록을 그렸다 지우며 렉.
  - `latestLoaded` 플래그 추가 → **DB 로드 완료 후에만** 변동 곡을 계산해 단일 렌더. 로드 전엔 "불러오는 중..." 표시.
  - `latestIdx === null` 의 "로딩 중" vs "오프라인 실패" 를 구분 — fetch 실패 시엔 기존처럼 TSV-only 전체 목록 fallback 유지.
- **연습곡 카드 헤더 정렬 수정** — 리롤(↻) 버튼을 `(N곡)` 카운트 바로 뒤로 옮기고, ☆ 별값 범위 입력을 헤더 오른쪽 끝으로 정렬(`margin-left:auto`).
- **연습곡 해시태그 줄 좌우 배치** — 곡 클릭 시 펼쳐지는 줄에서 해시태그는 왼쪽, 목표 EX스코어는 오른쪽 끝에 정렬.
- **연습곡 목표 rate 라벨** — 목록의 목표값을 `66.7%` → `목표 66.7%` 로 표기.
- **배치 추천 ON/OFF 토글 추가** — 추천곡 영역 헤더의 `복습곡 포함/제외` 토글 왼쪽에 동일 스타일로 `배치 ON / 배치 OFF` 토글 신설. 코어 `setLayoutMode` 연동(ON=8 배치 중 최적 배치 기준, OFF=정규 배치). 기본 ON.

### 0.0.69 — GRID 탭에 SP ☆12 서열표 추가 (외부 ☆12参考表 하드/노마게 tier)
- **GRID 탭에 `SP12` 탭 신설** — 외부 구글 시트 "☆12参考表" 의 간이표(簡易) 를 런타임에 published HTML 로 fetch → 파싱 → `userData/sp-tier-12.json` 캐시(TTL 24h, fetch 실패 시 stale 캐시 fallback).
  - 표 안 **하드 / 노마게 토글** — 하드(ハード) 기본, 누르면 노마게(ノマゲ) 클리어 난이도 tier 로 전환.
  - tier 그룹 = `S＋ ~ F` 문자 등급(어려운 → 쉬운). DP 서열표의 그룹/스택드 바/정렬/캡처 UI 재사용.
  - 난이도는 슬롯 색으로 구분(NORMAL 하늘 / HYPER 금색 / ANOTHER 기본 / LEGGENDARIA 마젠타), LEGGENDARIA 는 곡명 앞 `†` 표시. 시트에서 곡명이 빨강인 곡은 **개인차/주의곡** 으로 각 tier 그룹 맨 아래에 모아 `개인차` 라벨로 구분 표시.
  - 매칭 범위: INFINITAS 수록 SP ☆12 차트만 (아케이드 전용곡 제외) — 기존 DP 서열표와 동일하게 플레이 데이터 기반.
- `main/spTier.ts`(fetch+파싱+캐시) 신규 + `sptier:get/status` IPC + preload `spTier` 노출.

### 0.0.68 — 추천곡 리롤 변동성(코어 풀+계층 랜덤) + 클리어 시 자동 채움 복구 + 클리어/연습곡 INF 미수록 필터
- **추천 산출을 코어 recommend.js(v0.0.9) 로 완전 일원화** — `recsFromCore`(결정적) 를 `buildRecsWithPool` 기반 picked/pool state 로 재배선.
  - **리롤** = 코어 풀(클리어 30곡 / 연습곡 60곡)에서 계층 랜덤(상위 4 / 중간 3 / 하위 3) 재추출 → 누를 때마다 곡 변동. 연습곡 카드에도 리롤 버튼 추가.
  - **클리어 시 자동 채움 복구** — picked 에서 클리어된 곡 제거 + pool 에서 refill (`refreshRecs`). 그동안 코어 결정적 결과라 안 되던 동작 복구.
- **INF 미수록 차트 필터** — 연습곡(`isInfChartInSeries`) + 클리어 추천(`allCharts` 선필터) 모두 `service-status.json` 의 `notInINF` + supabase `songs.ac/legen` 기준으로 제외. Reflux 에 데이터만 있고 실제 INFINITAS 미노출인 차트 / INF 미수록 LEGGENDARIA 제거.
- `shared/recommend.ts` 의 옛 로컬 추천 알고리즘 제거 (타입 + refresh 보조 함수만 유지) — 추천 알고리즘은 코어 recommend.js 한 곳에서만 관리.

### 0.0.67 — 탭 재편 (RECENT / PLAYDATA / RECOMMEND / GRID / ANALYSIS) + 연습곡 추천 카드 + 본체 추천 알고리즘 100% 통합
- **탭 재편** — 기존 단일 DP 탭 + dp12 → 5개 탭으로 분리:
  - `RECENT` ([Recent.tsx](src/renderer/src/Recent.tsx)) — 신규. 세션별 최근 플레이 기록 + 램프/DJ 레벨 변동 시각화. ohSorry 본체 게스트 페이지와 동일 표 형식.
  - `PLAYDATA` ([PlayData.tsx](src/renderer/src/PlayData.tsx)) — 신규. 시리즈 폴더 아코디언 (HTML exclusive accordion) + 검색 네비게이터 + 곡 단위 표 + SP/DP 토글 (지금은 hidden, 로직만 보존) + 배치 추천 토글 (gist `calcWeakness` 의 `chartStrengthMatch8Way`).
  - `RECOMMEND` — 기존 DP 탭의 추천곡 영역만 분리. 4번째 카드 추가 (아래).
  - `GRID` — 기존 dp12 서열표를 별도 탭으로. 제목 + zasa / ereter 출처 안내.
  - `ANALYSIS` — 기존과 동일.
  - default tab = `playdata`.
- **연습곡 추천 카드 (RecCard 4번째)** ([App.tsx](src/renderer/src/App.tsx)) — gist `recommend.js` 의 `buildWeaknessRecs` 결과를 기존 RecCard 디자인 그대로 표시:
  - 헤더 우측 인라인: `☆ [min] ~ [max]` zasa★ 범위 number input (5.9~12.7 clamp, placeholder 가 본체 `practiceZasaDefault` = 최대 클리어 zasa-1 ~ 최대 클리어 zasa).
  - 토글 줄: 패턴 (건반/CHARGE/SCRATCH/SOF-LAN) / N곡 / 손 (양/좌/우) / 강도 (가볍게/중간/강하게) — 너비 통일 + 우측 정렬.
  - 행: ★ 대신 **목표% (rate)** + 클릭 시 해시태그 줄에 `현재 EX → 목표 EX (목표 DJ Level)` + #해시태그.
- **본체 추천 알고리즘 100% 통합** ([recommendCore.ts](src/renderer/src/recommendCore.ts)) — 신규 helper. gist 의 `recommend.js` / `calcWeakness.js` / `normTitle.js` / `patterns-all-slim.json` / `rate-reference-slim.json` / `feature-scores-slim.json` / `textage-meta.json` / `series-name.json` 병렬 fetch + `createRecCtx({rows, ratingData, zasaData, ereterData})` → `recommend.js` 의 `createContext(deps)` 호출. EC/HC/EXH/weakness 모두 본체와 동일 결과.
  - 기존 INFOhSorry 자체 알고리즘 ([shared/recommend.ts](src/shared/recommend.ts)) 의 `buildRecs / buildExhRecs` 는 fallback 으로 유지하지만 1차 결과는 gist `recommend.js` 사용. EXH 추천이 본체와 다르게 안 뜨던 회귀 해소.
- **TSV safety guard** ([reflux.ts](src/main/reflux.ts) / [api.ts](src/renderer/src/api.ts)) — Reflux 의 tracker.tsv 가 옛 IIDX ID 의 데이터를 남긴 채 새 ID 로 로그인 시 supabase 에 옛 ID 데이터가 잘못 업로드되던 버그. memory scan 이 IIDX ID 변경 감지 → `truncate` (unlink 아닌, Reflux 의 watch handle 보존) 로 tracker 초기화.
- **로딩 스피너** — gist `calcOhsorryCore` 의 `compute()` 와 ohSorryWeb `renderProfileInto` 에 fixed top-right 회전 spinner 추가 (eagate 호환 — light host 는 transparent 배경).
- **해시태그 토스트 테마 분기** — gist `ohsorryRender.js` — `eagate.573.jp` 는 transparent 배경, 그 외 dark `#2a2a2a`.
- **곡명 클릭 DP 점프 비활성화 (RECENT)** ([Recent.tsx](src/renderer/src/Recent.tsx)) — RECENT 행 클릭 시 DP 탭 점프하던 동작 제거. role/tabIndex/onClick 모두 빠짐.
- **카드 그리드 wrap** — `repeat(3, minmax(0, 1fr))` → `repeat(auto-fit, minmax(360px, 1fr))`. 너비 < 360px 면 다음 줄로.

### 0.0.66 — supabase upsert_user_feature_score 28 dim 시그니처 매칭 (silent fail 해소)
- 배경: 2026-05-27 [migration_mirror_features.sql](../ohSorryAdmin/sql/migration_mirror_features.sql) 로 `user_ohsorry_radars` 에 18 dim (mirror 영향 STAIR_UP/DN_L/R + K1~K7 손별) 추가 + `upsert_user_feature_score` RPC 시그니처 11 → 29 인자 확장. 클라이언트 (INFOhSorry / ohSorry dbConn) 가 옛 11 인자만 보내서 PostgREST 가 함수 매칭 실패 (PGRST202) → silent catch 로 묻혀 user_ohsorry_radars 가 빈 채로 남던 버그.
- fix [Analysis.tsx](src/renderer/src/Analysis.tsx) `upsertFeatureScore` — 인자 11 → 29 확장. 새 18 dim (`p_os_stair_up_l/r`, `p_os_stair_dn_l/r`, `p_os_k1_l/r ~ p_os_k7_l/r`) 추가. vec 자체는 gist `calcWeakness.js` 의 `computePatternScoreVec` 가 새 `UPSERT_FEATS` (28 dim) 로 반환 — INFOhSorry 는 lib 갱신만으로 vec 28 dim 자동 (별도 변경 X).
- 짝 변경 (gist): `dbConn.js v0.0.410` (FEATS 28 + 29 인자 + `make_grid_data` 페이지네이션), `calcWeakness.js` (`UPSERT_FEATS` 28 dim).

### 0.0.65 — supabaseSync 가 ensure_song 호출 시 textage-meta lookup 으로 p_textage_song_id 전달
- 배경: songs cache stale 또는 norm 미세 차이로 옛 row 매칭 실패 → ensure_song 이 `series_no=99` 새 row 생성. 시간 지나면 누적되어 동명이곡이 series_no=99 로 분산.
- fix [supabaseSync.ts](src/renderer/src/supabaseSync.ts):
  - `TEXTAGE_META_URL` 상수 추가 — gist `c3da608.../textage-meta.json`.
  - `getTextageByTitle()` — textage-meta gist 한 번 fetch + cache. `norm(title)` → `textage_song_id` Map 빌드. 실패 시 빈 Map (= 기존 동작 fallback).
  - `ensure_song` 호출 직전 lookup → 매칭되면 `p_textage_song_id` 전달. RPC 의 `ON CONFLICT (textage_song_id)` 분기로 옛 row 와 자동 통합 → `series_no=99` 새 row 생성 안 됨.
- norm 동기화 [match.ts](src/shared/match.ts): `TITLE_ALIASES` 에 ohSorry normTitle v0.0.6 의 alias 추가 — `CROSSROAD ～Left Story～` (full-width tilde 변종), `Space Battleship S4TO ↔ S4TØ`, `メテオラ-meteor- ↔ メテオラ -meteor-` (공백 표기).
- 사전 조건: ohSorryAdmin `setup_song_master.sql` 의 `ensure_song(text, text, int, int)` 시그니처 (이미 적용됨).

### 0.0.64 — Analysis 탭 기여곡 표 곡 점수 = quantile score + 피처별 랭킹보기 토글 노출
- **기여곡 표 곡 점수 = quantile score** ([Analysis.tsx](src/renderer/src/Analysis.tsx)) — `FEATURE_SCORES_URL` 상수 추가, `useEffect` lib 로딩에 `feature-scores-slim.json` 같이 fetch (graceful) → `libsRef.current.featureScores` 저장 → `attachClickHandlers` opts 에 `featureScores` 전달.
  - 효과: Analysis 탭 기여곡 표의 곡 점수가 dbConn v0.0.407 백필과 같은 quantile score (0~100) 로 표시.
  - gist `analysisRender.js` v0.0.12 (`opts.featureScores` 지원) 와 짝.
  - fetch 실패 시 fallback (`c.pt`).
- **피처별 랭킹보기 토글 노출** ([Analysis.tsx](src/renderer/src/Analysis.tsx)) — ohSorryWeb 분석탭에 이미 있던 기능 (`analysisRender` v0.0.39+ 의 "랭킹보기" ↔ "스킬곡 보기" 인라인 토글) 이 INFOhSorry 에서는 `allUserScores` 미전달로 숨겨져 있던 회귀 해소.
  - `fetchAllUsersFeatureScores` 의 쿼리를 `user_ohsorry_radars` 직접 → `users` 테이블 + `user_ohsorry_radars` nested select 로 교체. `dj_name` 동시 fetch (랭킹 표 표시용).
  - `AllUserScoreRow` 타입에 `dj_name` 추가. state `allUserScores` 신설, percentile useEffect 에서 fetch 후 같이 `setAllUserScores`.
  - `attachClickHandlers` opts 에 `allUserScores` + `myIidxId` (하이픈 제거 — supabase 형식 일치) 추가 → "랭킹보기" 토글 자동 노출, 본인 row 강조.

### 0.0.63 — 분석탭 percentile 표시 (전체 유저 랭킹) + supabase upsert 형식 fix
- **percentile 계산 도입** ([Analysis.tsx](src/renderer/src/Analysis.tsx)) — `fetchAllUsersFeatureScores` (모든 user_ohsorry_radars 페이지네이션 fetch + 10분 cache) + `computeOsPercentilesFromList` (본인 myScore + allUsers → feature 별 `{ rank, total, percentile }`) 추가. 처음 1회 fetch + 10분 interval 자동 refetch. `opts.percentiles` 로 analysisRender 에 전달 → 분석탭 헤더 "X위 / Y명 · 상위 N%" 행 + 막대그래프 percentile 평균 대비 ± 표시.
  - 목록 UI 는 의도적으로 없음 (`allUserScores` 미전달) — analysisRender 의 "랭킹보기" 토글 버튼 자동 숨김. 순위 수치만 표시.
- **supabase upsert vec 형식 fix** ([Analysis.tsx](src/renderer/src/Analysis.tsx)) — 이전엔 `calcWeakness.calcUserWeakness` 의 잔차값 (-1~1) 을 그대로 `upsertFeatureScore` 에 넘김 → `user_ohsorry_radars` 컬럼이 다른 source (`backfill-pattern-score.js` / `ohSorry dbConn`) 의 chart_score 가중합 (0~1500) 과 형식 불일치 → INF user 의 헤더 score / percentile 부정확. 수정: `weaknessLib.computePatternScoreVec` (gist `calcWeakness.js` 신규 export) 호출 → backfill 과 동일 가중합 형식으로 upsert.
- gist `calcWeakness.js` 신규 함수들과 짝 — `computePatternScoreVec` (위) + `chartStrengthMatchByHand` / `chartWeaknessMatchByHand` (FLIP 배치 비교, 손 분리 vec `__vecL`/`__vecR` 활용 — 아직 호출처 0, 향후 사용).

### 0.0.62 — DP/SP 뷰어 페이징 추가 (렉 해소)
- [ChartTable.tsx](src/renderer/src/ChartTable.tsx) 가 전 row 한 번에 렌더하던 구조 → DOM 폭발로 렉.
- 페이징 도입: 페이지당 30/50/100곡 선택 (default 50), 표 하단에 페이저 UI (`«‹ N/M ›»`).
- 검색은 페이징 전 단계에 적용 → 검색어 입력 시 전체 row 에서 검색되고 그 결과만 페이징됨 (페이지 무관).
- 검색/필터/정렬/페이지사이즈 변경 시 자동으로 page=1 리셋.

### 0.0.61 — 분석탭 INF 필터 TSV 기반으로 전환 + supabaseSync 신곡 자동 등록
- **INF 필터 TSV 기반** ([Analysis.tsx](src/renderer/src/Analysis.tsx)) — 0.0.60 의 supabase `songs.ac/legen` 기반 필터는 데이터 정확도에 의존 (legen 값이 잘못 채워진 곡이 있어 LEGGENDARIA 미수록곡이 추천에 노출되던 회귀). TSV (INFINITAS 메모리 dump) 에 noteCount 있는 차트 = INF 수록이라는 정의로 전환 — `noteCountMap.has(title + '|' + diff)` 만으로 추천 필터. supabase 의존 제거, 정확도 100%.
- **supabaseSync 신곡 자동 등록** ([supabaseSync.ts](src/renderer/src/supabaseSync.ts)) — songs 마스터에 없는 INF 곡을 만나면 `ensure_song` RPC 자동 호출 → songId 받아서 cache + score row 작성. RPC 실패 시 graceful (기존처럼 unmatched skip). `autoEnsured` 카운트 로깅.
- 사전 조건: ohSorryAdmin/sql/setup_song_master.sql 의 ensure_song RPC 적용 (이미 적용됨).
- **norm 룰**: `shared/match.ts` 의 `TITLE_ALIASES` 에 `'CROSSROAD ~Left Story~' → 'CROSSROAD'` 추가 (INF 메모리 dump 가 부제목 포함하는 케이스).

### 0.0.60 — INF 수록 필터 LEGGENDARIA 차트 단위로 정확화 (`songs.legen` 활용)
- 0.0.59 의 `songs.ac & 2` 필터는 곡 단위만 판단 → "본곡은 INF 수록이지만 LEGGENDARIA 만 AC 전용" 케이스 (예: 鏡像都市 — `ac=3 legen=0`) 는 추천에 떠서 noteCount lookup 실패.
- fix: [supabaseSync.ts](src/renderer/src/supabaseSync.ts) songs cache 에 `legen` 컬럼 같이 fetch. `getInfChartChecker()` 시그니처를 `(title, chartName?)` 로 확장 — chartName === 'DP_LEG' 면 `legen & 2`, 그 외는 `ac & 2` 확인.
- [Analysis.tsx](src/renderer/src/Analysis.tsx) 의 `extraRecFilter` 도 `(c) => isInfChart(c.title, c.chartName)` 로 갱신.

### 0.0.59 — 분석탭 추천 INF 수록곡 필터 + 전 레벨 supabase scores 업로드
- **추천 INF 수록곡 필터** ([Analysis.tsx](src/renderer/src/Analysis.tsx)) — INF 유저 (iidx_id 첫 글자 알파벳) 면 supabase songs cache 의 `ac` flag (INF 비트 = 2) 활용해서 AC 전용 (INF 미수록) 곡을 추천에서 제외. 기존: AC 전용 곡이 추천에 떠도 INFOhSorry 의 TSV 에 없어서 noteCount lookup 실패 → "현재 → 목표 EXSCORE" 자리에 "목표 69%" 만 표시되던 회귀.
- **전 레벨 supabase 업로드** ([App.tsx](src/renderer/src/App.tsx)) — `tsvIdx` 빌드 시 `c.level !== 11 && c.level !== 12` 필터 제거 → lv1~10 / 13+ 차트도 supabase `scores` 테이블 업로드. m.charts (★ 추정 / 추천 풀) 는 `ratingData.ratings` 의 gameLevel===11||12 필터 별도 → 영향 없음.
- 의존: [supabaseSync.ts](src/renderer/src/supabaseSync.ts) 에 `getInfChartChecker()` export 추가 (songs cache 활용).
- 사전 조건: gist `analysisRender.js` 가 `extraRecFilter` 옵션 지원 (이미 push).

### 0.0.58 — Analysis 탭 HTML 빌더 gist 모듈화 (ohSorryWeb 과 공유)
- [Analysis.tsx](src/renderer/src/Analysis.tsx) 의 막대그래프 / 헤더 / 기여곡 / 추천곡 JSX 렌더링 로직을 모두 제거하고, gist 의 `analysisRender.js` (`window.OhsorryAnalysisRender`) 호출로 교체.
- 흐름: `attachClickHandlers(panelRef, opts, { onChartClick })` → 모듈이 panel 에 `innerHTML` + 클릭 위임. 곡 클릭 시 React 의 `onPickChart` 콜백 호출 (handlerRef 로 최신 props 참조).
- noteCount lookup 은 `noteCountResolver(songId, chartName, title, diff)` 로 추상화 — INFOhSorry 는 TSV `title + diff` 기반 lookup, ohSorryWeb 은 textage-meta `songId` 기반 lookup.
- 효과: 분석탭 UI 수정 시 gist `analysisRender.js` 한 번만 push 하면 ohSorryWeb + INFOhSorry 양쪽에 즉시 반영. INFOhSorry 측은 빌드/릴리즈 불필요.
- React 컴포넌트 코드 약 200줄 감소.

### 0.0.57 — Analysis 탭 React #310 (conditional hook) 검은화면 fix
- 0.0.55 / 0.0.56 에서 Analysis 탭 진입 시 lib 로드 완료 직후 검은화면 + 콘솔에 `Minified React error #310` (Rendered more hooks than during the previous render).
- 원인: [Analysis.tsx](src/renderer/src/Analysis.tsx) 의 `noteCountMap` `useMemo` 가 `if (!vecResult) return` early return 보다 아래에 있어서, 첫 렌더 (vecResult=null → early return) 와 다음 렌더 (vecResult 있음 → useMemo 호출) 의 hook 카운트가 달라짐.
- fix: `noteCountMap` `useMemo` 를 early return 위로 이동.

### 0.0.56 — Analysis 탭 gist fetch CSP 차단 fix
- 0.0.55 에서 Analysis 탭 진입 시 "Failed to fetch" 회귀.
- 원인: [src/renderer/index.html](src/renderer/index.html) 의 CSP `connect-src` 가 `'self' https://*.supabase.co http://localhost:*` 만 허용 → patterns / rateRef / calcWeakness / normTitle gist fetch 가 차단됨.
- fix: `connect-src` 에 `https://gist.githubusercontent.com` 추가.

### 0.0.55 — Analysis 탭 신규 + pattern vec supabase upsert + star upload 통합 (3분 주기) + ★ 클릭 재계산
- **신규 Analysis 탭** ([Analysis.tsx](src/renderer/src/Analysis.tsx)) — ohSorryWeb 분석탭 포팅.
  - mount 시 gist fetch (patterns-all-slim.json + rate-reference-slim.json + calcWeakness.js + normTitle.js)
  - SongChart (TSV) → calcWeakness chart 변환 (slot→diff, lamp→lampNum) + vec 계산 (rateRef 모드)
  - 막대그래프 (vec − userMean mix), feature 클릭 시 헤더 + percentile (supabase RPC `get_pattern_vec_percentiles`) + 기여곡 Top 5 (vRel 정렬) + 추천곡 Top 5 (vRel 회복량 + 자동 cutoff 단계 올림). TSV 의 noteCount 활용해서 "현재 → 목표 EXSCORE -차이" 표시.
  - 추천곡 풀: 사용자가 친 차트만 (TSV 안). NP 곡은 추천 X.
  - 곡 클릭 → DP 탭 + 해당 row 스크롤 (기존 `onPickChart` 재사용).
- **supabase pattern vec upsert** — `upsert_user_pattern_vec` RPC 호출. 처음 vec 계산 + 단일 timer 주기마다 (사전 조건: ohSorryAdmin `migrate_add_os_vec_columns.sql` + `setup_pattern_vec_rpc.sql` 적용).
- **단일 timer 통합** — `STAR_REFRESH_INTERVAL_MS` **1분 → 3분**. App 의 단일 timer 가 tsv 재로드 → star upload → vecRecomputeKey 증가 (Analysis 재계산 + pattern vec upsert) 순차처리. 별도 timer 제거.
- **★ 클릭 재계산** — [ProfileCard.tsx](src/renderer/src/ProfileCard.tsx) 의 `★X.XX` 클릭 시 tsv 재로드 트리거 (DB upload 없이 재계산만). 30초 cooldown (cursor `wait` + opacity 0.5). Browser remote 면 disabled.

### 0.0.54 — PC2 (LAN 원격) reflux 상태 실시간 push (SSE) + PC2 자동 업데이트 버튼 숨김
- **SSE**: 기존 PC2 의 `api.ts` 가 5초마다 `reflux:state` 를 polling → 곡 선택 진입 / tracker.tsv 갱신 시 최대 5초 delay.
  - `src/main/http-server.ts` 에 SSE endpoint `GET /api/events` (text/event-stream) 추가. `RefluxManager.on('state', ...)` 받아서 접속한 PC2 들에 broadcast. 연결 즉시 현재 state 1회 push (초기 sync). 15초 keep-alive ping (idle proxy 끊김 방지).
  - `src/renderer/src/api.ts` 의 `makeRefluxStatePoller` 를 `EventSource` 기반으로 교체. EventSource 가 끊김 시 자동 재연결 처리. 안전망으로 30초 polling fallback (영구 실패 / EventSource 미지원 / 옛 버전 PC1 케이스).
  - 효과: PC2 의 lamp / 곡 선택 / 메모리 라인이 PC1 변화 직후 즉시 반영.
- **PC2 자동 업데이트 버튼 숨김**: PC2 (브라우저 원격) 의 신버전 배너에서 "⬇ 자동 다운로드 + 실행" 버튼 제거 (`!IS_BROWSER_REMOTE` 조건 추가). PC2 에서 누르면 어차피 PC1 의 IPC 가 호출돼서 헷갈렸음 (그리고 bridge 가 막아서 에러 메시지만 떴음). 대신 PC2 에서도 "다운로드 페이지 열기 →" 링크는 항상 보이게 (PC1 가서 받든 PC2 에서 다른 용도로 받든 위치 안내).

### 0.0.53 — DP 노트레이더 ProfileCard 의 size 명시 제거 (0.0.52 누락 fix)
- `ProfileCard.tsx` 의 `<NotesRadar data={dpRadar} size={130} />` 에서 `size={130}` 명시 prop 제거. 0.0.52 에서 NotesRadar default 를 50 으로 바꿨지만 ProfileCard 의 명시 prop 이 default 를 override 해서 build 후에도 130 그대로 그려지던 버그 fix.

### 0.0.52 — DP 노트레이더 size 50 + 격자·spoke 부활 + 카드 padding 무시
- `size` 35 → **50** (ohSorryWeb 130 의 약 38%).
- `fontSize` 계수 0.08 → **0.0615** — ohSorryWeb (130 → 8) 와 동일 비율. size=50 → fontSize=3.
- **격자 + spoke 부활** — 외곽 6각형 + 50% 격자 + 6 spoke 가 다크 테마용 색 (`rgba(255,255,255,0.04~0.25)`) 으로 표시.
- `.profile-card-radar` 에 `margin: -12px -20px -12px 0` — profile-card 의 padding(12px 20px) 을 negative margin 으로 무시하고 카드 우측 가장자리까지 radar 가 차지.

### 0.0.50 — DP 노트레이더 크기 반으로 축소
- `NotesRadar` 의 `size` 기본값 70 → **35** (이전의 절반). 라벨 글씨 크기도 fontSize min 6 → 3 으로 함께 축소 (`Math.max(3, Math.round(size * 0.08))`). 프로필 카드 안에서 더 컴팩트한 표시.

### 0.0.49 — DP 노트레이더 시각화 ohSorryWeb 일치 + 호버 toast
- `NotesRadar.tsx` 를 ohSorry 본체 `ohsorryRender` 의 차트와 동일한 방식으로 재작성:
  - **시계방향 12시 시작 순서**: NOTES → PEAK → SCRATCH → SOF-LAN → CHARGE → CHORD (IIDX 게임 / eagate djdata 표준).
  - **격자 / spoke / 외곽선 모두 제거** — 데이터 폴리곤 fill 만. 가장 높은 지표의 색으로 채움 (NOTES 핑크 / PEAK 주황 / SCRATCH 빨강 / SOF-LAN 청록 / CHARGE 보라 / CHORD 초록).
  - **라벨 (지표별 컬러)** 평소 표시 — 데이터 폴리곤(opacity 0.55) 에 일부 가려지는 IIDX 표준 시각화.
  - `RADAR_MAX = 100` 시각 정규화 (실제 데이터 0~200 중 100 으로 over-driven 해서 폴리곤이 라벨을 덮는 효과).
- **호버 toast** — SVG 옆 (`left: calc(100% + 8px)`) 에 절대 위치. NOTES/CHORD/PEAK/CHARGE/SCRATCH/SOF-LAN 6 지표 (컬러 라벨 + 값) + 합계 레이더 스코어. opacity transition 0.12s.
- 차트 size 130 → 70 (ohSorryWeb 의 절반) — 프로필 카드 높이 유지.

### 0.0.48 — 프로필 카드에 SP/DP 단위 + DP 노트레이더 (SVG 6각형)
- 메모리에서 `iidxId` 감지 시 supabase 의 `user_radars` + `users` 를 병렬 fetch (`fetchUserPublic`). 메모리 리딩으로는 단위가 안 잡히는 케이스가 있어 supabase 저장값으로 보강.
- **DJ NAME 옆에 SP/DP 단위** (int → 한자 매핑 `12=皆伝 / 11=中伝 / 10~1=十段~初段 / 0=一級 / -8~-1=九級~二級`). SP/DP 둘 다 라벨은 항상 같이 표시하고, 값 없는 쪽은 `-` (예: `SP - DP 十段`). 둘 다 null 이면 단위 영역 자체 숨김.
- **단위 바로 오른쪽에 DP 노트레이더** (SVG 6각형, 새 컴포넌트 `NotesRadar.tsx`). 지표 순서 12시 시작 시계방향: NOTES / CHORD / PEAK / CHARGE / SCRATCH / SOF-LAN — eagate djdata / IIDX 게임 내 표기와 동일. row 없으면 영역 숨김. **마우스 호버 시에만 라벨 + 지표값 표시** (평소엔 차트만, 호버하면 NOTES 123.02 식으로). `.profile-card-info` 의 `flex: 0 1 auto` 로 단위 오른쪽에 차트가 딱 붙도록, `.profile-card-star` 의 `margin-left: auto` 로 ★ 는 오른쪽 끝.
- 데이터 채우는 주체: `ohSorryAdmin/getInfRadar.js` (eagate djdata 페이지에서 batch fetch). INFOhSorry 자체는 `user_radars` / `users.sp_rank` / `users.dp_rank` 어느 것도 업셋하지 않음 — `upsert_user` 호출 시 `p_sp_rank: null` / `p_dp_rank: null` 보내 RPC COALESCE 가 기존 값 유지 (주석으로 명세화).

### 0.0.47 — INFINITAS 미수록 차트 필터 (notInINF) + 미해금 곡 자물쇠 표기
- **INFINITAS 미수록 차트 필터** — `service-status.json` 에 `notInINF` 배열 추가 (`{ title, diff }`, diff 는 slot 표기 DPN/DPH/DPA/DPL):
  - 아케이드에는 있지만 INFINITAS 에 수록되지 않은 차트 (실제 플레이 불가) 를 추천 / DP 서열표 / supabase 업로드 / 통계에서 모두 제외.
  - main 의 `serviceStatus` fetch 경로 재사용 — 별도 gist 파일 없이 서버 토글과 한 곳에서 관리. 앱 부팅 시 fetch.
  - `App.tsx` 의 `dp12Match` / `dp12Charts` / `dp11Charts` 에 `notInInfSet` 필터 적용.
- **미해금 곡 자물쇠 표기** — 추천곡 중 미해금 차트 (`unlocked=false`) 는 곡명 앞에 🔒 표기 (추천 풀에는 그대로 유지). `RecCandidate.unlocked` 필드 추가.

### 0.0.46 — 추천곡 복습곡 토글 + 포터블 자동 업데이트 타입 정리
- 추천곡에 **복습곡 포함/제외 토글** 추가 (`recommend.ts` / `App.tsx` / `index.css`):
  - 복습곡 = reached 풀 (램프는 깼지만 DJ레벨 미달인 곡). 추천곡 헤더에 ✓/✔ 체크박스로 노출, EC/HC/EXH 3섹션 공통 적용, 기본값 "제외" (클리어램프 미달 곡만 추천).
  - `buildRecsWithPool` / `buildExhRecs` / `shouldDropFromRecs` 에 `djMode` 파라미터 추가 — `'off'` 시 reached 곡을 후보 풀에서 제외.
- 포터블 자동 업데이트 타입 깨짐 수정 — `UpdateInfo` 가 `updateCheck.ts` 와 `shared/types.ts` 에 이중 정의돼 어긋나 있던 것을 `shared/types.ts` 단일 정의로 통일 (`portableUrl` / `portableName` / `portableSize` 필드 추가).
  - `api.ts` 의 browser-remote bridge 에 `portable` polyfill 추가 (원격 접속은 자동 업데이트 불가 → reject/noop).
  - `portableUpdate.ts` 콜백 파라미터 타입 명시. `npm run typecheck` 통과 (기존 12개 에러 해소).

### 0.0.45 — Supabase 새 디비 (users + scores) 마이그레이션 + 강한 norm 통일
- `src/renderer/src/supabaseSync.ts` 마이그레이션:
  - 옛 RPC (`upsert_user_profile` + `upsert_user_chart_scores`) → 새 RPC (`upsert_user` + `upsert_scores`).
  - songs 마스터 캐시 (norm key → `[{ song_id, title, ac }]`) + ac flag `pickSongId` (INF=2 비트). 동명이곡 (raw 같은) 은 INF song 만 매칭.
  - 같은 PK `(song_id, iidx_id, diff, played_version=0)` 중복 row 안전망 dedup — best ex_score / lamp 유지 (PG 21000 "ON CONFLICT cannot affect row a second time" 회피).
  - `played_version=0` (INF), `sp_rank/dp_rank=null` (INF 메모리 신뢰성 X), `user_radars` 업로드 X (INF 데이터 없음).
- `src/shared/match.ts` 의 `norm` 강화 — ohSorry / ohSorryAdmin / ohSorryRating 의 normTitle v0.0.4 와 동일 매핑 (TITLE_ALIASES + NORM_OVERRIDES + denorm 추가). 동명이곡 (`ZEИITH` vs `Zenith` 등 4건) 자동 분리.
- ohSorry 와 같은 DB 공유 (`iidx_id text PK` 라 namespace 호환). 호출 측 (App.tsx 등) signature 변경 없음.

### 0.0.44 — user_profiles.charts_json 제거 + chart_score row 에 lamp 추가
- `supabaseSync.ts` 의 `payload.charts_json` → `null` 로 변경. user_chart_scores 가 single source of truth.
- `chart_score row` 빌드에 `lamp` 필드 추가 — 게스트 페이지 서열표가 user_chart_scores fallback (`get_user_charts` RPC) 으로 격자 렌더 가능.
- `api.ts` 의 browser-remote bridge (LAN 모드) 에 `serviceStatus` polyfill 추가 — 0.0.43 의 IPC 추가 분 반영.
- 효과: user_profiles 의 거대 jsonb (1376 chart × ~200B ≈ 270KB/user) 디스크 부담 제거. 게스트 페이지 / 곡별 랭킹 / ★ 추정 모두 정상 동작 (서열표는 chart_scores fallback 으로 렌더).

### 0.0.43 — service-status fetch 를 main 프로세스로 이동 (CORS 우회)
- 0.0.39~0.0.42 동안 `src/shared/serviceStatus.ts` 에서 renderer 가 직접 gist fetch 하던 구조 → renderer 의 Chromium CORS 정책으로 막힐 가능성 있어서 main 으로 이동.
- 다른 gist 사용 lib 들 (ereter / zasa / rating / osrLib / adopt) 과 동일 패턴 — fetch 는 main (Node fetch), IPC 로 renderer 에 전달.
- 신규: `src/main/serviceStatus.ts` + `'serviceStatus:get'` IPC handler + `window.infohsorry.serviceStatus.get()` preload expose.
- 효과: 사용자 PC 의 INFOhSorry 가 비로소 정상 fetch 가능 → INF 데이터 supabase upload 정상화.

### 0.0.42 — devtools 단축키 + service-status 캐시 제거
- `main/index.ts` 에 `Ctrl+Shift+I` 단축키 등록 (`webContents.before-input-event`) — prod 빌드에서도 사용자가 devtools 열 수 있게 (F12 는 INFINITAS 충돌 우려로 제외).
- `src/shared/serviceStatus.ts` 의 5분 메모리 캐시 제거 — 매 upload 직전 fresh fetch. 일시 fetch 실패가 5분 동안 영구 disabled 로 남던 문제 해소. github gist raw CDN 이라 rate limit 부담 무관.

### 0.0.41 — 마운트 시 readTsv 제거 (race condition 해소) + spawn 완료 시점으로 이동
- 마운트 시 옛 tsv 를 즉시 읽어서 화면에 표시하던 동작 (0.0.28 의 "재부팅 직후 화면 빔 해소") 제거 — race condition + stale 데이터 영구 노출 문제.
- 대신 Reflux spawn 완료 (state.spawned: false → true) 시점에 readTsv 1회 자동 호출. 1분 timer 도 그대로 유지.
- 효과: 부팅 직후 잠시 빈 화면 → spawn 완료 (10~30초) 후 자동 채워짐 → cleanup 된 깨끗한 tsv 만 표시.
- 0.0.22 의 race condition 보호 의도로 회귀 — 단 spawn 후 즉시 readTsv 라 UX 손실 최소화 (1분 timer 만 기다리지 않음).

### 0.0.40 — 새 supabase 프로젝트 (Tokyo) 로 이전
- `SUPABASE_URL` / `SUPABASE_KEY` 교체 — 기존 프로젝트 (`ryesiijulrlmstmhzpnv` / 미국) 가 Free tier 1GB 디스크 한계 초과로 crash recovery loop → 복구 불가 → 삭제 후 신규 (`cvxpeecxiawddmrzbdvn` / Northeast Asia Tokyo / Free) 로 이전.
- 데이터 손실 — user_profiles / user_chart_scores 비어있음. 자동 업데이트 후 INFOhSorry 사용 시 자기 데이터 다시 upload 됨.
- service-status.json kill-switch 는 그대로 유지 — 다음 사고 대비.

### 0.0.39 — 원격 service-status.json kill-switch
- gist (`30c3ba6f87df9847291c42ea216a8d2a`) 의 `service-status.json` 으로 supabase upload 원격 toggle.
- `src/shared/serviceStatus.ts` 신규 — `fetchServiceStatus()` + 5분 메모리 캐시 + **fail-closed** (fetch 실패 시 disabled).
- `supabaseSync.ts` 의 `uploadProfile` 시작에서 status 확인 — `uploadEnabled === false` 면 upload skip.
- 풀 때는 gist 의 `service-status.json` 만 `uploadEnabled: true` 로 toggle 하면 5분 이내 반영. 코드 / 빌드 변경 없음.
- 의도: supabase 자원 한계 / 점검 시 모든 사용자 INFOhSorry 의 upload 를 원격에서 일괄 막기.

### 0.0.38 — INF 곡별 랭킹 업로드 보정
- 곡별 랭킹 업로드 전 `slot` 값이 `DPN/DPH/DPA/DPL` 인 DP 차트만 필터링.
- 같은 업로드 묶음 안에서 `(played_version, iidx_id, title, diff)` 가 중복되는 row 는 EX 점수가 높은 기록 1개만 남겨 `ON CONFLICT DO UPDATE` 중복 충돌을 방지.

### 0.0.37 — 곡별 랭킹 DB 업로드
- Supabase `user_chart_scores` 업로드 추가 — `exScore > 0` 인 차트를 `played_version='INF'` 로 곡별 점수 테이블에 동기화.
- 게스트 서열표의 곡별 랭킹 모달이 INF 점수도 조회할 수 있도록 `title / diff / gameLevel / level / djLevel / exScore` 를 함께 저장.

### 0.0.36 — 추천곡 DP12/DP11+ 토글 + ★ 모드 서열표 표기 개선
- **추천곡 헤더에 `DP12 / DP11+` 토글 추가** — `recLevelMode` 를 state 로 빼고 사용자가 직접 전환 가능. 토글 시 EC/HC/EXH 모두 새로 뽑힘 (reroll trigger). 기본값 `DP12`.
- **★ 모드 서열표 (별 난이도 탭) 의 곡명 표기 개선**:
  - 곡명 앞 prefix 가 `EC` / `HC` / `EXH` (vType 라벨) → **게임 LEVEL + 채보 약자 (`11H` / `11A` / `12A` / `12L`)** 로 변경 — 곡 자체의 차트 정보를 직접 표시
  - 곡명 색상이 vType 으로 분기: **EC 연두 (#7bc16a) / HC 기본색 / EXH 금색 (#dcaf45)**. prefix 도 같은 색.
  - `★ 모드 서열표 한 그룹 안에 lv11 / lv12 의 N/H/A/L 차트가 섞여 있을 때 한 눈에 구분 가능.
- DP12 / DP11 탭의 표기는 그대로 (LEGGENDARIA `†` 마크 유지).

### 0.0.35 — 추천곡 로직 v3.3.5 포팅 (under/reached × hard/easy/cleanup)
- **추천곡 로직 전면 갱신** — ohSorry v3.3.5 의 `buildPools` / `buildRecs` / `buildExhRecs` 를 `src/shared/recommend.ts` 로 이식. 기존 3-pool (하드 / 약도전 / 정리) 구조를 6 버킷 (under/reached × hard/easy/cleanup) 으로 확장.
  - **under** (lampNum < threshold) — 해당 stage 미클리어 곡
  - **reached** (isReachedLamp + !isAccuracyOK) — stage 깼지만 DJ Level 미달인 곡. 정확도 개선 여지 있는 곡을 추천에 포함. (예: HC 깼는데 AA 미달, EXH 깼는데 AAA 미달)
  - **6 SLOT** — `under.hard 1 + reach.hard 1 / under.easy 2 + reach.easy 2 / under.cleanup 2 + reach.cleanup 2`. SLOT 부족 시 같은 분류의 반대 카테고리에서 fallback, 그래도 모자라면 전체 풀에서 보충
- **EXH 정렬 변경** — `missCount asc` → `rate(=exScore/(noteCount*2)) desc`. "거의 통과한 곡" 우선 표시 (`lampNum>=6 && djLevel==='AAA'` 제외, `exScore===0` 더티 제외, `11.6 ≤ level ≤ 12.7` 필터)
- **recLevelMode** — `baseStar≥6` 시 `lv12` (lv11 차트 제외), 미만이면 `all`. 호출부에서 자동 결정
- **refreshRecs** — tracker.tsv 갱신 시 picked / pool 갱신 로직을 `shouldDropFromRecs` 헬퍼로 정리. EXH 의 `rate` 도 갱신 시 재계산
- 신규 헬퍼: `shouldDropFromRecs`, `compareRateDesc`, `isReachedLamp`, `isAccuracyOK` (모두 `recommend.ts` 에서 export). `RecCandidate.category` 값 호환 유지 → UI 변경 불필요

### 0.0.34 — oldOSR gist fetch + adopt.js (v335E 채택 분기 통합 lib) 도입
- **oldOSR.js gist fetch 추가** — 기존엔 자체 dp12StarAll (4-scope max) 으로 계산했는데, ohSorry/recompute 의 `oldOSR.inferUser` 와 알고리즘이 미세 차이라 ★ 가 어긋났음. `src/main/osrLib.ts` 에 oldOSR.js gist fetch + cache 추가, App.tsx 에서 로드 + `oldOSRResult` 산출. dp12StarAll 은 DpTable UI 의 4-scope detail 표시 용으로 유지.
- **adopt.js 도입** — v335E 채택 분기 (group A/B/C base 결정 + group C 2-scope max + OSR135 spread gate + under-blend + 12.5~13.5 blend) 를 ohSorry / recompute / INFOhSorry 가 모두 동일 lib 로 호출하도록 통일.
  - INFOhSorry 측은 `src/shared/adopt.ts` TS bundle (osr.js 와 동일한 bundle + cache override 패턴) 으로 도입. 첫 부팅 / 오프라인에서도 작동, gist 가 더 최신이면 cache override.
  - `dp12StarResult` useMemo 가 단순 `adoptFn(input)` 호출로 정리됨. inline 분기 로직 제거.
- 효과: ohSorry / recompute / INFOhSorry 의 ★ 가 동일 입력에서 동일 출력. 예: group C 케이스에서 5.220 vs 5.167 차이 해소.
- **DpTable 서열표 stack bar 위치 변경** — 서열표 제일 하단 → 색상 박스 라벨 (lamp-legend) 위 (서열표 최상단) 로 이동. 캡처 출력 순서도 일치 (stackbar → legend → grid).
- **`.dp-stackbar` bottom margin 제거** — `margin-bottom: 16px` → `0`. 최상단 이동 후 legend 와의 간격이 위아래 동일해서 시각적으로 불편 → 아래 마진 제거 (게스트 페이지 ohsorry-shelf v0.0.17 과 동일 처리).

### 0.0.33 — DpTable rename + Reflux healthCheck dynamic interval
- 컴포넌트 rename: `Dp12Table` → `DpTable` (파일/컴포넌트 이름 + CSS prefix `dp12-*` → `dp-*`, 총 111곳)
- `RefluxManager.startHealthCheck`: tsv 첫 로드 전까지 30초 간격 → 첫 로드 후 5분 간격으로 자동 전환 (`transitionHealthCheckToSteady`)
- INFOhSorry 가 IIDX INFINITAS 보다 먼저 떠도 Reflux 첫 회복까지 5분 → 30초로 단축

### 0.0.32 — OSR 모델 v0.0.6 (Group C lv11 HC/EXH + Group A 보정 + BAND 확장)
- `src/shared/calc-osrating.ts` 의 모델 동작 업데이트:
  - **Group C** scope 에 `lv11Weight: 0.1` — lv11 차트의 HC/EXH stage 가 0.1 가중치로 fitData 진입. lv12 천장 효과 영역 (★13+) 변별력 보강 (★13~14 MAE 0.403 → 0.234)
  - **Group A** 에 `BAND_CORR_A` 보정 신규 — A scope (zasaMin=10.2) raw 가 ★3~8 영역에서 over-estimate 끌어내림, A → B 전환 점프 완화
  - **BAND** 5 → 15 — 그룹 경계 blend 영역 25~35 → 15~45 로 확장, smooth transition
- ohSorryRating 의 osr.js v0.0.6 과 동기
- 동작은 자동 적용 — 별도 설정 변경 없음

### 0.0.31 — 곡명 정규화 Æ → a 매핑 (ÆTHER 매칭)
- 클라이언트가 `&AElig;` HTML entity decode 실패해서 `ÆTHER` 를 `ATHER` 로 전송하는 케이스 호환 — `src/shared/match.ts` 의 norm 함수에서 `Æ`/`æ` 를 `ae` → `a` 로 변경
- zasa 의 `ÆTHER` (DP12 ANOTHER lv11 / LEGGENDARIA lv12.1) 가 정상 매칭됨
- 다른 단어에 `ATHER` substring 들어있어도 충돌 X — norm 전체 key 완전 일치만 매칭

### 0.0.30 — OSR 모듈 이름 변경 (calc-OSRating → osr / calc-Old-OSR → oldOSR)
- gist 의 외부 ★ 추정 lib 두 개 이름 변경 — `calc-OSRating.js` → `osr.js`, `calc-Old-OSR.js` → `oldOSR.js` (ohSorryRating 프로젝트의 산출물명 통일)
- 클라이언트 측 (osrLib.ts, App.tsx, ProfileCard.tsx 등) 의 require / fetch URL 일괄 갱신 후 재빌드
- 동작/모델 자체 변경 없음 — 이름만 정리

### 0.0.29 — portable 자동 업데이트 시 같은 폴더 옛 portable 정리
- 자기 실행 파일이 `ohSorryScoreINF-X.X.X-portable.exe` 패턴이면 같은 폴더 안의 다른 같은 패턴 파일들을 자동 unlink (`portableUpdate.ts` `cleanupOldPortables`)
- 같은 폴더의 사용자 다른 파일은 절대 안 건드림 — 패턴 정규식 (`^ohSorryScoreINF-\d+\.\d+\.\d+-portable( \(\d+\))?\.exe$`) 으로 자기 portable 만 한정
- 0.0.21 의 `cleanupOldUpdates` 제거 결정 (Downloads 폴더 사용자 파일 보호) 을 **portable-only** 로 다시 활성화
- 설치형 (NSIS) 으로 실행된 케이스는 `process.execPath` 가 패턴 비매칭 → skip

### 0.0.28 — Reflux tracker.tsv cleanup 을 첫 spawn 1회만 실행
- 기존: `spawnReflux()` 가 매번 `cleanupPreviousSession()` 호출 → 앱 재시작 / health check 자동 재spawn / "데이터 불러오기" 재클릭마다 `tracker.tsv` / `tracker.db` / `sessions/` 삭제. 사용자가 INFINITAS 안 켠 상태로 앱만 켜면 데이터 매번 비워지는 문제
- 수정: `cleanedUp` flag 추가 — process lifetime 의 **첫 spawn 1회만** cleanup. 이후 재spawn 은 tsv 보존. `killAllRefluxProcesses` 는 file lock 해제 위해 매번 그대로 호출
- App.tsx 마운트 시 `spawned=false` 라도 이전 tsv 가 살아있으면 일단 `readTsv` 해서 화면에 띄움 → 이후 `start()` 로 새 spawn 진행 (재부팅 직후 곡 선택 진입 전까지 화면 빔 해소)

### 0.0.27 — supabase charts_json 합치기 누락 수정 (lv11/12 전곡 등재)
- `supabaseSync.ts` payload 가 `charts_json: charts` 만 보내고 `unclassifiedCharts` 는 destructure 만 하고 사용 안 하던 누락 — 0.0.23 entry 의 의도와 실제 코드 불일치
- `[...charts, ...(unclassifiedCharts ?? [])]` 로 수정 → tsv lv11/12 전곡 (ratingData 미등재 신곡 + zasaLevel > 12.7 보스급 포함) 이 게스트 서열표에 보임
- lamp 통계 (`n_played_lv12` 등) 는 그대로 — `m.charts` 만 ★ 추정 풀

### 0.0.26 — v335E 채택 분기 (spread gate)
- **OSR135 신뢰도 게이트** — OSR135 세 분기 (EC/HC/EXH) 중 0(데이터 없음) 제외, `max-min spread > 2.5` 면 OSR135 내부 불일치로 판단 → 신뢰 X, baseStar2 직행. (LISASU 같은 하드 특화 / `33055059` 같은 OSR135 폭주 케이스 잡음)
- **블렌드 구간 13.5 로 확장** — 기존 `≥13.0 직행, 12.5~13.0 블렌드` → `≥13.5 직행, 12.5~13.5 블렌드`. 14+ 정확도는 그대로 (0.014).
- **블렌드 안 gap guard** — `osr > osr135` 면 블렌드가 위로 끌어올리므로 OSR135 직행. blend 결과 ↔ OSR135 를 `gapW = clamp((osr135-osr)/3)` 로 가중 — gap 작으면 끌어내림, 크면 (osr 망가짐) OSR135 직행.
- 1021명 검증: 13.0+ 0.116 → 0.134 (+0.018, 13~14 의 진짜 고렙 일부도 같이 끌려서), 12.5+ 0.178 → 0.167, 12.0+ 0.232 → 0.221, 10.0+ 0.244 → 0.222 — **12.5 이하 전 구간 개선**.

### 0.0.25 — 곡명 hover 효과 밑줄 → 볼드
- 클릭 가능한 곡명 (DP/SP 표 `.ct-title`, 서열표 `.dp12-song`) hover 시 밑줄 대신 **볼드** 처리

### 0.0.24 — 서열표 그룹 스택바 위치 복원 (제일 왼쪽)
- 그룹별 lamp 분포 색박스 스택바를 난이도 라벨 오른쪽 → **제일 왼쪽**으로 복원 (`.dp12-group` 컬럼 순서 + Dp12Table JSX 순서)

### 0.0.23 — 서열표 '미분류' 곡 supabase 업로드
- **서열표 미분류 곡 charts_json 업로드** — 게스트 페이지 (ohsorry.vercel.app) 서열표에서 INF 유저의 '미분류' 곡 (ohSorryRating.json 미등재 — 신곡 등) 이 안 보이던 버그 수정
  - 기존엔 `dp12Match.charts` (ratingData 등재곡만) 만 `charts_json` 으로 업로드 → 미등재 곡은 게스트가 받을 데이터 자체가 없었음
  - 플레이했지만 미등재인 lv11/12 곡을 `unclassifiedCharts` 로 따로 모아 `charts_json` 에 합쳐 업로드 (`level` 없음 → 게스트는 zasa★ fallback / 미분류 그룹)
  - 추천 풀 / ★ 추정 / lamp 통계엔 미포함 — 서열표 표시에만 영향
- INFOhSorry 자체 서열표는 기존에도 정상 표시 (이번 변경은 게스트 페이지용 업로드 데이터에만 영향)

### 0.0.22 — v3.3.5 (D3) 채택 분기 재정의 + OSR / OSR13.5+ 모델 개선
- **채택 분기 D3** (1021명 검증 영역별 최강 lib 기준): `OSR135 ≥ 13.0 → 무조건 OSR135` / `12.5~13.0 → OSR135↔group값 선형 보간` / `< 12.5 → group 별 base`
  - group A·B → OSR
  - group C → OSR값 ≥ 11.0 이면 OSR (11~13 은 OSR 가 최강), < 11.0 이면 oldOSR, 10.5~11.0 보간
- **OSR / OSR13.5+ lib 개선** (gist 자동 갱신 — 재시작 시 적용):
  - `osr.js` v0.0.5 — bandCorr 선형 보간 / 그룹 경계 soft transition / nativeStar shrinkage / ASSIST 제외 / M feature top-3 평균 + 재학습
  - `OSR13.5+.js` v0.0.3 — bonus down-scale (14+ 0.014 유지 + 저렙 over-estimation 억제)
- 1021명 검증: D3 분기 누적 MAE 10.0+ **0.244** (v3.3.4 0.291 대비 -16%), 13.0+ **0.116**
- **tsv 읽기 순서 수정** — 처음 실행 시 `readTsv` (자동 복원) 가 `startAll` 의 `cleanupPreviousSession` (이전 세션 tracker.tsv 삭제) 보다 먼저 실행돼 stale / 다른 계정 tsv 를 읽던 race condition 해소. `spawned=false` (처음 실행) 면 readTsv 스킵 → cleanup → spawn 후 1분 timer 가 새 tsv 읽음

### 0.0.21 — 자동 다운로드 저장 위치를 Downloads 폴더로 변경
- **자동 다운로드 받은 portable .exe 가 영구 보존** — 이전엔 `userData/updates/` 임시 저장 후 부팅 시 정리되어 실행만 되고 사라짐 (옛 portable 이 그대로 남아 다음 부팅 시 옛 버전 실행되는 문제) → 이제 **Windows Downloads 폴더 (`%USERPROFILE%/Downloads`)** 에 영구 저장
- 동일 파일명 존재 시 ` (1)`, ` (2)` 식으로 unique 접미사 자동 추가 — 사용자의 기존 다운로드 덮어쓰지 않음
- `cleanupOldUpdates()` 제거 — Downloads 폴더의 사용자 파일을 건드리면 안 되므로

### 0.0.20 — 모바일 / PC2 호환성 보강
- **모바일 추천 영역 가로 스크롤 수정** — grid `minmax(0, 1fr)` + `min-width: 0` + `overflow: hidden` 안전망 추가. children intrinsic min-width 가 grid 를 넘치게 하던 이슈 해소
- **DP/SP 탭 곡명 클립보드 복사 — PC2 (non-secure context) 지원** — `navigator.clipboard` 가 차단되면 `document.execCommand('copy')` + 임시 textarea fallback 자동 시도. LAN IP / `http://` 접속에서도 동작

### 0.0.19 — v3.3.5 (OSR13.5+ + 추천 풀 재설계 + UI 확장)
- **OSR13.5+.js lib 추가** — bin50 + 50% 임계 + 상향 bin 부분 보너스. 14+ user MAE 0.014, 13+ MAE 0.107 (이전 ensemble 대비 압도)
- **분기 D2 채택**: `OSR135 ≥ 13.0 → OSR135 / group A·B → OSR / group C → oldOSR / fallback → OSR`. ohSorry 와 동일한 분기로 통일. (oldOSR + OSR) / 2 ensemble 폐기
- **OSR13.5+ 자동 갱신** — main process 가 gist 에서 fetch + userData/libs/ 캐시 (OSR 패턴 동일)
- **group C 의 oldOSR 4종 max 에서 `all-11.6+` scope 제외** — group C 고수에게 lv11 추정 보강이 잡음으로 작용. `ereterOnly` / `lv12Only` 중 max 로 재계산
- **추천 풀 재설계** — 풀 자체를 `ohSorryRating.json` 등재곡으로 한정. 내부 평가는 ratingMap estimates, UI 표시는 ereter 실측 (있으면) → 추정 fallback
- **추천 baseStar 분리** — D2 표기 ★ 와 별개로 추천은 OSR (v0.0.2) 단독값 사용 (OSR135 의 12점대 over-estimation 회피)
- **ProfileCard 보조 ★** — 기존 oldOSR 4종 2nd → OSR 값 표시로 교체
- **zasa-data sakura + gist 합치기** — sakura ☆12 page 가 부분 출력일 때 gist 풀데이터 (~2045곡) 로 보강 → 서열표 미분류 lv11 -47% (147→78)
- **서열표 (Dp12Table) UI 강화** — 난이도 셀 왼쪽에 그룹별 lamp 분포 세로 stackbar (FC 가 아래로), 정렬에 DJ Level 순 asc/desc + 램프 순 asc/desc 토글, SongCell 우측에 DJ Level 오버레이 (곡명이 그 뒤로 가려짐, NP 곡도 영역 유지)
- **추천곡 / 서열표 곡명 클릭** → DP 탭 이동 + 검색 자동 입력 + 난이도 필터 자동 적용
- **DP/SP 탭 곡명 클릭** → 곡명 클립보드 복사 (secure context 한정)
- **모델 내부 디버그 JSON** — "tsv ↔ ohSorryRating 미매칭" / "서열표 미분류곡" 목록 클립보드 복사 + 파일 다운로드 버튼
- **CSP `'unsafe-eval'` 허용** — gist 의 OSR lib 동적 eval 위해 필요 (이전엔 차단되어 캐시 발동 X)
- **ChartTable 필터 row 순서 조정** — LV 먼저, Hide Locked / Reset 뒤로 → wrap 시 LV 가 위, 컨트롤이 아래로 자연 배치
- 1021명 검증: 전체 MAE 0.398 → **0.363**, max\|err\| 6.989 → **4.264**, 14+ MAE 0.101 → **0.014**, 13+ MAE 0.377 → **0.121**

### 0.0.18 — v3.3.4 ensemble + OSR lib 자동 갱신 + supabase 업로드 확장
- **v3.3.4 ensemble** — 사용자 ★ = (oldOSR v3.3.3 + OSR v0.0.2 tiered) / 2 평균. OSR (osr.js) 을 INFOhSorry 에 bundle, `inferUserTiered` 사용 (그룹별 scope + band correction)
- **osr.js 자동 갱신** — 매 부팅 시 main process 가 gist 에서 fetch + userData/libs/ 캐시. version 비교해서 더 최신이면 renderer 가 eval → window override. bundle 은 fallback. 모델 업데이트 시 INFOhSorry 재빌드 불필요
- **ohSorryRating 캐시 정책 변경** — 24h TTL 제거, **매번 fetch + 실패 시에만 캐시 fallback** (gist 다운 / 오프라인 대응)
- **EXH 추천 범위 조정** — `[baseStar - 2, baseStar + 1]` 로 변경. 실력 +1 까지 도전 허용, 실력 -2 미만은 제외 (너무 쉬운 곡 컷)
- **UI 정리** — tracker.tsv 로드 후 Reflux 로그 자동 숨김, `ENOENT` / `no such file` 에러 화면 표시 제거 (조용히 무시)
- **supabase 업로드 확장**:
  - `charts_json` 에 **DP lv11/lv12 전곡 포함** (이전: ereter 매칭곡만)
  - 각 chart 에 `gameLevel` / `zasaLevel` 명시
  - Reflux TSV 의 모든 정보 추가: `unlocked` / `exScore` / `noteCount` / `djPoints` / `songType` / `songLabel`
  - 신곡 추정 / 통계 분석 데이터 풍부해짐

### 0.0.8 — 매칭 / 캐싱 안정화 + zasa 보충
- **norm() 강화로 추가 매칭** — 16곡 (이전 미매칭) 신규 매칭. 따옴표 변종 (U+201C/D, U+2019), `Ø`/`ø`, `Æ`/`æ`, `ə`, 키릴 homoglyph (`И` → `n` 등), 라틴 디아크리틱 (`Ü`→u, `ê`→e), `♥` `♪` `※` `→` `∮` `†` 등 장식 기호 제거
- **zasa.sakura.ne.jp 보충 데이터** — Electron main process 가 직접 fetch (24h 캐시). ereter 미등록 ☆12 차트가 DP12 격자에서 미분류 row 에 갇히던 문제 해결 → zasa 의 ★ 으로 자동 분류
- **추천곡 캐싱 방어 강화** — 일시적 매칭 변동 시 추천 목록이 바뀌던 문제 (특히 PC2 LAN) 해결. `refreshRecs` 가 chart 못 찾으면 이전 rec 보존, 클리어된 곡만 명시적 제거 + 그만큼만 풀에서 보충
- **미매칭 진단 도구** — 모델 내부 details 안에 `📋 JSON 복사` / `💾 JSON 저장` 버튼. 각 미매칭 곡마다 ereter 후보 (다른 diff 가능성) 정보 포함

### 0.0.7 — 추천곡 로직 개편 (v3.2.10 모델)
- **추천곡 캐싱** — `tracker.tsv` 갱신돼도 추천 목록 자동 변경 X. ↻ 버튼 누를 때만 새로 뽑음
- **클리어 램프 자동 반영** — 추천곡 중 한 곡이 클리어되면 목록에서 제거 + 보관 풀에서 보충 (최대 10곡 유지)
- **9곡 미만 시 다시 받기 버튼** — 풀 소진으로 picked 가 9 미만으로 떨어지면 카드 하단에 안내 버튼 표시
- **도전곡 범위 동적 계산** — ★0.5 사용자 → +1.2 까지, ★14.0 사용자 → +0.3 까지 (선형 보간). 저레벨엔 풍부한 도전곡, 고레벨엔 좁은 범위
- **6:4 비율 고정** — 도전 6 + 정리 4 (저레벨 3:7 분기 제거)
- **풀 샘플 20 → picked 10 + pool 10** — 도전 10 / 정리 10 후보 중 picked 10곡 표시, 나머지 10곡은 보충용 보관
- **카운트 desc top 5 + 랜덤 5 = 후보 10** — 도전 / 정리 각 풀에서 클리어 인구수 desc top 5 + 나머지 랜덤 5
- 모델 버전 표기 v3.2.9 → **v3.2.10** (★값 추정 자체는 동일, 추천 로직만 정리)

### 0.0.6 — 추천곡 / 정렬 UI 정리
- **추천곡 row 디자인 통일** — PC / 모바일 동일한 flex 레이아웃: `[title] [lamp] [★star · ☆level] [diff letter]`
- ↑/↓ 도전/정리 indicator 제거. lamp / star / level 무채색, **난이도 letter (A/H/N/L) 만 색상 유지**
- **추천곡 카드 박스 제거 (모바일)** — 박스 없이 헤더 + 행만. PC 는 카드형 유지하되 항상 3열 고정
- **PC 추천곡 collapse 기능 제거** — 항상 펼친 상태. 모바일만 collapse 가능 (기본 접힘)
- **카드별 ↻ 다시 뽑기** — 기존 전역 버튼 1개 → EC / HC / EXH 별 개별 버튼
- **카드 제목 색 분리** — `EASY 클리어 추천` 에서 "EASY" 만 색상, "클리어 추천" 은 검정
- 카드 사이 빈 줄 제거 (모바일 gap: 0)
- **추천곡 빈 메시지** — "현재 ★값 근처의 추천곡이 없습니다."
- **모바일 정렬 UI** — 버튼 박스 → 텍스트 only `LAMP | LEVEL | MISS`. 필터 영역 하단 우측 정렬
- **body 배경 흰색** — 옅은 회색 `#fafbfc` → `#fff`
- **Reflux health check 안정화** — `tasklist` 절대 경로 사용 + 실패 시 alive 로 가정 (PATH 의존 제거 + 무한 spawn 방지)

### 0.0.5 — 모바일 페이지 개선
- **SP / DP 차트 표 2줄 레이아웃** — 한 행을 2줄로 분리. lamp 색박스 / LV 가 2줄 다 차지, 1줄 = title / SCORE 값, 2줄 = rate-bar / MISS 값
- **SCORE / MISS 라벨 + 값 컬럼 분리** — col 4 라벨, col 5 값 (60px 고정 너비) → 자릿수 무관 우측 끝 정렬
- **NO PLAY / 잠김 일 때**: SCORE 자리에 lamp 텍스트 ("NO PLAY" / "잠김") 표시
- **Rate 텍스트 우측 정렬 + 순서 뒤집기** — `(64.70%)B` 형식
- **모바일 정렬 버튼** — 컬럼 헤더 클릭이 안 되니 [램프순 / 레벨순 / 미스순] 버튼 row 항상 표시. miss 는 오름차순 우선, 나머지는 내림차순 우선
- **필터 기본 접힌 상태 시작** — 필요할 때만 펼침
- **추천곡 카드 collapsible** — 모바일은 기본 접힘, 데스크탑은 기본 펼침. summary 클릭으로 토글
- **DP12 서열표 모바일** — 레벨이 헤더 row, 곡 목록은 3열 균등 grid
- LV / 색박스 padding 조정으로 행 높이 컴팩트

### 0.0.4
- **모바일 반응형 (1차)** — LAN 모드로 폰 / 태블릿 접속 시 글씨 / 버튼 크기 / 레이아웃 자동 조정 (768px / 480px breakpoint)
- 입력 필드 16px 폰트 — iOS Safari 자동 확대 방지
- viewport meta 추가
- **1시간 stale 체크 제거** — Reflux 가 설치돼있으면 앱 시작 시 무조건 자동 실행
- **중복 spawn 방지** — 이전 세션의 Reflux.exe 가 살아있으면 새로 spawn 하지 않고 health check 만 시작

### 0.0.3
- productName 통일 — `ohSorryScoreINF`
- 5분 주기 health check — Reflux.exe 가 죽으면 자동 재시작
- 4단계 진행 바 → 인라인 스피너 + 한 줄 상태 텍스트로 단순화
- "TSV 직접 선택" / "폴더 열기" 버튼 제거. "데이터 불러오기" 버튼은 데이터 없거나 미설치일 때만 표시

### 0.0.2
- 초기 안정 릴리즈