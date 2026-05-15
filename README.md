# IIDX INFINITAS DP Play Data Viewer - by오소리

IIDX INFINITAS DP Play Data Viewer — 일렉트론 데스크탑 앱입니다. INFINITAS 의 메모리에서 플레이 데이터를 추출 (Reflux 활용) 하고, ereter.net 의 ★ 데이터와 매칭해서 DP ☆12 별값 추정 / 추천곡 분석을 보여줍니다.

## 주요 기능

- **Reflux 자동 통합** — 처음 실행 시 [olji/Reflux](https://github.com/olji/Reflux) 를 자동 다운로드. 메모리 리딩 + tracker.tsv dump 까지 백그라운드에서 처리
- **SP / DP 곡 표** — 차트 단위 (한 row = 한 난이도)로 LAMP / LV / 곡명 / NOTES / RATE 시각화 / SCORE / MISS
- **DP RECOMMEND 탭** — ereter넷 리코멘드 매칭 + ohSorry v3.3.3 모델로 별값 추정, EC / HC / EX-HARD 추천곡 (도전 + 정리), DP12렙 서열표 표시 및 저장
- **ereter 데이터 자동 갱신** — 24h TTL 캐시. 만료되면 자동 fetch (수동 갱신 버튼도 있음). v0.0.14+ 부터 ereter.net / zasa 다운 시 ohSorry gist 에서 자동 fallback → 끊김 없이 동작.
- **ohSorryRating fallback** — ereter 미등록 lv11/lv12 차트는 ohSorry 가 모은 추정값 (ohSorryRating.json) 으로 추천 풀 보강. lv11 추정 곡명은 진한 연두색, lv12 추정은 하늘색.
- **LAN 원격 제어** — 같은 네트워크의 다른 PC 의 Chrome 으로 접속하면 같은 화면 + 모든 기능 사용 가능 (HTTP RPC bridge)
- **곡 목록 필터** — 검색 / LAMP / LV / 잠긴 차트 숨김 / sticky 헤더 + 필터

## 설치

[Releases](../../releases) 에서 둘 중 하나:

| 파일 | 설명 |
|---|---|
| `ohSorryScoreINF.Setup.0.0.29.exe` | NSIS 설치 마법사 — 시작 메뉴 / 바로가기 자동 생성 |
| `ohSorryScoreINF-0.0.29-portable.exe` | 포터블 — 설치 X, 더블 클릭만으로 실행 |

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
  - `calc-OSRating.js` v0.0.5 — bandCorr 선형 보간 / 그룹 경계 soft transition / nativeStar shrinkage / ASSIST 제외 / M feature top-3 평균 + 재학습
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
- **v3.3.4 ensemble** — 사용자 ★ = (oldOSR v3.3.3 + OSR v0.0.2 tiered) / 2 평균. OSR (calc-OSRating.js) 을 INFOhSorry 에 bundle, `inferUserTiered` 사용 (그룹별 scope + band correction)
- **calc-OSRating.js 자동 갱신** — 매 부팅 시 main process 가 gist 에서 fetch + userData/libs/ 캐시. version 비교해서 더 최신이면 renderer 가 eval → window override. bundle 은 fallback. 모델 업데이트 시 INFOhSorry 재빌드 불필요
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

## 라이선스 + 크레딧

- [olji/Reflux](https://github.com/olji/Reflux) (MIT) — INFINITAS 메모리 리더 / tracker.tsv 출처
- [ereter.net](https://ereter.net/) — ★ 데이터 출처
- ohSorry — 별값 추정 / 추천곡 모델 (v3.2.10) 의 원본 (e-amusement 아케이드 IIDX 도구)
