# IIDX INFINITAS DP Play Data Viewer - by오소리

IIDX INFINITAS DP Play Data Viewer — 일렉트론 데스크탑 앱입니다. INFINITAS 의 메모리에서 플레이 데이터를 추출 (Reflux 활용) 하고, ereter.net 의 ★ 데이터와 매칭해서 DP ☆12 별값 추정 / 추천곡 분석을 보여줍니다.

## 주요 기능

- **Reflux 자동 통합** — 처음 실행 시 [olji/Reflux](https://github.com/olji/Reflux) 를 자동 다운로드. 메모리 리딩 + tracker.tsv dump 까지 백그라운드에서 처리
- **SP / DP 곡 표** — 차트 단위 (한 row = 한 난이도)로 LAMP / LV / 곡명 / NOTES / RATE 시각화 / SCORE / MISS
- **DP RECOMMEND 탭** — ereter넷 리코멘드 매칭 + ohSorry v3.3.3 모델로 별값 추정, EC / HC / EX-HARD 추천곡 (도전 + 정리), DP12렙 서열표 표시 및 저장
- **ereter 데이터 자동 갱신** — 24h TTL 캐시. 만료되면 자동 fetch (수동 갱신 버튼도 있음)
- **ohSorryRating fallback** — ereter 미등록 lv11/lv12 차트는 ohSorry 가 모은 추정값 (ohSorryRating.json) 으로 추천 풀 보강. lv11 추정 곡명은 진한 연두색, lv12 추정은 하늘색.
- **LAN 원격 제어** — 같은 네트워크의 다른 PC 의 Chrome 으로 접속하면 같은 화면 + 모든 기능 사용 가능 (HTTP RPC bridge)
- **곡 목록 필터** — 검색 / LAMP / LV / 잠긴 차트 숨김 / sticky 헤더 + 필터

## 설치

[Releases](../../releases) 에서 둘 중 하나:

| 파일 | 설명 |
|---|---|
| `ohSorryScoreINF Setup 0.0.8.exe` | NSIS 설치 마법사 — 시작 메뉴 / 바로가기 자동 생성 |
| `ohSorryScoreINF-0.0.8-portable.exe` | 포터블 — 설치 X, 더블 클릭만으로 실행 |

> **방화벽** — 첫 실행 시 Windows 방화벽이 묻습니다. LAN 원격 제어 사용하려면 사적 네트워크 허용.

## 사용 방법

1. **INFINITAS 실행** (먼저 띄워두기)
2. 앱 실행 → "데이터 불러오기" 클릭 → Reflux 자동 다운로드 + 백그라운드 시작
3. 게임에서 **곡 선택 화면 한 번 진입** → tracker.tsv 자동 dump → 표 자동 표시
4. 이후 곡 선택 갈 때마다 자동 갱신

## 추천곡 로직 (ohSorry v3.3.3 호환)

**도전곡 범위** — 사용자 ★실력에 따라 위로 얼마까지 추천할지 동적으로 결정 (선형 보간, ★0.5 → +1.0, ★14.0 → +0.3)

**정리곡** — `★0 ~ baseStar` 범위에서 추천 단계 (EC / HC / EXH) 미만 lamp 인 곡 (NO PLAY 포함). EC 정리곡은 HC 난이도가 baseStar - 3 미만인 곡은 제외 (시간 낭비 방지).

**비율** — 하드 도전 2 + 약 도전 5 + 정리 3 = 총 10곡. 한 쪽 부족하면 다른 풀에서 보충.

**샘플링** — 각 풀에서 클리어 인구수 desc top 10 + 순 랜덤 5 = 후보 15곡. 셔플 → 풀별 N개 pick → ★ asc 통합 정렬.

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

## 개발

```bash
npm install              # 의존성 설치 (electron + koffi + ...)
npm run dev              # 일렉트론 dev 모드 (vite HMR)
npm run typecheck        # 타입체크
npm run build            # main + preload + renderer 빌드 (out/)
npm run release          # NSIS + portable .exe 생성 (release/)
```

스택:
- **electron-vite 3** + **Electron 28** + **React 18** + **TypeScript**
- **koffi** — Win32 API 호출 (메모리 진단용, prebuilt 바이너리)
- **node-html-parser** — ereter.net HTML 파싱
- **html2canvas** — DP RECOMMEND 탭 서열표 이미지 저장
- **electron-builder 24** — Windows 배포 빌드

## 변경 이력

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

## 라이선스 + 크레딧

- [olji/Reflux](https://github.com/olji/Reflux) (MIT) — INFINITAS 메모리 리더 / tracker.tsv 출처
- [ereter.net](https://ereter.net/) — ★ 데이터 출처
- ohSorry — 별값 추정 / 추천곡 모델 (v3.2.10) 의 원본 (e-amusement 아케이드 IIDX 도구)
