# IIDX INFINITAS DP Play Data Viewer - by오소리

IIDX INFINITAS DP Play Data Viewer — 일렉트론 데스크탑 앱입니다. INFINITAS 의 메모리에서 플레이 데이터를 추출 (Reflux 활용) 하고, ereter.net 의 ★ 데이터와 매칭해서 DP ☆12 별값 추정 / 추천곡 분석을 보여줍니다.

## 주요 기능

- **Reflux 자동 통합** — 처음 실행 시 [olji/Reflux](https://github.com/olji/Reflux) 를 자동 다운로드. 메모리 리딩 + tracker.tsv dump 까지 백그라운드에서 처리
- **SP / DP 곡 표** — 차트 단위 (한 row = 한 난이도)로 LAMP / LV / 곡명 / NOTES / RATE 시각화 / SCORE / MISS
- **DP RECOMMEND 탭** — ereter넷 리코멘드 매칭 + ohSorry v3.3.5 모델로 별값 추정, EC / HC / EX-HARD 추천곡 (도전 + 정리), DP12렙 서열표 표시 및 저장
- **ereter 데이터 자동 갱신** — 24h TTL 캐시. 만료되면 자동 fetch (수동 갱신 버튼도 있음). v0.0.14+ 부터 ereter.net / zasa 다운 시 ohSorry gist 에서 자동 fallback → 끊김 없이 동작.
- **ohSorryRating fallback** — ereter 미등록 lv11/lv12 차트는 ohSorry 가 모은 추정값 (ohSorryRating.json) 으로 추천 풀 보강. lv11 추정 곡명은 진한 연두색, lv12 추정은 하늘색.
- **LAN 원격 제어** — 같은 네트워크의 다른 PC 의 Chrome 으로 접속하면 같은 화면 + 모든 기능 사용 가능 (HTTP RPC bridge)
- **곡 목록 필터** — 검색 / LAMP / LV / 잠긴 차트 숨김 / sticky 헤더 + 필터

## 설치

[Releases](../../releases) 에서 둘 중 하나:

| 파일 | 설명 |
|---|---|
| `ohSorryScoreINF.Setup.0.0.83.exe` | NSIS 설치 마법사 — 시작 메뉴 / 바로가기 자동 생성 |
| `ohSorryScoreINF-0.0.83-portable.exe` | 포터블 — 설치 X, 더블 클릭만으로 실행 |

> **방화벽** — 첫 실행 시 Windows 방화벽이 묻습니다. LAN 원격 제어 사용하려면 사적 네트워크 허용.

## 사용 방법

1. **INFINITAS 실행** (먼저 띄워두기)
2. 앱 실행 → "데이터 불러오기" 클릭 → Reflux 자동 다운로드 + 백그라운드 시작
3. 게임에서 **곡 선택 화면 한 번 진입** → tracker.tsv 자동 dump → 표 자동 표시
4. 이후 곡 선택 갈 때마다 자동 갱신

## 추천곡 로직 (ohSorry v3.3.5 호환)

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

PC1 (호스트, 게임실항하는 PC) 에서 앱 실행 → 콘솔에 표시되는 `http://192.168.x.x:3000` 을 PC2 의 Chrome 으로 접속.

PC2 의 화면이 PC1 과 같고, 모든 버튼 (데이터 불러오기 / ereter 갱신 / 캡처 등) 이 PC1 에서 실행됩니다. PC2 는 단순 원격 클라이언트.

## 데이터 저장 위치

| 항목 | 위치 |
|---|---|
| Reflux 작업 폴더 (Reflux.exe / config / tracker.tsv / sessions) | `%APPDATA%\infohsorry\Reflux\` |
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
- ohSorry — 별값 추정 / 추천곡 모델 (v3.2.10) 의 원본 (e-amusement 아케이드 IIDX 도구)