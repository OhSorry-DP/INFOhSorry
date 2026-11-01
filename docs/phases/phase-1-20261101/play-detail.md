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

INF 전체 `node --test`(src 아래 모든 `*.test.mjs`): tests 329 / pass 320 / fail 9 / skipped 0. 기존 실패 9건은 `dbr-recent` 5건(테스트 스텁에 `./diagLog` 누락), `compute` 4건(형제 레포 ohSorryRating의 `dist`·`onlyOSR.js` SHA-256 고정값 불일치)이다. 이번 작업으로 `play-upload`의 기존 실패 1건(`./playDetail` 스텁 누락)은 해소됐다. typecheck·build 통과.

웹 `test:auth`: tests 729 / pass 726 / fail 3. `test:v3`: tests 4145 / pass 4144 / fail 1. 실패 4건은 모두 기존 실패로, main 파일로 되돌려도 동일하다: v2 blob parity, middleware v2 분기 SHA, v3 SP context title-only, P1 Stats i18n `未分類 1`.

변이 확인(Claude 직접, 각 원복): INF 업로드 결합 제거 → fail 1, JSONL 읽기 제거 → fail 4, v3profile 10판 제한·CDN 상속 제거 → fail 1. 웹 PUT 검증·코치 제한 무력화 → fail 8, 리모트 오류 행 판정 무력화 → fail 1.

## 인계

- 배포 순서: 웹(PUT 수용·코치 옵션·리모트 표시) → INF 릴리스 → 코치 GPT Actions·MCP 스키마 갱신. 순서를 지키지 않으면 새 INF의 PUT이 400을 반환한다.
- 실기 확인: INF Recent 세부 판정 표, 리모트 최근 10판, 코치 `getPlays detail_limit=1` 응답.
- 레인 0–7의 실제 건반 대응은 미확정이며 번호로만 표시한다.
- 실제 `plays_detail.jsonl` 크기 분포는 미측정이다. 구조 계산은 판당 약 0.8–1.3KB다.
- INF 소스 약 55개 파일의 소유자가 CodexSandboxOffline이다. 관리자 `takeown` 필요 여부는 사용자 결정 대기다.
