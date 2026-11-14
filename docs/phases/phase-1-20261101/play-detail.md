# 페이즈 1 — 플레이 상세 데이터

- 날짜: 2026-11-01
- 통합 검증 결과: Claude 검증 결과 문서를 기준으로 기록. 브랜치 `feat/play-detail`; INF 기준 커밋은 `55df8ab` 위, 웹 기준 커밋은 `f71edc9` 위다. push·배포·릴리스는 사용자 확인 대기다.
- 설계 정본: [INFOhSorry 설계 요약](../../INFOhSorry_설계.md)
- 기존 수집 상세: [play-logger.md 12장](../../play-logger.md#12-플레이-상세-등급별-fastslow--레인별-판정--plays_detailjsonl)

## 범위 및 결정

INF의 플레이 상세 데이터와 웹 수용·조회 통합을 기록한다. 업로드는 기존 `PUT /api/me/plays` → R2 `plays/{id}.json` 계약을 유지하며, v1·최대 100행·262144바이트 제한을 바꾸지 않는다. DB·웹훅·dump·R2 키는 변경하지 않는다. 상세는 선택 필드이며 원본 `timestamp`와 정확히 일치한다.

상세 형식은 `PlayDetail = {v:1,timestamp,complete,samples,dt_ms,p1,p2}`다. 각 쪽은 `{fs,fs_unresolved,fs_ok,lanes,lanes_ok,lane_fs,lane_fs_unresolved}`를 가진다. `fs`는 null 또는 `{fast_great,fast_good,slow_great,slow_good}`이고, `lanes`는 8×6 `[PGREAT,GREAT,GOOD,BAD,POOR,공POOR]`, `lane_fs`는 null 또는 8×4 `[FAST GREAT,FAST GOOD,SLOW GREAT,SLOW GOOD]`다. `complete:false`에서 `fs`와 `lane_fs`는 null일 수 있다. null·부재는 0이 아니며, 품질 false는 정상 확정을 뜻하지 않는다. 레인은 0–7로만 표시하고 실제 건반 대응은 미확정이다.

## 변경 조각

| 저장소 | 커밋 | 변경 |
|---|---|---|
| INF | `2b14967` | 타입을 shared로 이동 |
| INF | `17d6938` | 상세 타입 |
| INF | `0c9e547` | JSONL 읽기 |
| INF | `07a80e7` | 업로드 결합 |
| INF | `84b476b` | Recent 읽기·구독 |
| INF | `77e1201` | 리모트 최근 10판 상태 |
| INF | `dc27232` | v3profile plays 교체 |
| INF | `2350203` | Recent 목록 |
| INF | `d7c1914` | 리모트 push plays |
| INF | `fac1c13` | Recent 세부 판정 펼침 |
| 웹 | `f13e444` | PUT detail 검증 |
| 웹 | `4ef74e9` | 리모트 plays 채택 |
| 웹 | `a4ded5f` | 리모트 판별 목록 |
| 웹 | `042a604` | playsOf detailLimit |
| 웹 | `be2f39f` | detail_limit 쿼리 |
| 웹 | `6b65aa3` | 세부 판정 펼침 |
| 웹 | `834c201` | 표시 규격: 최신순·KST·레인 표 |
| 웹 | `f94fb8e` | OpenAPI |

## 검수 결함

Claude 검수에서 다음을 수정했다.

- 직접 수정(각 1줄): `supabaseSync.ts`의 `PlayCsvRow` 캐스트를 `as unknown as`로 변경, `[resource].js`의 죽은 분기에서 `detailLimit` 참조 제거, `Recent.tsx` 레인 표 셀의 중복 `key` 수정.
- Luna 재요청 A2: 테스트 어댑터의 TypeScript 변환과 `details` 생략 처리 결함.
- Luna 재요청 D1: 테스트 메타데이터 캐시 오염.
- Luna 재요청 G4: 날짜 표기 DD-MM 순서와 픽스처 결함. G3 표시는 키 이름 덤프여서 G4에서 표시 규격을 다시 정했다.
- F1c: `v3Profile.ts`가 `CodexSandboxOffline` 소유라 쓰기 실패했다. 내용을 그대로 재생성해 소유자를 변경한 뒤 성공했다.

## 검증 수치

표시 위치 변경(2026-11-02): 판별 목록과 세부 판정을 Recent에서 별도 PLAY LOG 탭(RECENT 다음)으로 이동했고 Recent에서는 제거했다. INF 로컬은 최대 100판을 표시한다. PLAY LOG는 램프·EX·레이트·미스·콤보 브레이크 요약(DP는 P1+P2 합산, 부분 기록·검증 불일치 배지), 전체 판정 막대(PG+GR+GD+BD+POOR 분모), 기본 꺼짐인 레인별 판정 보기 체크박스(레인 0–7)를 제공한다. BAD/POOR는 FAST/SLOW로 나누지 않는다.

표시 위치 변경 검증 수치(Claude 제공, 재측정 안 함): INF 전체 `node --test`: tests 334 / pass 325 / fail 9 / skipped 0(기존 실패 9건 동일: dbr-recent 5·compute 4). typecheck·build 통과. 웹 `test:auth` 729 / 726 pass / 3 fail, `test:v3` 4154 / 4153 pass / 1 fail(기존 실패 4건 동일). 표시 위치 변이: INF 정규식 변경 fail 2, App 렌더 분기 제거 fail 1; 웹 원격 본인 판정 무력화 fail 3.

INF 전체 `node --test`(src 아래 모든 `*.test.mjs`): tests 329 / pass 320 / fail 9 / skipped 0. 기존 실패 9건은 `dbr-recent` 5건(테스트 스텁에 `./diagLog` 누락), `compute` 4건(형제 레포 ohSorryRating의 `dist`·`onlyOSR.js` SHA-256 고정값 불일치)이다. 이번 작업으로 `play-upload`의 기존 실패 1건(`./playDetail` 스텁 누락)은 해소됐다. typecheck·build 통과.

웹 `test:auth`: tests 729 / pass 726 / fail 3. `test:v3`: tests 4145 / pass 4144 / fail 1. 실패 4건은 모두 기존 실패로, main 파일로 되돌려도 동일하다: v2 blob parity, middleware v2 분기 SHA, v3 SP context title-only, P1 Stats i18n `未分類 1`.

변이 확인(Claude 직접, 각 원복): INF 업로드 결합 제거 → fail 1, JSONL 읽기 제거 → fail 4, v3profile 10판 제한·CDN 상속 제거 → fail 1. 웹 PUT 검증·코치 제한 무력화 → fail 8, 리모트 오류 행 판정 무력화 → fail 1.

## 인계

- 배포 순서: 웹(PUT 수용·코치 옵션·리모트 표시) → INF 릴리스 → 코치 GPT Actions·MCP 스키마 갱신. 순서를 지키지 않으면 새 INF의 PUT이 400을 반환한다.
- 실기 확인: INF Recent 세부 판정 표, 리모트 최근 10판, 코치 `getPlays detail_limit=1` 응답.
- 레인 0–7의 실제 건반 대응은 미확정이며 번호로만 표시한다.
- 실제 `plays_detail.jsonl` 크기 분포는 미측정이다. 구조 계산은 판당 약 0.8–1.3KB다.
- INF 소스 약 55개 파일의 소유자가 CodexSandboxOffline이다. 관리자 `takeown` 필요 여부는 사용자 결정 대기다.

## 레인 배치·레인별 평가 묶음 (2026-11-03)

### 범위와 결정

`feat/lane-arrange`에서 CSV 24열의 양쪽 배치를 기록·업로드하고 INF PLAY LOG와 웹 Play Log를 세로 상세 및 건반별 평가로 바꿨다. 위의 2026-11-02 체크박스·레인 표 설명은 당시 기록이며 이번에 삭제됐다. 웹 코치 `getPlays`는 배치 두 필드를 제외한다. 저장·표시 계약 및 실측 한계는 [play-logger.md 6장](../../play-logger.md#6-csv-열)과 [13장](../../play-logger.md#13-레인-배치와-레인별-평가-2026-11-03)을 따른다. 리모트 최근 10판의 lanes·lane_fs·품질값도 기존 상세 경로에서 보존한다.

같은 묶음의 INF main 로컬 커밋 `b4fccf2`는 선택 계정 `cardId` 기준으로 게임 종료 중에도 PLAY LOG를 표시하고, `7467270`은 판정 막대 라벨과 막대의 배경색 CSS를 분리했다.

### r4 분해표와 실제 커밋

| 조각 | 저장소 | 실제 커밋 및 범위 |
|---|---|---|
| 1 | INF | `7687632` 24열 공용 계약 |
| 2 | INF | `0780993` 기록 계약·직렬화 |
| 3 | INF | `bf888c7` 메모리 읽기·헤더 승격 |
| 4 | INF | `1bef0e3` 혼합 CSV 파싱 |
| 5 | 웹 | `7a48ee6` 코치 응답 보호 |
| 6 | 웹 | `822cdd1` PUT 수용 |
| 7 | INF | `e6128d4` 표시 계산 |
| 8 | INF | `efce032` 레벨·스코어 계산 |
| 9 | INF | `6299cdf` 세로 상세 |
| 10 | INF | `9817272` 컨트롤러·배지 |
| 11 | INF | `2247609` 건반 상세·기존 표 삭제 |
| 12 | INF | `802a9ad` 상세 상호작용 |
| 13 | INF | `7d59968` 세로 구도·배치 스타일 |
| 14 | INF | `83a9faf` 컨트롤러·상세 스타일 |
| 15 | 웹 | `a1d7063` 다음 등급 컷 |
| 16 | 웹 | `805dbeb` 번역 사전 |
| 17 | 웹 | `caac209` 표시 계산 |
| 18 | 웹 | `11763f2` 머리 줄·스코어 |
| 19 | 웹 | `ade8d1e` 세로 상세·제목 |
| 20 | 웹 | `661ad45` 컨트롤러·배지 |
| 21 | 웹 | `f2425fa` 건반 상세·기존 표 삭제 |
| 22 | 웹 | `ccd1f19` 상세 상호작용·수명 |
| 23 | 웹 | `dfb2c29` 세로 레이아웃 스타일 |
| 24 | 웹 | `95a1b29` 컨트롤러·상세 스타일 |
| 25 | INF | 이번 문서 변경: `docs/play-logger.md` (아직 커밋 없음) |
| 26 | INF | 이번 문서 변경: `docs/INFOhSorry_설계.md` (아직 커밋 없음) |
| 27 | INF | 이번 문서 변경: 이 페이즈 기록 (아직 커밋 없음) |

### 검수 결함과 재요청

1차 체인 결과에는 건반별 랭크·양쪽 컨트롤러 및 건반 하나 상세의 구현과 기존 표 단언에 결함이 있어 재요청으로 보완했다. 웹 `87515bd`는 랭크·DP 활성·상세와 옛 표 단언을 정리했고 INF `78fbcec`는 양쪽 컨트롤러·랭크·상세 상호작용을 정리했다. INF `5be7d9b`는 비활성 건반 스타일 단언과 상세 상자를, `f705d90`은 메모리 읽기 스텁 주소와 헤더 승격 fixture를 보완했다.

### 검증 (Claude, 2026-11-03)

- INF 전체 `node --test`: 375 / pass 365 / fail 10. 기존 9건(dbr-recent 5·compute 4)과 gitignore된 `scratchpad/s133`의 무관한 1건이다. `npm run typecheck` 통과.
- 웹 `tests/*.test.mjs`: 738 / pass 735 / fail 3. 루트·services·shared·components·pages·workers: 4170 / pass 4169 / fail 1. 실패 4건은 모두 기존(v2 middleware·v2 blob parity·SP context title-only·P1 Stats). skipped·cancelled는 0이다.
- 변이 확인 후 모두 원복: INF 1P 오프셋 `0x37D0` → fail 3, 건반 랭크 분모에 空POOR 포함 → fail 1. 웹 코치 제외 무력화 → fail 4, PUT 순열 중복 검사 제거 → fail 1.

### 인계와 한계

- 이번 배포 순서는 웹(코치 제외·PUT 수용) → INF 릴리스다. 이번 배치 필드는 코치 응답·OpenAPI·Knowledge에 추가하지 않는다.
- C머신 Sonnet 실측은 정배·미러 교집합을 찾고 랜덤으로 확인했다. 원보고서는 INF `origin/feat/play-logger:tools/scan/REPORT.md`다.
- SP 1P 판정·배열, 배틀, S-RAN 배열 동작, 방향(A)·건반 인덱스 가정, 실제 화면은 실기 대기다. 방향을 잘못 가정했다면 표시 함수만 고친다.
- 위 수치는 Claude 제공 결과이며 이번 문서 마감에서 재실행한 결과가 아니다.
## 2026-11-04 PLAY LOG 웹 기준 이식

- 범위: INF PLAY LOG 의 레인별 평가·건반 상세창·최신 판 펼침. 웹 리모트 Play Log(`pages/playdata.js`·`components.css`)를 정답으로 두고 INF 를 맞췄다. 웹·코치·CSV·업로드·기록기는 변경 없음.
- 결정: 평가 건반 숫자·`SCRATCH`·`PLAYER1/2` 제거까지 웹 그대로. 펼침 상태는 `JSON.stringify(nextRows)` 서명 비교와 `Set` 다중 펼침, 행 key 는 행 내용+중복 순번.
- 브랜치 `feat/play-log-web-port`. 조각 L1 펼침 상태 · L2 컨트롤러 DOM·랭크·CSS · L3 상세창 · 재요청(제목 제거·상세창 이중 상자·배지 레인 조건·커서).
- 검수 결함: L2 가 패턴 타일 기본 규칙과 비활성 투명도를 지웠다(게이트·테스트로 검출). 렌더에서만 드러난 결함: `PLAYER` 제목 잔존(테스트가 틀린 기대값을 고정), 상세창 이중 상자로 화면 밖 이탈. 소스 문자열 테스트만으로는 못 잡는다 — 레이아웃 변경은 실제 렌더로 확인한다.
- 렌더 확인 방법: 임시 폴더에 `RecentPlays` 를 esbuild 로 묶어 INF 의 Electron 으로 띄워 측정(`ELECTRON_RUN_AS_NODE` 해제 필요).
- 남은 실기: 실제 플레이 데이터 화면, 터치 동작, 배치 방향·건반 인덱스.
