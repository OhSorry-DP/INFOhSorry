# IIDX INFINITAS DP Play Data Viewer - by오소리

IIDX INFINITAS DP Play Data Viewer — 일렉트론 데스크탑 앱입니다. INFINITAS 의 메모리에서 플레이 데이터를 추출 (Reflux 활용) 하고, ereter.net 의 ★ 데이터와 매칭해서 DP ☆12 별값 추정 / 추천곡 분석을 보여줍니다.

## 주요 기능

- **Reflux 자동 통합** — 처음 실행 시 [olji/Reflux](https://github.com/olji/Reflux) 를 자동 다운로드. 메모리 리딩 + tracker.tsv dump 까지 백그라운드에서 처리
- **SP / DP 곡 표** — 차트 단위 (한 row = 한 난이도)로 LAMP / LV / 곡명 / NOTES / RATE 시각화 / SCORE / MISS
- **DP RECOMMEND 탭** — ereter ★11.6~12.7 매칭 + ohSorry v3.2.9 모델로 별값 추정, EC / HC / EX-HARD 추천곡 (도전 + 정리)
- **ereter 데이터 자동 갱신** — 24h TTL 캐시. 만료되면 자동 fetch (수동 갱신 버튼도 있음)
- **LAN 원격 제어** — 같은 네트워크의 다른 PC 의 Chrome 으로 접속하면 같은 화면 + 모든 기능 사용 가능 (HTTP RPC bridge)
- **곡 목록 필터** — 검색 / LAMP / LV / 잠긴 차트 숨김 / sticky 헤더 + 필터

## 설치

[Releases](../../releases) 에서 둘 중 하나:

| 파일 | 설명 |
|---|---|
| `ohSorryScoreINF Setup 0.0.5.exe` | NSIS 설치 마법사 — 시작 메뉴 / 바로가기 자동 생성 |
| `ohSorryScoreINF-0.0.5-portable.exe` | 포터블 — 설치 X, 더블 클릭만으로 실행 |

> **방화벽** — 첫 실행 시 Windows 방화벽이 묻습니다. LAN 원격 제어 사용하려면 사적 네트워크 허용.

## 사용 방법

1. **INFINITAS 실행** (먼저 띄워두기)
2. 앱 실행 → "데이터 불러오기" 클릭 → Reflux 자동 다운로드 + 백그라운드 시작
3. 게임에서 **곡 선택 화면 한 번 진입** → tracker.tsv 자동 dump → 표 자동 표시
4. 이후 곡 선택 갈 때마다 자동 갱신

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
- **html2canvas** — DP RECOMMEND 탭 격자 PNG 캡처
- **electron-builder 24** — Windows 배포 빌드

## 변경 이력

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
- ohSorry — 별값 추정 / 추천곡 모델 (v3.2.9) 의 원본 (e-amusement 아케이드 IIDX 도구)
