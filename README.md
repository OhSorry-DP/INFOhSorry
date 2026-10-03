# IIDX INFINITAS DP Play Data Viewer - by오소리

IIDX INFINITAS DP Play Data Viewer — 일렉트론 데스크탑 앱입니다. INFINITAS 의 메모리에서 플레이 데이터를 추출 (Reflux 활용) 하고, ereter.net 의 ★ 데이터와 매칭해서 DP ☆12 별값 추정 / 추천곡 분석을 보여줍니다.

## 주요 기능

- **Reflux 자동 통합** — [OhSorry-DP/Reflux](https://github.com/OhSorry-DP/Reflux) fork의 최신 릴리스를 확인해 설치·갱신. 메모리 리딩 + tracker.tsv dump까지 백그라운드에서 처리 (원본: olji/Reflux)
- **SP / DP 곡 표** — 차트 단위 (한 row = 한 난이도)로 LAMP / LV / 곡명 / NOTES / RATE 시각화 / SCORE / MISS
- **DP RECOMMEND 탭** — ereter넷 리코멘드 매칭 + ohSorry v3.3.6 모델로 별값 추정, EC / HC / EX-HARD 추천곡 (도전 + 정리), DP12렙 서열표 표시 및 저장
- **ereter 데이터 자동 갱신** — 24h TTL 캐시. 만료되면 자동 fetch (수동 갱신 버튼도 있음). v0.0.14+ 부터 ereter.net / zasa 다운 시 ohSorry gist 에서 자동 fallback → 끊김 없이 동작.
- **ohSorryRating fallback** — ereter 미등록 lv11/lv12 차트는 ohSorry 가 모은 추정값 (ohSorryRating.json) 으로 추천 풀 보강. lv11 추정 곡명은 진한 연두색, lv12 추정은 하늘색.
- **LAN 원격 모드** — 같은 네트워크의 브라우저에서 오소리웹 셸로 본인 기록 확인. `/api/me`·`/api/me/v3profile`과 SSE로 실시간 갱신하며, INF 자체 화면은 `/index.html`에서 HTTP RPC bridge로 접속
- **곡 목록 필터** — 검색 / LAMP / LV / 잠긴 차트 숨김 / sticky 헤더 + 필터

## 설치

[Releases](../../releases) 에서 둘 중 하나:

| 파일 | 설명 |
|---|---|
| `ohSorryScoreINF.Setup.0.0.140.exe` | NSIS 설치 마법사 — 시작 메뉴 / 바로가기 자동 생성 |
| `ohSorryScoreINF-0.0.140-portable.exe` | 포터블 — 설치 X, 더블 클릭만으로 실행 |

> **방화벽** — 첫 실행 시 Windows 방화벽이 묻습니다. LAN 원격 제어 사용하려면 사적 네트워크 허용.

## 사용 방법

1. **INFINITAS 실행** (먼저 띄워두기)
2. 앱 실행 → 게임 세션 감지 시 Reflux 자동 설치·갱신 + 백그라운드 시작
3. 게임에서 **곡 선택 화면 한 번 진입** → tracker.tsv 자동 dump → 표 자동 표시
4. 이후 곡 선택 갈 때마다 자동 갱신

## 추천곡 로직 (ohSorry v3.3.6 본체 추종)

**카테고리 × 분류** — 추천 후보를 6 버킷으로 분리:
- 카테고리: **under** (해당 stage 미클리어) / **reached** (stage 깼지만 DJ Level 미달 — 정확도 개선 여지)
- 분류: **hard** (도전 — `baseStar+offset-0.3 ~ baseStar+offset`) / **easy** (약 도전 — `baseStar ~ baseStar+0.2`) / **cleanup** (정리 — `0 ~ baseStar`)
- 도전곡 offset 은 ★실력에 따라 선형 보간 (★0.5 → +1.0, ★14.0 → +0.3)

**비율** — 6 SLOT 으로 총 10곡:
- under.hard 1 + reach.hard 1
- under.easy 2 + reach.easy 2
- under.cleanup 2 + reach.cleanup 2
- 각 SLOT 부족 시 같은 분류의 반대 카테고리에서 fallback, 그래도 부족하면 전체 풀에서 보충

**샘플링** — 카테고리별 클리어 인구수 desc top 10 + 랜덤 5 = sample 15곡. SLOT 별 셔플 → ★ asc 통합 정렬.

**EXH 별도 로직** — EXH ★ 낮은 30곡 → `rate = exScore / (noteCount*2)` desc 10곡. "거의 통과한 곡" 우선.

**recLevelMode** — baseStar≥6 시 `lv12` (lv11 차트 제외), 미만이면 `all`.

**제외 조건** — EC 정리곡은 HC 추정값이 `baseStar - 3` 미만이면 제외 (시간 낭비 방지). reached 중 `exScore===0` 인 더티 데이터도 제외.

**추천 풀 데이터 출처** (우선순위):
1. **ereter (이레터넷)** — 매칭되면 그 값 그대로
2. **ohSorryRating fallback** — ereter 미등록 lv11/lv12 차트는 ohSorry 가 모은 추정값으로 보강 (lv11 곡명 진한 연두 / lv12 곡명 하늘색 표시)

## LAN 원격 제어(투컴 방송용)

PC1 (호스트, 게임 실행 PC)에서 앱 실행 → PC2 브라우저에서 `http://ohsorry.local:3000` 또는 `http://PC-IP:3000` 접속. 포트 80 바인딩에 성공하면 `:3000`을 생략할 수 있습니다.

루트는 `/?remote`로 이동해 오소리웹 원격 본인 카드를 제공합니다. v3 전용 이름은 `http://ohsorry-v3.local:3000`이며 `/api/me/v3profile`로 본인 프로필을 받습니다. INF 자체 화면의 HTTP RPC bridge는 `/index.html`로 접속합니다. 호스트별 upstream과 캐시는 분리됩니다.

## 데이터 저장 위치

| 항목 | 위치 |
|---|---|
| Reflux 작업 폴더 (Reflux.exe / config / tracker.tsv — 게임 실행 중에만) | `%APPDATA%\infohsorry\Reflux\` |
| 계정별 기록 정본 (tracker.tsv / meta.json — IIDX ID 별) | `%APPDATA%\infohsorry\users\{IIDX_ID}\` |
| 마지막으로 본 저장 계정 | `%APPDATA%\infohsorry\viewer-state.json` |
| ereter-data.json | `%APPDATA%\infohsorry\ereter-data.json` |
| 캡처 PNG | `%USERPROFILE%\Downloads\` |

폴더 열기는 앱의 "폴더 열기" 버튼으로 한 번에.

## 변경 이력

전체 변경 이력은 [CHANGELOG.md](CHANGELOG.md) 를 참고하세요.

## 개발 · 상세 문서

앱 내부 동작 / 코드 구조 / 빌드를 다루는 개발자용 문서는 [docs/](docs/README.md) 에 있습니다.

- [architecture.md](docs/architecture.md) — Electron main/preload/renderer 3 프로세스 구조, 빌드, 부팅 시퀀스, 탭 구성, IPC 등록
- [memory-reading.md](docs/memory-reading.md) — Reflux 자동 관리, tracker.tsv 파싱, koffi 메모리 스캔, offset 원격 갱신
- [data-flow.md](docs/data-flow.md) — 외부 데이터(ereter/zasa/rating) gist 캐시, 추천 코어 통합, Supabase 업로드, LAN 원격제어(SSE)
- [ipc-reference.md](docs/ipc-reference.md) — main↔renderer IPC 채널 목록 + preload API 매핑 + HTTP bridge

## 라이선스 + 크레딧

- [olji/Reflux](https://github.com/olji/Reflux) (MIT) — INFINITAS 메모리 리더 / tracker.tsv 출처
- [ereter.net](https://ereter.net/) — ★ 데이터 출처
- ohSorry — 별값 추정 / 추천곡 모델 (v3.3.6 / core v0.0.409) 의 원본 (e-amusement 아케이드 IIDX 도구)
