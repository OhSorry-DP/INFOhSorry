# SP(싱글플레이) 데이터 — INFOhSorry

> **한 줄 요약**: INF 앱이 Reflux 메모리에서 읽은 **SP 채보 기록**을 두 경로로 내보낸다 — ① Supabase `scores` 에 SP10~12 만 `play_style:0` 으로 15분 주기 적재(게스트 웹용), ② 원격모드(`/api/me`)로 본인 SP 전곡을 실시간 노출(로컬보드 오소리웹 카드용). (2026-06-14, v0.0.78 /api/me SP, v0.0.81 supabase SP 적재)

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

## 2. 경로 ① — Supabase 적재 (`play_style:0`, SP10~12)

[../src/renderer/src/supabaseSync.ts](../src/renderer/src/supabaseSync.ts) `uploadProfile({ spCharts, … })`

| 규칙 | 내용 |
|------|------|
| **레벨 필터** | `gameLevel 10~12` 만 적재 (`if (c.level < 10 || c.level > 12) continue`) — 저레벨 성적은 신뢰도 낮음 |
| **play_style** | `0` (DP 행은 `1`) — `scores.play_style` int 컬럼, 0=SP |
| **dedup PK** | `${songId}|${iidxIdNorm}|${diffInt}|${PLAYED_VERSION_INF}|0` (끝 `0`=play_style) |
| **신곡 skip** | `songs` 미등록(songId==null)이면 skip(`ensure_song` 안 부름) |
| **타이밍** | 15분 주기 업로드 effect 에서 `uploadStateRef.current.spAllCharts` 참조 |

> Supabase `scores` 는 SP/DP 를 같은 테이블에 저장하고 `play_style` 로 구분(본체 dbConn 의 PK 분리와 동일 규약 — [../../ohSorry/docs/sp.md](../../ohSorry/docs/sp.md) §3). `played_version` 은 INFINITAS(0).

---

## 3. 경로 ② — 원격모드 `/api/me` (본인 SP 실시간)

원격모드(LAN 로컬보드)에서 폰→PC 로 접속한 오소리웹 카드가 본인 SP 를 **실시간**으로 보게 하는 경로. (v0.0.77 DP → v0.0.78 SP 추가)

> 진입: 폰에서 `http://PC-IP:3000` 만 쳐도 서버가 루트(`/`)를 `/osr/?remote` 로 302 리다이렉트해 바로 원격 카드가 뜬다(v0.0.82). 전체 경로 직접 입력 불필요.

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
`[iidxId, star.toFixed(3), charts(len+exSum), unclassified.len, SP(len+exSum), tier여부].join('|')` 가 바뀔 때만 push. (SP 길이·exScore 합도 시그니처에 포함 → SP 갱신도 정확히 반영)

### 3-4. /osr 네트워크 우선 (v0.0.79)
`/osr` 정적 서빙은 매 요청 cache-bust(`?t=…`)로 최신 오소리웹을 받고, **오프라인일 때만** 디스크 캐시 fallback. (이전 캐시 우선 → SP 토글 등 새 배포가 안 뜨던 문제 수정)

---

## 4. 실시간성 — 두 경로 분리

| 경로 | 갱신 주기 | 대상 | 레벨 |
|------|----------|------|------|
| ① Supabase | 15분 주기 | 게스트 웹(타인 조회) | SP10~12 |
| ② /api/me + SSE | dp12 재계산 즉시 | 본인(로컬보드) | SP 전곡 |

> SP ★/추천 계산은 INF 앱에 없음 — 앱은 SP **기록만** 내보내고, 표시·추천·분석은 오소리웹이 gist 데이터로 처리([../../ohSorryWeb/docs/sp.md](../../ohSorryWeb/docs/sp.md)).

---

## 요약표

| 항목 | 값 |
|------|-----|
| 소스 | Reflux `tracker.tsv`(SPB/SPN/SPH/SPA/SPL) |
| 경로① 적재 | `scores` `play_style:0`, gameLevel 10~12, 15분 주기 |
| 경로② 원격 | `/api/me` `sp_charts_json`(전곡)+`sp_tier12`, SSE 실시간 |
| 핵심 파일 | `App.tsx`(spAllCharts), `supabaseSync.ts`(적재), `remoteUser.ts`(원격빌드), `http-server.ts`(/api/me·SSE) |
| 관련 버전 | v0.0.78(/api/me SP), v0.0.79(/osr 네트워크우선), v0.0.80(setUser dedup), v0.0.81(supabase SP) |

> **상태: 구현됨 · 데이터 제공만** — INF 는 SP 기록 수집/노출까지. 표시·추천은 오소리웹.
