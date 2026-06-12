# 데이터 흐름 — 외부 소스 캐시 / 추천 코어 / Supabase 동기화 / LAN 원격제어

> 외부 데이터(ereter/zasa/rating/spTier)가 어떻게 캐시되고, gist 추천 코어가 어떻게 통합되며, Supabase 에 무엇이 어떤 주기로 올라가고, LAN 원격제어가 어떻게 동작하는지를 다룹니다.
> 상위 조망: [`../../docs/INFOhSorry.md`](../../docs/INFOhSorry.md) · 인덱스: [README.md](README.md)

---

## 0. 전체 그림

```
 INFINITAS 메모리 ──(Reflux)──> tracker.tsv ──(tsv:read IPC)──> SongRow[]  (renderer)
                                                                    │
        ┌──────────────── 외부 데이터(main fetch + 캐시) ───────────┤
        │ ereter / zasa / rating / spTier / serviceStatus / offsets │
        └───────────────────────────────────────────────────────────┤
                                                                    ▼
   gist 코어(renderer fetch+eval) ──> recommendCore / 별값 lib ──> 추천/별값/분석
                                                                    │
                                            ┌───────────────────────┤
                                            ▼ (3분 주기, host 전용)  ▼
                                     Supabase scores            Supabase user_ohsorry_radars
                                     + users (upsert_user)      (upsert_user_feature_score)
```

데이터 소스의 종류와 위치 정리(공유 인프라 상세는 상위 조망 [`../../docs/README.md`](../../docs/README.md#공유-인프라)):

| 소스 | 어디서 fetch | 캐시 | 용도 |
|------|--------------|------|------|
| `tracker.tsv` | Reflux(자식 프로세스) | 디스크 파일 | 곡/점수 원천 |
| ereter.net perlevel | main(`ereter.ts`) | `userData/ereter-data.json` TTL 24h | DP12 ★ EC/HC/EXH diff(표시 별값 기준) |
| zasa.sakura | main(`zasa.ts`) | `userData/zasa-data.json` TTL 24h | DP12 격자 미분류 fallback |
| ohSorryRating.json(gist) | main(`rating.ts`) | `userData/ohSorryRating.json` TTL 24h | ereter 미등록 lv11/12 추정 → 추천 풀 |
| SP ☆12 서열표(구글시트) | main(`spTier.ts`) | `userData/sp-tier-12.json` TTL 24h | GRID 의 SP12 탭 |
| service-status.json(gist) | main(`serviceStatus.ts`) | 캐시 없음 | upload kill-switch + `notInINF` |
| offsets.json(gist) | main(`offsetsRemote.ts`) | 메모리 캐시 | Reflux/프로필 메모리 offset([memory-reading.md](memory-reading.md)) |
| recommend.js/calcWeakness.js/패턴 등(gist) | renderer(`recommendCore.ts`) | window 전역 + 메모리 | 추천/약점/별값 |
| Supabase(songs/scores/users/radars) | renderer(`supabaseSync.ts`) | 메모리 | 곡 마스터/점수/프로필 |

---

## 1. 외부 데이터 소스 — 캐시 + TTL + fallback 체인

모든 외부 fetch 는 **main 프로세스(Node fetch)** 에서 수행하고 IPC 로 renderer 에 넘깁니다 — renderer 의 Chromium CORS 회피(`src/main/serviceStatus.ts:1` 주석). 공통 패턴: `userData` 디스크 캐시 + TTL 24h + 다단계 fallback.

### ereter (`src/main/ereter.ts`)

`getEreterData(force)`(`src/main/ereter.ts:142-198`) fallback 체인(`src/main/ereter.ts:5-11`):
1. ereter.net `perlevel` HTML 직접 scraping(`fetchPerlevel`, `node-html-parser` 로 table 파싱, `src/main/ereter.ts:56-120`).
2. ohSorry gist 의 `ereter-data.json`(admin 수동 갱신본, `src/main/ereter.ts:124-138`).
3. 로컬 stale 캐시.

`force=false` 면 24h 안 캐시 우선(`TTL_MS`, `src/main/ereter.ts:18`). 캐시 상태는 `getCacheStatus()`(`src/main/ereter.ts:206-219`) — UI 가 stale 판정에 사용. main 부팅 시 stale 이면 자동 갱신(`src/main/index.ts:586-596`).

### zasa (`src/main/zasa.ts`)

`getZasaData`(`src/main/zasa.ts:116-199`). sakura + gist **합치기**(sakura 우선 + gist 미등재곡 추가, `normTitle` 로 dedup, `src/main/zasa.ts:147-168`). 추천/★ 추정엔 미사용 — DP12 격자 미분류 곡 분류만(`src/main/zasa.ts:3`).

### rating (`src/main/rating.ts`)

`getRatingData`(`src/main/rating.ts:47-70`) — 다른 소스와 달리 **항상 gist fetch 우선**, 실패 시에만 캐시 fallback(`src/main/rating.ts:47-49`). `ohSorryRating.json`(ohSorry 가 모은 ereter 미등록 lv11/12 EC/HC/EXH 추정값). 추천 풀의 핵심 입력.

### spTier (`src/main/spTier.ts`)

구글 시트 "☆12参考表" published HTML → 하드/노마게(`GID` `src/main/spTier.ts:32-35`) 두 탭 파싱(`parseTable`, `src/main/spTier.ts:91-150`). tier `S＋~F`. GRID 탭 SP12 전용.

### serviceStatus (`src/main/serviceStatus.ts`)

`fetchServiceStatus()`(`src/main/serviceStatus.ts:27-42`) — **캐시 없음, 매 호출 fresh fetch**(`src/main/serviceStatus.ts:11`). **fail-closed**: fetch 실패 시 `uploadEnabled:false`/`shelfEnabled:false`(`src/main/serviceStatus.ts:34-41`). gist `service-status.json`(`30c3ba6…`). `notInINF` 배열(INFINITAS 미수록 차트 `{title, diff(slot)}`)도 여기서.

---

## 2. 추천 코어 통합 (`src/renderer/src/recommendCore.ts`)

추천/약점/별값 계산은 **ohSorry 본체와 동일한 gist 모듈을 renderer 에서 fetch + eval** 해서 일원화합니다. (계산 로직은 gist 로 배포 — gist 한 번 갱신으로 본체/웹/INF 동시 업데이트.)

### gist 모듈 로딩 (`loadGistModule`, `src/renderer/src/recommendCore.ts:34-43`)

`fetch(url) → new Function(text)()` 로 eval → 모듈이 `window[globalKey]` 에 자기 등록. 이미 `window` 에 있으면 재사용(전역 캐시). `GIST_RAW = gist.../c3da608…/raw`(`src/renderer/src/recommendCore.ts:18`).

> CSP 주의: `connect-src` 에 `https://gist.githubusercontent.com` 이 허용돼 있어야 fetch 가 막히지 않음(README 0.0.56 changelog).

### loadRecLibs (`src/renderer/src/recommendCore.ts:235-247`)

병렬 fetch: `calcWeakness.js`/`normTitle.js`/`recommend.js`(모듈) + `patterns-dp-1112.json`/`rate-reference-slim.json`/`feature-scores-slim.json`/`textage-meta.json`/`series-name.json`(JSON).

패턴은 **레벨 구간 lazy 로드**: 평소 1112(11·12)만 fetch(7MB→1.8MB). 하위 구간(8~10 = `0810`, 1~7 = `rest`)은 추천/약점이 저렙을 다룰 때만 `ensurePatternsLevel(libs, band)` 로 `libs.patterns` 에 in-place 병합(`src/renderer/src/recommendCore.ts:254-274`). 병합 후 `createRecCtx` 재호출 필요(App 의 `patBandsReady` state 가 트리거, `App.tsx:980`/`1029`).

### createRecCtx (`src/renderer/src/recommendCore.ts:290-334`)

TSV(`rowsToAllCharts`, `src/renderer/src/recommendCore.ts:109-133`) + ratingData/zasaData/ereterData → deps 빌드 → `recommend.js` 의 `createContext(deps)` 호출 → `ctx`(`buildRecs`/`buildWeaknessRecs`/`setLayoutMode` 등 보유).

- **INF 미수록 차트 선필터**: `allCharts` 를 `isInfChart(title, chartName)` 로 거름(`src/renderer/src/recommendCore.ts:299-302`). Reflux TSV 에 있어도 실제 INFINITAS 미노출인 차트 제거. `isInfChart` = service-status `notInINF` + Supabase `songs.ac/legen`(`getInfChartChecker`) 조합(`App.tsx:1010-1017`).
- `userVec` = `calcWeakness.calcUserWeakness(...)` 호출(`src/renderer/src/recommendCore.ts:303-311`).
- 인덱스: `ereterMap`/`ratingMap`/`zasaMap`/`patternsTitleMap`/`textageSeriesByNorm` 등 빌드 후 ctx 에 주입.

### 별값(★) 파이프라인 v3.4.0 (`App.tsx`)

`onlyOSRtoEreter.inferEreter` 단일 호출로 표시 별값과 추천 base 를 산출(`App.tsx:713-761`). 선행 의존(window 전역) `OhsorryNorm`/`OSR135`/`onlyOSR` 을 `loadGistModule` 로 먼저 로드 후 `onlyOSRtoEreter` 로드(`App.tsx:724-746`) — UMD `require` 폴백을 안 타게 하기 위함(eval 환경에 `require` 없음).

`dp12StarResult`(`App.tsx:749-761`): `{ star: ereterStar, nativeStar: ohsorryStar, tier, nFit12 }`(`StarResult`, `src/shared/types.ts:30-39`). 추천 baseStar = `star`(ereterStar) 그대로(`ohsorryRecBase`, `App.tsx:764`).

### 추천 풀 매칭 (`dp12Match`, `App.tsx:536-694`)

추천 풀 기준은 **ohSorryRating.json 등재곡**입니다. ratingData.ratings(gameLevel 11/12) → TSV row 매칭 → ereter 보조 매칭. 결과 `RecInputChart[]`(`src/shared/recommend.ts:19-55`): 내부 평가용은 rating 추정값(zasaLevel/estEc/estHc/estExh), 표시용은 ereter 실측(있을 때만). ereter 미등재는 `isRatingFallback:true`(UI 색 구분). 곡명 매칭 키는 `norm(title)+'|'+diff`(`src/shared/match.ts:80-85`).

추천 산출 자체(buildRecs/buildWeaknessRecs)는 gist `recommend.js` 가 담당. INF오소리 측 `shared/recommend.ts` 는 타입 + refresh 보조 함수(`shouldDropFromRecs`/`isReachedLamp`/`isAccuracyOK` 등 `src/shared/recommend.ts:108-156`)만 보유 — 표시 중인 추천곡을 TSV 갱신에 맞춰 갱신/제거(`refreshRecs`, `App.tsx:1035` 이하)하는 데 사용.

---

## 3. Supabase 동기화 (`src/renderer/src/supabaseSync.ts`)

ohSorry 와 같은 Supabase 프로젝트 `cvxpeecxiawddmrzbdvn`(Tokyo) 공유. `iidx_id text PK` 라 namespace 호환. 모든 fetch 는 anon JWT key + REST/RPC(`SUPABASE_URL`/`SUPABASE_KEY`, `src/renderer/src/supabaseSync.ts:22-30`).

### 읽기/업로드 분리 — 실시간 reload + 3분 업로드

**TSV 읽기는 실시간, Supabase 업로드는 3분 주기**로 분리돼 있습니다(2026-06 변경).

**① 실시간 reload (`App.tsx:354-372`)** — Reflux 의 `watchTsv` 가 `tracker.tsv` mtime 변경을 감지하면 `setState({stage:'ready', lastTsvMtime})`(`reflux.ts:599`) → `onState`(`App.tsx:209`) → renderer `refluxState.lastTsvMtime` 갱신. 이를 dep 으로 한 effect 가 **debounce 400ms** 후 `loadTsv(tsvPath)` 호출 → rows 갱신 → `dp12StarResult` 자동 재계산. host 전용(`IS_BROWSER_REMOTE` skip). debounce 는 메모리 덤프 연속 갱신 시 폭주 방지.

**② 3분 주기 업로드 (`App.tsx:866-943`)** — `STAR_REFRESH_INTERVAL_MS = 3분`(`App.tsx:94`). host 전용. timer 는 **읽기를 하지 않고** 그 시점 최신 rows 기준으로 업로드만:
1. `tryUpload('auto')` — 별값 + scores upload.
2. 200ms 후 `setVecRecomputeKey(k=>k+1)` — Analysis 의 패턴 vec 재계산 + `user_ohsorry_radars` upsert 트리거(`App.tsx:924-929`).

> v0.0.41~0.0.75 는 mtime 이벤트 reload 를 끄고 3분 timer 가 `loadTsv`+업로드를 함께 했었음(race 우려). 옛 ID 잘못 업로드 방어는 `loadTsv` 의 `rowsSourceIidxIdRef` 태깅 + `tryUpload` 가드가 담당하므로, 읽기만 실시간으로 되살림.

수동 호출: 콘솔 `window.updateSupabase()`(`App.tsx:919-920`). 초기 1회는 데이터 준비되는 즉시(`App.tsx:948-958`).

업로드 가드(`tryUpload`, `App.tsx:878-916`): `iidxId`/`djName` 있고 `^[A-Z]\d{12}$` 형식이고, rows 출처 ID 가 현재 ID 와 일치하고, star/match 가 준비됐을 때만.

### uploadProfile (`src/renderer/src/supabaseSync.ts:246-400`)

1. **kill-switch 확인**: `serviceStatus.get()` 의 `uploadEnabled===false` 면 skip(`src/renderer/src/supabaseSync.ts:250-253`).
2. **users upsert**: RPC `upsert_user`(`src/renderer/src/supabaseSync.ts:262-276`). `p_star`(ereterStar 4자리), `p_sp_rank:null`/`p_dp_rank:null`(INF 메모리 신뢰성 X — 단위는 ohSorryAdmin 이 채움).
3. **scores upsert**: chart row 변환 + songs 매칭 + dedup → RPC `upsert_scores`(`src/renderer/src/supabaseSync.ts:285-399`).
   - `DIFF_MAP`/`LAMP_MAP`(`src/renderer/src/supabaseSync.ts:33-34`), `PLAYED_VERSION_INF=0`.
   - songs 매칭: `getSongsCache()`(norm key → `SongEntry[]`, ac/legen bit, 페이징 fetch `src/renderer/src/supabaseSync.ts:81-122`) + `pickSongId`(INF 비트 2, `src/renderer/src/supabaseSync.ts:150-159`).
   - 미등록 신곡: `ensure_song` RPC 자동 호출(textage-meta 의 `textage_song_id` 전달해 옛 row 통합, `src/renderer/src/supabaseSync.ts:313-352`).
   - PK `(song_id, iidx_id, diff, played_version)` 중복 dedup — best ex_score/lamp(`src/renderer/src/supabaseSync.ts:299-375`).

### user_ohsorry_radars (패턴 vec, `Analysis.tsx`)

Analysis 탭이 28차원 패턴 벡터를 계산해 upsert 합니다(README 0.0.55/0.0.63/0.0.66 changelog + Explore 조사):
- `weaknessLib.computePatternScoreVec(...)` — gist `calcWeakness.js` 가 backfill 과 동일한 가중합 형식(0~1500)으로 28 dim 반환. (이전엔 잔차 -1~1 을 그대로 올려 형식 불일치하던 버그를 0.0.63 에서 수정.)
- RPC `upsert_user_feature_score` — **29 인자**(`p_iidx_id` + 28 dim: 10 mirror-invariant feature `notes/chord/peak/charge/scratch/soflan/phrase/jack/trill/rand` + 18 손별 mirror `stair_up_l/r`, `stair_dn_l/r`, `k1_l/r`~`k7_l/r`). 0.0.66 에서 11→29 인자로 확장(silent fail 해소).
- percentile: `fetchAllUsersFeatureScores`(전 유저 페이징, 10분 캐시) → feature 별 `{rank, total, percentile}`.

### Recent 탭 RPC (`src/renderer/src/supabaseSync.ts:402-675`)

ohSorryWeb api.js 호출 형식 그대로 옮김:
- `fetchRecentDates(id, dbrOnly)` — RPC `make_recent_dates` → `{date_kst, row_count}[]`(`src/renderer/src/supabaseSync.ts:552-563`).
- `fetchRecentCharts(id, dateKst)` — RPC `make_recent_data`(prev→now diff 포함) → `RecentChartRow[]`(`src/renderer/src/supabaseSync.ts:591-606`).
- `fetchUserLatestCharts(id)` — RPC `make_grid_data`(차트별 dedup latest, 페이징) → `norm(title)+'|'+diffStr` 인덱스(`src/renderer/src/supabaseSync.ts:619-675`). "오늘(라이브)" 박스의 PREV(마지막 업로드 시점) source.

DBR 토글(`dbrOnly`): ON 이면 `played_version=-10`(배틀) 날짜만, DBR 난이도 맵(`loadDbrMap`, gist `dbr-inf-recommend.json`, `src/renderer/src/supabaseSync.ts:569-589`)으로 표시/정렬.

### 기타 Supabase fetch

- `fetchUserPublic(iidxId)`(`src/renderer/src/supabaseSync.ts:184-224`) — `user_radars`(DP 6지표) + `users`(sp_rank/dp_rank) 병렬. ProfileCard 의 노트레이더 + 단위 보강.
- `getSongsById()`/`ensureTextageMeta()`/`fetchSeriesNames()` — PlayData 의 곡 마스터/메타/시리즈명.

---

## 4. IIDX ID 전환 가드 (`App.tsx:771-848`)

옛 ID 의 TSV 가 메모리에 남아 **새 ID 로 잘못 업로드되는 사고**를 막는 이중 안전장치입니다.

두 가지 transition 을 감지:
1. **A→B 직접 전환**: prev/now 둘 다 유효 13자인데 다르면 → 즉시 정리(`doReset`, `App.tsx:826-829`).
2. **truthy→null**: 게임 종료/INFINITAS 죽음 → null 이 **5초 지속**될 때만(debounce, `App.tsx:844-847`). "데이터 불러오기" 재시작 중 잠깐 null 되는 false-positive 회피.

`doReset`(`App.tsx:796-821`): rows/tsvMtime/lastLoadedMtime/rowsSourceIidxIdRef/initialUploadDoneRef reset + `clearTsv(tsvPath)` IPC(내용 비우기). 가드 조건(`everHadValidIidxIdRef`): 세션 중 한 번이라도 Reflux 후킹 + 유효 ID 형식 잡힌 적 있어야 함.

이중 안전장치: TSV read 시점의 live ID 를 `rowsSourceIidxIdRef` 에 태깅(`App.tsx:218`/`365`)하고, 업로드 직전 *출처 ID ≠ 현재 ID* 면 업로드 skip(`App.tsx:891-895`). 비동기 업로드 도중 ID 가 바뀌는 경쟁까지 차단.

---

## 5. LAN 원격 제어 (`src/main/http-server.ts` + `src/renderer/src/api.ts`)

같은 네트워크의 다른 PC(PC2) 의 Chrome 으로 `http://<PC1-IP>:3000` 접속하면 같은 화면 + 모든 기능. PC2 는 단순 원격 클라이언트, 실제 동작은 PC1 에서.

### 서버 (`startHttpServer`, `src/main/http-server.ts:179-246`)

production 빌드에서만 시작(`src/main/index.ts:573`). 포트 3000, `0.0.0.0` 바인드. 라우팅:
- `POST /api/ipc` — `{channel, args}` → `ipcHandlers[channel](...args)` → `{result}` 또는 `{error}`(`handleIpc`, `src/main/http-server.ts:76-121`). **ipcMain 과 같은 핸들러 맵 공유**([architecture.md](architecture.md) 3절).
- `GET /api/events` — SSE(text/event-stream). reflux state 실시간 push(아래).
- `GET /*` — `out/renderer/` 정적 파일(SPA fallback → index.html, `src/main/http-server.ts:213-234`).
- CORS: `access-control-allow-origin: *` + OPTIONS preflight 처리(`src/main/http-server.ts:191-199`).

### SSE broadcast (`setupSseBroadcast`, `src/main/http-server.ts:125-177`)

`refluxManager.on('state', ...)` → 접속한 PC2 들에 `event: reflux:state` broadcast(`src/main/http-server.ts:141-143`). 연결 즉시 현재 state 1회 push(초기 sync, `src/main/http-server.ts:166-168`). 15초마다 `: ping` keep-alive(idle proxy/NAT 끊김 방지, `src/main/http-server.ts:146-154`). client 끊기면 close 핸들러가 set 에서 제거.

### 클라이언트 polyfill (`src/renderer/src/api.ts`)

`window.infohsorry` 가 없으면(브라우저 환경) HTTP bridge 로 `window.infohsorry` 를 polyfill(`src/renderer/src/api.ts:129-245`). 그 결과 App.tsx 등은 환경 분기 없이 `window.infohsorry.*` 그대로 호출. 각 메서드는 `callIpc(channel, ...args)`(`POST /api/ipc`, `src/renderer/src/api.ts:8-17`).

reflux state 구독은 SSE(`EventSource('/api/events')`, `src/renderer/src/api.ts:21-97`). 끊김 시 EventSource 자동 재연결 + 안전망 30초 polling fallback(영구 실패/구형 브라우저/옛 PC1, `src/renderer/src/api.ts:37-49`).

브라우저 원격에서 의미 없는 기능은 noop/reject: `portable.*`(자동 업데이트), `window.*`(창 컨트롤). `saveImage` 는 PC2 Chrome 자체 다운로드(`browserDownloadPng`, `src/renderer/src/api.ts:100-127`). `document.documentElement.classList.add('browser-remote')` 로 CSS 분기(`src/renderer/src/api.ts:132`). `IS_BROWSER_REMOTE = !IS_HOST`(`src/renderer/src/api.ts:247`) 로 host 전용 로직(Supabase 업로드/devMode) 구분.
