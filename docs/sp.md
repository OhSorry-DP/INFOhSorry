# SP(싱글플레이) 데이터 — INFOhSorry

> **한 줄 요약**: INF 앱은 SP 기록을 ① Supabase `scores`에 SP1~12(BEGINNER·EX SCORE 0 이하 제외), `play_style:0`으로 적재하고 ② `/api/me`와 v3 `/api/me/v3profile`로 원격 노출합니다. 자동 업로드는 스냅샷마다 계정별 마지막 성공 시각을 비교해 최소 3분 간격으로 판정하며 고정 주기·45초 업로드 디바운스는 없습니다(v0.0.134). SP★/CPI도 앱에서 계산·전송합니다.

이 문서는 INF 앱의 **SP 데이터 흐름**만 다룹니다. 메모리 리딩 일반은 [memory-reading.md](memory-reading.md), 데이터 흐름 전반은 [data-flow.md](data-flow.md), IPC 는 [ipc-reference.md](ipc-reference.md) 를 보세요.

- 상위 조망(전체 그림): [../../docs/sp.md](../../docs/sp.md)
- repo 변경 이력(정본): [../CHANGELOG.md](../CHANGELOG.md)

---

## 1. SP 데이터 소스 — Reflux 메모리

- 원천: Reflux `tracker.tsv` 메모리 덤프(자체 메모리 리딩). **ereter TSV 아님**(ereter 는 DP ★ 전용, SP ★데이터 없음).
- SP slot 5종: `SPB / SPN / SPH / SPA / SPL`. ([../src/main/tsv.ts](../src/main/tsv.ts) 의 9 slot 중 SP 5개)
- 추출: [../src/renderer/src/App.tsx](../src/renderer/src/App.tsx) `spAllCharts = useMemo(() => extractCharts(rows, { slots: SP_SLOTS }).filter(미플레이 제외))`
  - 필터: `lampNum(lamp)>0 || exScore>0` (미플레이 제외).
  - 범위: **전 레벨/시리즈**(여기선 레벨 제한 없음).

`SongChart`([../src/shared/types.ts](../src/shared/types.ts))에서 SP/DP 는 `slot` 으로만 구분(나머지 필드 공통). `ereterLevel` 은 SP 에선 거의 항상 없음(SP ★ 데이터 부재).

---

## 2. 경로 ① — Supabase 적재 (`play_style:0`, SP1~12·BEGINNER 제외)

[../src/renderer/src/supabaseSync.ts](../src/renderer/src/supabaseSync.ts) `uploadProfile({ spCharts, … })`

| 규칙 | 내용 |
|------|------|
| **레벨·플레이 필터** | `gameLevel 1~12`, `exScore > 0`, BEGINNER 제외 (`c.level < 1 || c.level > 12`, `spDiff === 'BEGINNER'`은 skip) |
| **play_style** | `0` (DP 행은 `1`) — `scores.play_style` int 컬럼, 0=SP |
| **dedup PK** | `${songId}|${iidxIdNorm}|${diffInt}|${PLAYED_VERSION_INF}|0` (끝 `0`=play_style) |
| **신곡 skip** | `songs` 미등록(songId==null)이면 skip(`ensure_song` 안 부름) |
| **타이밍** | 새 계정 스냅샷마다 마지막 성공 시각을 비교해 최소 3분 간격으로 자동 판정(기록 없음이면 즉시, 계산 데이터 미준비/진행 중이면 보류). 같은 업로드 스냅샷의 `spCharts` 사용. 수동·종료 업로드는 별도 |

> Supabase `scores` 는 SP/DP 를 같은 테이블에 저장하고 `play_style` 로 구분(본체 dbConn 의 PK 분리와 동일 규약 — [../../ohSorry/docs/sp.md](../../ohSorry/docs/sp.md) §3). `played_version` 은 INFINITAS(0).

---

## 3. 경로 ② — 원격모드 `/api/me` (본인 SP 실시간)

원격모드(LAN 로컬보드)에서 폰→PC 로 접속한 오소리웹 카드가 본인 SP 를 **실시간**으로 보게 하는 경로. (v0.0.77 DP → v0.0.78 SP 추가)

> 진입: `http://PC-IP:3000` 또는 `http://ohsorry.local:3000`의 루트는 `/?remote`로 302 이동합니다. `/osr`는 루트 등가물로 302 이동하는 호환 경로입니다. v3 전용 이름은 `ohsorry-v3.local:3000`이며 v3 셸은 `/api/me/v3profile`을 읽습니다.

### 3-1. 빌드 — `buildRemoteUser`
[../src/renderer/src/remoteUser.ts](../src/renderer/src/remoteUser.ts) 가 오소리웹 user 객체에 SP 필드 2개를 채운다:

| 필드 | 소스 | 용도 |
|------|------|------|
| `sp_charts_json` | `spCharts.map(spChartToJson)` — **전 레벨** | 웹 PlayData/Recent/추천 |
| `sp_tier12` | `spTier12`(외부 구글시트 파싱) | 웹 Grid(SP12 서열표) |

`spChartToJson` 형식: `{ title, diff(slotToDiff), slot, playStyle:'SP', lamp, lampNum, exScore, djLevel(letter), gameLevel(level), level:null, zasaLevel:null, ereterLevel, noteCount, missCount, unlocked, __playedVersion:0 }`. **DP 전용 별값 필드(level/zasaLevel)는 null.**

### 3-2. 전달 흐름
```
Reflux 메모리(SP 5 slot)
  → spAllCharts (App.tsx)
  → buildRemoteUser(…, spAllCharts, spTierData)   (App.tsx setUser effect)
  → remote:setUser IPC → main: remoteUser = user   (src/main/index.ts)
  → notifyMeUpdate() → SSE 'me:update' broadcast    (src/main/http-server.ts)
  → 오소리웹(?remote) EventSource 수신 → 새로고침 없이 카드 재렌더
```
- `GET /api/me` ([../src/main/http-server.ts](../src/main/http-server.ts))가 `getRemoteUser()` 반환 → `sp_charts_json` / `sp_tier12` 포함.
- lamp 약어(FC/EX/HC…)는 오소리웹 쪽 `normalizeRemoteLamps()` 가 풀네임으로 정규화.

### 3-3. setUser dedup (v0.0.80)
profile 이 매 렌더 새 객체라 setUser·SSE 폭주 → 카드 무한 재렌더. **내용 시그니처**로 dedup:
`sig`는 IIDX ID, DP★(소수 3자리), rated/unclassified/전 레벨 DP/SP 각각의 길이·EX SCORE 합·lamp 합, SP tier 유무, textage 매핑 준비 여부, SP/DP 레이더, SP/DP 단위, r★(소수 2자리)를 `|`로 연결합니다. 내용이 같으면 push를 생략합니다.

### 3-4. 루트 셸 네트워크 우선
`/osr`는 루트 등가물로 302 이동합니다. 셸 정적 파일은 루트에서 매 요청 `?t=…`로 upstream을 네트워크 우선 조회하고 실패하면 디스크 캐시를 사용합니다. v3 Host는 별도 upstream/캐시 디렉터리를 사용합니다.

---

## 4. 실시간성 — 두 경로 분리

| 경로 | 갱신 주기 | 대상 | 레벨 |
|------|----------|------|------|
| ① Supabase | 스냅샷마다 시각 비교, 최소 3분 간격(수동·종료는 별도) | 게스트 웹(타인 조회) | SP1~12, BEGINNER·EX SCORE 0 이하 제외 |
| ② /api/me·/api/me/v3profile + SSE | 게임 ON + provenance/DP 별값 준비 후 내용 시그니처 변경 시 push | 본인(원격 셸) | SP 전곡 |

> INF 앱은 SP12 클리어와 CPI 데이터로 `computeSpStarGuarded`(구 코어는 `computeUserSpCpi`)를 호출해 SP★/CPI를 계산하며 `sp_star`/`sp_cpi`를 업로드·원격 payload에 포함합니다. 웹의 SP 표시·추천·분석 흐름은 [../../ohSorryWeb/docs/sp.md](../../ohSorryWeb/docs/sp.md)를 참고하세요.

---

## 요약표

| 항목 | 값 |
|------|-----|
| 소스 | Reflux `tracker.tsv`(SPB/SPN/SPH/SPA/SPL) |
| 경로① 적재 | `scores` `play_style:0`, SP1~12·BEGINNER·EX SCORE 0 이하 제외, 스냅샷마다 최소 3분 간격 판정 + 수동/종료 |
| 경로② 원격 | `/api/me`(SP 전곡·tier·SP CPI/★) 및 v3 `/api/me/v3profile`, SSE 갱신 |
| 핵심 파일 | `App.tsx`(spAllCharts), `supabaseSync.ts`(적재), `remoteUser.ts`(원격빌드), `http-server.ts`(/api/me·SSE) |
| 관련 버전 | v0.0.78(/api/me SP), v0.0.79(/osr 네트워크우선), v0.0.80(setUser dedup), v0.0.81(supabase SP), v0.0.125(TSV 디바운스 업로드) |

> **상태: 구현됨** — INF는 SP 기록 수집·적재·원격 노출과 SP★/CPI 계산을 수행합니다. 웹은 SP 표시·추천·분석을 담당합니다.
