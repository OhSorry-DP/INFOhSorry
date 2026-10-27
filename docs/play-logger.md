# 플레이 기록기 — 결과 화면마다 메모리 값을 CSV 로 저장

> 게임(INFINITAS, `bm2dx.exe`)이 저장하지 않는 **배틀 모드 기록**과, 게임이 보여 주는 결과 값(곡명, 노트 수, 점수, DJ 레벨, 게이지, 판정)을 플레이마다 로컬 CSV 로 남기는 기능입니다.
> 상위 조망: [`../../docs/INFOhSorry.md`](../../docs/INFOhSorry.md) · 인덱스: [README.md](README.md) · 메모리 리딩 기반: [memory-reading.md](memory-reading.md)

---

## 1. 무엇을 하는가

- 실행 중인 `bm2dx.exe` 메모리를 주기적으로 읽습니다.
- **플레이 중 → 결과 화면**으로 바뀌는 순간에만 한 줄을 추가합니다. 결과 화면이 떠 있는 동안 여러 줄이 쌓이지 않습니다.
- 결과 화면을 벗어나 선택 화면으로 가도 줄은 추가되지 않습니다.
- 중단(Quit)한 플레이도 결과 화면이 뜨면 저장됩니다. 게임 기록에 남지 않는 **배틀 모드**도 저장됩니다(곡 정보를 얻는 방식이 다릅니다 — 5장).
- 원본 CSV는 로컬에 누적합니다. 기존 업로드 실행 시 게임을 인식하면 완성된 최근 100판을 프로필 업로드에 포함합니다.

## 2. 파일 구성

| 파일 | 역할 |
|------|------|
| `src/main/playLog.ts` | 순수 로직 (메모리 I/O 없음). 상태 판정, 마커 탐색, 곡 조회, CSV 행 생성, `offsets.txt` 파싱 |
| `src/main/playLogger.ts` | 런타임. 게임 붙기/떼기, 주기 폴링, 결과 전환 감지, CSV 추가 |
| `src/main/playLog.test.mjs` | 순수 로직 단위 테스트 (`node --test src/main/playLog.test.mjs`) |
| `src/main/index.ts` | 앱 시작(`whenReady`)에 `startPlayLogger` 호출, 종료(`before-quit`)에 정지 |

**출력 위치:** `app.getPath('userData')/users/{실제 게임 iidxId}/plays.csv`.
저장 순간 게임 핸들에서 계정을 직접 확인하며 미취득 시 저장을 건너뜁니다. 뷰어/마지막 계정은 사용하지 않습니다. 기존 공용 `play-log/plays.csv`는 읽기·이관·삭제·수정하지 않습니다. 앱 로그는 `appendDiagLine`으로 남깁니다.

## 3. 게임 연결과 주소

### 3.1 주소는 Reflux `offsets.txt` 에서 읽는다

기록기는 주소를 코드에 하드코딩하지 않고, Reflux 가 쓰는 `offsets.txt` 를 읽습니다.

| 키 | 용도 |
|----|------|
| `songList` | 곡 목록 (곡명, 난이도별 노트 수) |
| `judgeData` | 판정 블록 (P1·P2 판정, 게이지 원본) |
| `playSettings` | 설정 블록 (P1 기준 주소) |
| `playData` | 마지막 플레이 요약 (곡 ID, 난이도, EX, 미스, PGREAT, GREAT, 램프). 일반 플레이만 채워짐 |
| `currentsong` | 선택/플레이 중인 곡 정보 (곡 ID, 난이도, 노트 수). 배틀에서 곡을 알아내는 데 쓴다. 없으면 일반 플레이만 기록 |

- 파일 경로: `userData/Reflux/offsets.txt`. Reflux 가 자동 갱신하므로 게임 패치 후에도 Reflux 쪽 값이 맞으면 기록기도 따라갑니다.
- 값은 Reflux 의 선호 베이스(`0x140000000`) 기준 **절대주소**입니다. 실행 중 프로세스의 모듈 베이스(`modBaseAddr`)에 맞춰 변환해서 읽습니다.
- 파일이 없거나 키가 빠지면 기록기는 붙지 않고 대기합니다(2초 간격으로 다시 확인).

### 3.2 구조체 안의 고정 상수

아래 값은 주소가 아니라 구조체 내부 배치라서 코드에 고정되어 있습니다 (`PLAY_LOG_LAYOUT`, `playLog.ts`).

| 상수 | 값 | 의미 |
|------|----|------|
| `markerScanFromJudge` | 144 | 마커 탐색 시작 (judgeData + 144) |
| `markerDelta` | 24 | 탐색으로 찾은 magic 위치에서 마커까지 거리 |
| `settingsStateDelta` | 0x18 | `PlaySettings - 0x18 == 1` 이면 선택 화면 |
| `p2SettingsDelta` | 0x48 | P2 설정 블록 = P1 설정 블록 + 0x48 |
| `battleFlagDelta` | 0x28 | 배틀 플래그 (PlaySettings 기준 int32, 1 = 켜짐) |
| `gaugeWordP1` / `gaugeWordP2` | 77 / 78 | 게이지 원본 (judgeData 기준 int32 인덱스) |
| `playDataWords` | 8 | PlayData 에서 읽는 칸 수 |
| `currentSongWords` | 5 | CurrentSong 에서 읽는 칸 수 (word 0 곡 ID, word 1 난이도, word 4 노트 수) |
| `songStride` | 0x730 | 곡 엔트리 크기 |
| `songIdOffset` | 0x5B0 | 곡 ID (int32) |
| `songNoteOffset` | 0x370 | 난이도별 노트 수 int32 × 10 (SPB, SPN, SPH, SPA, SPL, DPB, DPN, DPH, DPA, DPL) |
| `songTitleBytes` | 0x100 | 곡 제목 (UTF-16LE) |

> **배틀 플래그 주의:** Reflux 소스(`Settings.cs`)는 배틀을 `word 8`(= 0x20)에서 읽지만, 이 빌드(2026101400)에서는 그 자리가 바뀌지 않았습니다. 실측으로 **0x28** 이 배틀 ON/OFF 와 정확히 맞았습니다(ON 두 번, OFF 한 번 확인). 이 차이 때문에 Reflux 의 설정 판정은 배틀을 놓칠 수 있습니다.

## 4. 상태 판정과 저장 시점

Reflux `Utils.FetchGameState` 와 같은 규칙입니다.

1. 판정 블록 `judgeData + 144` 근처 96바이트에서 값이 10000 을 넘는 int32 세 개를 찾습니다. 세 값이 8바이트 간격이면 두 번째 위치 + 24 가 **마커**입니다. 한 번 찾으면 주소를 재사용합니다.
2. 마커 값이 **0 이 아니면 플레이 중**입니다.
3. 마커가 0 이면 `PlaySettings - 0x18` 값을 봅니다. 값이 1 이면 **선택 화면**, 아니면 **결과 화면**입니다.
4. 직전 상태가 플레이 중이고 지금이 플레이 중이 아니면 결과 전환으로 보고, **1.5초 뒤** 값을 읽어 한 줄을 씁니다. 1.5초는 결과 화면 값이 안정될 때까지 기다리는 시간입니다.

폴링 간격은 게임에 붙어 있을 때 500ms, 떠 있지 않을 때 2초입니다. 게임 종료 등으로 읽기가 실패하면 핸들을 버리고 다시 붙습니다.

## 5. 배틀 모드 처리

배틀은 게임이 기록을 저장하지 않아서 **PlayData 가 전부 0** 입니다(곡 ID 0, EX 0 ...). 하지만 판정 블록과 설정 블록은 일반 플레이처럼 채워집니다. 그래서 `resolvePlay` (`playLog.ts`) 가 아래 순서로 곡·점수를 정합니다.

1. **배틀 플래그 ON** → CurrentSong 경로 (PlayData 에 이전 플레이 값이 남아 있어도 무시).
   - 곡 ID = CurrentSong word 0, 난이도 = word 1 (**SP 인덱스**: 0 BEGINNER · 1 NORMAL · 2 HYPER · 3 ANOTHER · 4 LEGGENDARIA), 노트 수 = word 4.
   - EX = `2 × (P1 PGREAT + P2 PGREAT) + (P1 GREAT + P2 GREAT)`, 미스 = 양쪽 BAD + POOR 합. PGREAT·GREAT 총합도 판정 블록 양쪽 합.
   - 클리어 램프는 저장되지 않으므로 `-1`.
   - 곡명은 곡 목록에서 곡 ID 로 조회합니다.
2. **배틀이 아니면** → PlayData 를 그대로 사용.
3. 어느 쪽도 쓸 수 없으면(일반인데 PlayData 가 비었거나, 배틀인데 CurrentSong 이 비었을 때) **저장하지 않고** 진단 로그에 `skipped` 를 남깁니다. 곡 ID 0 의 쓸모없는 줄이 쌓이지 않게 하는 안전장치입니다.

**배틀의 노트 수는 양쪽 합계(= 차트 노트 × 2)** 입니다. 양쪽이 같은 SP 차트를 치기 때문입니다.
예: The 88's Instigation SPH = 836노트 → CurrentSong word 4 = **1672**. Din Don Dan SPA = 1075노트 → **2150**.
`dj_rate_pct` 는 합계 EX / (합계 노트 × 2) 이므로 양쪽 평균 레이트와 같습니다.

`source` 열(`playdata` / `currentsong`)로 어느 경로로 만든 줄인지 구분할 수 있습니다.

## 6. CSV 열

한 줄 = 결과 화면 한 번. 신규 CSV 헤더는 21개 열입니다. 기존 19개 헤더는 그대로 유지하며, 업로드 파서는 19/21열 혼합 행을 모두 허용합니다.

```csv
timestamp,song_id,title,difficulty,notes,ex_score,pgreat,great,miss_count,clear_lamp,dj_rate_pct,dj_rank,judge_16,settings_p1_11,settings_p2_11,battle_flag,gauge_p1_w77,gauge_p2_w78,source,app_version,game_version
```

기존 19개 열 뒤에 `app_version`, `game_version`이 추가됩니다. 19열 레거시 행의 두 버전 값은 빈 문자열로 정규화합니다. 버전 확보에 실패해도 오류 코드나 offsets fallback 버전을 넣지 않고 빈 문자열을 사용합니다.

기록·업로드 오류 행도 21개 문자열 필드입니다. `timestamp`는 오류 발생 시각 또는 업로드 시각의 실제 ISO 시각이고, `song_id`부터 `source`까지 18개 칸은 같은 음수 정수 문자열입니다. 마지막 두 버전 칸은 확보한 실제 버전이며 확보하지 못하면 빈 문자열입니다. 오류 판별은 timestamp와 버전을 제외한 18개 값이 같은 음수 정수 문자열인지로 합니다. `clear_lamp=-1` 하나만으로 오류로 판정하지 않습니다. INF 배틀 기록에는 `clear_lamp=-1`인 정상 행이 있습니다.

오류 코드는 다음과 같습니다.

| 코드 | 의미 |
|---|---|
| -1 | 저장 시 ID 읽기 실패·무효·pid 불일치 |
| -2 | 저장 메모리에서 판 없음 |
| -3 | 저장 메모리 읽기 예외 |
| -4 | CSV 디렉터리·헤더·행 쓰기 실패 |
| -5 | attach 뒤 30,000ms 동안 마커 미발견 |
| -6 | 게임은 있으나 offsets 읽기 실패 또는 없음 |
| -7 | offsets 필수 키 누락 또는 0 |
| -8 | CSV 없음(ENOENT) |
| -9 | CSV 헤더 불일치 |
| -10 | 유효한 완결 행 없음 |
| -11 | CSV 읽기 실패·IPC 거부·API 없음 |

attach 성공 뒤 30,000ms 동안 마커가 없으면 한 번 진단합니다. ID가 있으면 오류 행을 기록하고, 없으면 diag에만 남깁니다. 이후 offsets 재attach는 마커 탐색을 다시 시작합니다. 중복 pid 구간에서는 같은 오류를 한 번만 기록합니다. ID 없는 오류와 -4는 diag 전용이며 큐·재시도는 없습니다. 이미 잡은 마커는 재검증하지 않습니다. pending 업로드도 매 시도마다 CSV를 다시 읽습니다.

renderer는 fresh 읽기와 정규식 검증을 통과한 ID를 `{pid, iidxId}`로 main에 전달합니다. main은 자체 ID 읽기를 먼저 수행하고, 자체 읽기가 실패하거나 무효일 때만 같은 pid의 전달값을 대체로 사용합니다.

기존 500ms/1500ms 타이밍과 실제 판 경계 계산은 유지됩니다. 기록기는 기존 결과 전환 조건으로 판을 저장하며 타이밍 설명은 변경하지 않습니다.

> **play_speed 추가(22번째 열)**: 위 21개 열 뒤에 `play_speed` 가 붙습니다. 공용 `PLAY_CSV_KEYS` 는 21열 그대로이며 기록기 헤더만 22열입니다. 자세한 내용은 11장.

| 열 | 값의 출처 | 설명 |
|----|-----------|------|
| `timestamp` | 저장 시각 (UTC, ISO) | 결과 화면으로 넘어간 시각 |
| `song_id` | PlayData word 0 | 곡 ID |
| `title` | 곡 목록에서 ID 로 조회 | 곡명 (UTF-16LE, 따옴표 이스케이프) |
| `difficulty` | PlayData word 1 → `DIFF_NAMES` | 예: `DPA` |
| `notes` | 곡 목록 노트 수 (난이도별). 배틀은 CurrentSong 노트 수 | 해당 차트의 총 노트 수. **배틀은 양쪽 합계(차트 × 2)** |
| `ex_score` | PlayData word 2 | EX 스코어 (= 2 × PGREAT + GREAT 와 같음) |
| `pgreat` / `great` | PlayData word 4, 5 | 총합 (P1 + P2) |
| `miss_count` | PlayData word 3 | 미스 카운트 |
| `clear_lamp` | PlayData word 6 | 램프 번호 (1 = FAILED, 3 = E-CLEAR 로 확인). 배틀은 `-1` |
| `dj_rate_pct` | 계산 | `ex_score / (notes × 2) × 100`, 소수 둘째 자리 |
| `dj_rank` | 계산 | 레이트 기준 AAA(8/9) · AA(7/9) · A(6/9) · B(5/9) · C(4/9) · D(3/9) · E(2/9) · F |
| `judge_16` | judgeData 0..15 | 공백 구분. 순서: P1 PGREAT·GREAT·GOOD·BAD·POOR, P2 같은 순서, P1 콤보 브레이크, P2 콤보 브레이크, P1 FAST, P2 FAST, P1 SLOW, P2 SLOW |
| `settings_p1_11` | playSettings 11 int32 | 원본. 워드 0 스타일(왼쪽 레인), 1 게이지, 2 어시스트, 3 FLIP(좌우 위치), 4 범위, 5 스타일(오른쪽 레인, DP), 8 배틀(Reflux 값, 이 빌드에서는 0 — 아래 참고), 10 배틀(+0x28). 값의 뜻은 아래 6.1 표 |
| `settings_p2_11` | playSettings + 0x48 | P2 쪽 같은 구조 |
| `battle_flag` | playSettings + 0x28 | 배틀 ON = 1 |
| `gauge_p1_w77` / `gauge_p2_w78` | judgeData 77, 78 | 게이지 원본 값 (아래 한계 참고) |
| `source` | 계산 | `playdata` = 일반 플레이(PlayData), `currentsong` = 배틀(CurrentSong + 판정 블록, 5장) |
| `play_speed` | playSettings + 0x17A0 (int32 단계) → `1.5 - 0.05 x 값` | 곡 재생 속도 배율. `0.70` = 0.7배, `1.00` = 등속. 못 읽으면 빈 값. 속도 ≠ 1.00 판의 저장 방식은 11.3 |

- `settings_p1_11` 의 워드 8 은 Reflux 가 배틀로 읽는 칸이지만 이 빌드에서는 배틀과 무관합니다. 배틀 판정은 `battle_flag` 열을 쓰세요.
### 6.1 옵션 값 해석

`settings_p1_11` / `settings_p2_11` 은 공백으로 구분한 int32 11개입니다. 위치별 의미와 값 이름은 Reflux `Settings.cs` 와 같습니다.

| 위치 (0부터) | 항목 | 값 |
|--------------|------|----|
| 0 | 스타일 (왼쪽 레인) | 0 OFF · 1 RANDOM · 2 R-RANDOM · 3 S-RANDOM · 4 MIRROR · 5 SYNCHRONIZE RANDOM · 6 SYMMETRY RANDOM |
| 1 | 게이지 | 0 OFF · 1 ASSIST EASY · 2 EASY · 3 HARD · 4 EX HARD |
| 2 | 어시스트 | 0 OFF · 1 AUTO SCRATCH · 2 5KEYS · 3 LEGACY NOTE · 4 KEY ASSIST · 5 ANY KEY |
| 3 | FLIP (좌우 위치) | 0 OFF · 1 FLIP |
| 4 | 범위 | 0 OFF · 1 SUDDEN+ · 2 HIDDEN+ · 3 SUD+ & HID+ · 4 LIFT · 5 LIFT & SUD+ |
| 5 | 스타일 (오른쪽 레인, DP) | 위치 0 과 같은 값 |
| 10 | 배틀 (+0x28) | 0 OFF · 1 ON (`battle_flag` 열과 같은 값) |

- 위치 6~9 는 이 기록기에서 쓰지 않습니다. 위치 8 은 Reflux 가 배틀로 읽던 칸이지만 이 빌드에서는 배틀과 무관합니다.
- **DP 는 `settings_p1_11` 한 블록만 보면 됩니다.** 왼쪽 레인 스타일은 위치 0, 오른쪽 레인은 위치 5 입니다. `settings_p2_11` 은 SP 를 2P 쪽으로 칠 때의 값입니다.
- 이름으로 풀어 쓴 열은 따로 없으므로, 필요하면 위 표로 풀어서 읽습니다.

예시 (2026-10-14 실제 줄):

| 상황 | `settings_p1_11` | 해석 |
|------|--------------------|------|
| 양쪽 랜덤 배틀 | `1 1 1 0 5 1 0 0 0 0 1` | 왼쪽 RANDOM, 오른쪽 RANDOM, ASSIST EASY, AUTO SCRATCH, FLIP OFF, LIFT & SUD+, 배틀 ON |
| 한쪽만 랜덤 배틀 | `1 1 1 0 5 0 0 0 0 0 1` | 왼쪽 RANDOM, 오른쪽 OFF, ASSIST EASY, AUTO SCRATCH, LIFT & SUD+, 배틀 ON |
| 일반 더블 | `0 2 0 0 5 0 0 0 0 0 0` | 양쪽 OFF, EASY, 어시스트 OFF, LIFT & SUD+, 배틀 OFF |

위 세 상황의 **CSV 전체 줄** (2026-10-14 실제 저장 값, 열 순서는 6장 표와 같음):

```csv
# 양쪽 랜덤 배틀 — Bang Pad(Werk Mix) SPA, source=currentsong
2026-10-14T14:48:45.825Z,80121,"Bang Pad(Werk Mix)",SPA,1662,1637,656,325,126,-1,49.25,C,"271 161 219 38 53 385 164 138 7 28 68 32 64 66 316 236","1 1 1 0 5 1 0 0 0 0 1","0 2 0 0 5 0 0 0 0 0 0",1,0,8,currentsong
# 한쪽만 랜덤 배틀 — The 88's Instigation SPH, source=currentsong
2026-10-14T14:51:17.972Z,80126,"The 88's Instigation",SPH,1672,1788,719,350,114,-1,53.47,C,"304 161 225 33 57 415 189 132 7 17 66 20 105 127 281 194","1 1 1 0 5 0 0 0 0 0 1","1 1 1 0 5 1 0 0 0 0 1",1,0,90,currentsong
# 일반 더블 — NEPHILIM DELTA DPA, source=playdata
2026-10-14T11:14:50.321Z,80118,"NEPHILIM DELTA",DPA,1631,1825,674,477,154,1,55.95,B,"292 224 232 39 79 382 253 150 5 31 77 21 179 189 277 214","0 2 0 0 5 0 0 0 0 0 0","0 2 0 0 5 0 0 0 0 0 0",0,0,24,playdata
```

- 배틀 두 줄은 PlayData 가 비어 있어서 곡 정보를 CurrentSong 에서 읽었고(`source=currentsong`), 노트 수는 양쪽 합계(831 × 2 = 1662, 836 × 2 = 1672), 클리어 램프는 `-1` 입니다.
- 일반 더블은 PlayData 를 그대로 써서(`source=playdata`) 클리어 램프 `1`(FAILED)이 들어 있습니다.
- 위 `#` 줄은 설명용이고 실제 CSV 에는 없습니다.

## 7. 검증 기록 (2026-10-14, 게임 화면과 대조)

프로토타입 기록기(같은 판정 규칙)가 읽은 값과 결과 화면을 대조했습니다.

| 곡 (차트) | 화면 | 메모리 값 | 결과 |
|-----------|------|-----------|------|
| Din Don Dan (DP ANOTHER 10, 중단 후 FAILED) | 점수 1520, PGREAT 642, GREAT 236, GOOD 77, BAD 4, POOR 14, 콤보 브레이크 15, FAST 139, SLOW 174 | 두 쪽 합계 동일 | 일치 |
| Din Don Dan (DP ANOTHER 10, 일반 모드) | 점수 1748, PGREAT 751, GREAT 246, GOOD 52, BAD 4, POOR 6, 콤보 브레이크 9, FAST 160, SLOW 138, 미스 10 | 751 / 246 / 52 / 4 / 6, 콤보 브레이크 9, FAST 160, SLOW 138, 미스 10 | 일치 |
| Deep tenDon Reflex (DP ANOTHER 12) | 점수 1983, PGREAT 776, GREAT 431, 노트 1453, 미스 58 | 776 / 431 / 211 / 10 / 48, 콤보 브레이크 35, FAST 317, SLOW 325, 미스 58, 노트 1453 | 일치 |

- 곡 조회: 곡 ID 80123 → `Deep tenDon Reflex`, DPA 노트 1453. 곡 ID 80127 → `Din Don Dan`, DPA 노트 1058. 둘 다 화면과 일치.
- EX 스코어: `2 × 776 + 431 = 1983`, 화면 점수와 일치.
- 배틀 플래그: +0x28 위치에서 ON 두 번, OFF 한 번 대조해서 확인.
- 배틀 플레이 (The 88's Instigation SPH, 양쪽 SP): PlayData 0, CurrentSong `80126 2 0 14 1672`, 배틀 플래그 1. 판정 블록 `304 161 225 33 57 | 415 189 132 7 17 ...` → PGREAT 719, GREAT 350, EX 1788, 미스 114, 노트 1672, 레이트 53.47%, DJ 레벨 C 로 저장.
- 배틀 노트 수 교차 확인: Din Don Dan 배틀 결과 화면의 2150 = SPA 노트 1075 × 2, The 88's Instigation 의 1672 = SPH 노트 836 × 2.
- 실제 배포 버전의 저장 동작은 다음 플레이에서 확인해야 합니다. 이 실행에서는 아직 결과 전환이 없었습니다.

## 8. 알려진 한계

- **레인별 판정, 히스토그램은 저장하지 않습니다.** 결과 화면에서 등급(레인별 평가)과 그래프로만 나오고, 숫자로 된 값을 메모리에서 찾지 못했습니다. 1MB 범위에서 레인 합 조건으로 찾아봤지만 실제 레인 구조는 특정하지 못했습니다.
- **게이지 값의 의미는 확정되지 않았습니다.** Reflux 가 종료 시 게이지로 읽는 위치와 같은 칸이고, E-CLEAR 에서 98 이 나온 것은 자연스럽습니다. 하지만 FAILED 곡에서 0 이 아닌 값(예: 56, 24)이 나와서 "실패하면 0" 가정과 맞지 않습니다. 현재는 "종료 시 게이지"로 사용하되, 필요하면 결과 화면 게이지 그래프와 다시 대조하세요.
- **결과 화면 캡처는 넣지 않았습니다.** 1.5초 뒤 캡처가 로딩 화면이 되는 문제가 있었고, 값 저장으로 충분해서 제거했습니다.
- **Reflux 가 설치되고 `offsets.txt` 가 있어야 합니다.** 파일이 없으면 기록기는 대기만 합니다.
- **노트 수는 곡 목록 기준입니다.** 곡 목록 구조가 바뀌면 `title` 과 `notes` 가 비거나 0 이 됩니다.
- **SP 플레이 검증은 제한적입니다.** 2P 로 한 SP 플레이는 P2 블록에 값이 들어갔지만, 1P SP 는 아직 확인하지 않았습니다. 일반 SP 에서 PlayData 의 난이도 값이 SP 인덱스(0~4)로 나오는지, 판정이 P1 블록에만 들어가는지는 실제 플레이로 확인이 필요합니다.
- **배틀 노트 수 규칙은 SP 차트 두 곳(836×2, 1075×2)에서만 확인했습니다.** 배틀 중 CurrentSong word 4 가 항상 "차트 노트 × 2" 인지는 더 확인이 필요합니다.
- **배틀 램프는 CSV의 `clear_lamp=-1` 대신 게이지로 계산합니다.** 전송용 기본 게이지 열은 `GAUGE_COLUMN = 'gauge_p2_w78'`이며, 이는 사용자 지정값입니다. 게임 결과 화면과 대조 확인은 아직 하지 않았습니다. 원본 CSV에는 두 게이지 값이 모두 그대로 저장됩니다.

## 9. 패치 후 점검

1. Reflux 의 `offsets.txt` 가 새 빌드 값으로 갱신됐는지 확인합니다(Reflux 가 자동 갱신하거나 gist 로 배포).
2. 플레이 한 번 후 `plays.csv` 에 새 줄이 추가되는지, `title` 과 `notes` 가 채워지는지 봅니다.
3. 판정 합계가 결과 화면과 맞는지 봅니다. `ex_score = 2 × pgreat + great` 가 깨지면 PlayData 칸이 바뀐 것입니다.
4. `title` 이 비면 곡 목록 구조(`songStride`, `songIdOffset`, `songNoteOffset`)를 확인합니다.
5. 상태 전환이 안 되면 마커 탐색(`markerScanFromJudge`, `markerDelta`)을 확인합니다.
6. 배틀 플래그가 어긋나면 `battleFlagDelta` 를 다시 찾습니다(배틀 ON/OFF 두 번 읽고 바뀌는 칸 비교).
7. 배틀 한 판 후 `source = currentsong` 줄이 생기고 곡명·난이도가 맞는지, `notes` 가 차트 노트의 두 배인지 확인합니다. 곡 ID 가 0 이면 `currentsong` 주소가 offsets.txt 에서 빠졌거나 CurrentSong 구조가 바뀐 것입니다.

## 10. 테스트

```bash
node --test src/main/*.test.mjs   # 기록기·순수 로직 41개 (배틀 보정·play_speed·속도 ≠ 1.00 포함)
npm run typecheck:node                  # 타입 검사
```

게임과 연결된 동작은 자동 테스트가 없습니다. 실제 플레이로 확인합니다.

## 플레이 업로드 연결

저장할 행이 없으면 `skipped` 로그만 남기고 알림을 보내지 않습니다. append 성공 후 `{iidxId}` 알림이 main → preload → renderer로 전달되어 기존 자동 업로드 예약을 다시 확인합니다. CSV만 증가해도 예약을 깨우며 기존 3분 최소 간격과 초기 안정 대기 2초를 유지합니다. 계정 전환으로 기록기를 재시작하지 않습니다.

CSV의 19개 원본 문자열(source 포함)을 파일 순서로 마지막 100개 선택합니다. SP/DP/배틀 필터나 채보별 합치기 없이 따옴표·쉼표·한글을 보존하고 헤더와 불완전 마지막 레코드를 제외합니다. `UploadSnapshot.plays` → `UploadInput.plays` → `upsert_user.p_plays`로 전달합니다. 생략/NULL은 DB 값 유지, 빈 배열은 교체입니다.

게임 인식은 plays 캡처와 전송 직전, 자동 DBR 전송에만 적용합니다. 게임 종료 후 수동/pending/종료 업로드는 계속 실행하며 pending에 담긴 plays도 게임 없이 보내지 않습니다. 재시작 시 기존 pending 흐름을 유지합니다.

DBR 변환은 `decodeBattleRandomPlay`에 격리합니다. 19열 CSV에서 `battle_flag=1`, `settings_p1_11`의 p1[0]=1, p1[5]=1, p1[2]=1인 SP 기록을 후보로 삼습니다. R-RANDOM(2)·S-RANDOM(3)은 제외하며 p2 옵션은 자격 조건에 쓰지 않습니다. `song_id`, `ex_score`, `notes`는 CSV 값을 그대로 숫자로 해석하고, notes는 유효성 확인에만 씁니다. 램프는 `clear_lamp=-1`을 참조하지 않고 게이지 종류(p1[1])와 `gauge_p2_w78`로 계산합니다. `GAUGE_COLUMN`은 사용자 지정 기본값이며 화면 대조 확인은 아직 남아 있습니다(8장 한계 참조).

조건을 만족하는 후보만 기존 원격 issue/exchange/Bearer 세션과 `/api/me/dbr-scores`를 통해 `improvements_only:true`로 순서대로 전송합니다. 후보가 아닌 행도 plays에는 그대로 포함합니다. 새 커서·최고값 저장소·재시도 큐는 없습니다.

## 배치 자동 저장 (chart-arrange)

기존 App의 `onPlayAppend` 구독과 `readPlayCsv`를 사용합니다. 읽은 시점의 마지막 완결 행만 이번 판으로 보고, 그 앞의 완결 행은 이력으로 비교합니다. 플레이 업로드는 CSV의 최근 100판을 보내지만 배치 자동 저장은 CSV 전체 이력을 읽어 비교합니다.

대상은 완주한 일반 DP이며 assist와 H-RAN은 OFF, 알려진 양손 옵션 조건을 만족해야 합니다. `judge_16`은 정확히 16개의 유한 정수여야 하며, 아니면 완주가 아닙니다. `j=judge_16`의 완주 판정식은 `notes > 0 && (j[0]+j[1]+j[2]) + (j[5]+j[6]+j[7]) + j[10] + j[11] === notes`입니다. 양손의 PGREAT+GREAT+GOOD와 양쪽 콤보 브레이크를 합산합니다. 콤보 브레이크는 BAD+놓친 POOR이며 공POOR는 제외됩니다. BP(`miss_count`)는 BAD+POOR(공POOR 포함)인 게임 BP 값을 그대로 사용합니다. 근거는 기존 실측 표의 [7장 judge_16 실측](play-logger.md#7-검증-기록-2026-10-14-게임-화면과-대조)입니다.

비교는 완주한 일반 DP 행끼리만 합니다. 램프는 증가, BP는 감소, EX는 증가를 각각 개선으로 보고 세 항목 중 2개 이상 개선될 때 `chart-arrange` PUT을 저장합니다. 이전 유효값이 없거나 값이 동점이면 해당 항목은 개선으로 세지 않습니다. 기본 정배는 -2이며, 수동 배치 덮어쓰기와 DBR 수준 인증 재사용을 적용합니다.

같은 계정 CSV에서 `timestamp`+`song_id`+`difficulty` 조합을 Set으로 중복 배제하며, 계정별 단순 Promise 체인으로 처리합니다. 오류 로그는 남기지만 자동 재시도는 없습니다. 빠른 알림이 같은 마지막 행을 다시 읽을 수 있어 중간 판의 전송은 보장하지 않습니다.

기록기 19열 및 tick/settle/append, main/preload는 변경하지 않았습니다. 매 알림마다 CSV 전체를 읽으므로 이력에 비례한 비용이 들며, CSV에서 삭제된 과거 기록은 복원할 수 없습니다.

## 11. play_speed 열 (곡 재생 속도) — 변경 내역과 서버 작업 안내

INFINITAS 의 옵션창 「楽曲再生速度変更」(곡 재생 속도, 결과 화면의 `PLAY SPEED 0.70`)을 CSV 마지막에 기록합니다. **하이스피드와 무관**하고 곡 자체를 느리게/빠르게 하는 배율입니다. 다른 PC 에서 받아 서버를 고칠 때 이 장만 보면 됩니다.

### 11.1 열 정의

| 항목 | 내용 |
|------|------|
| 열 이름 | `play_speed` (CSV 22번째, 맨 끝) |
| 값 | `0.70`, `1.00`, `1.05` 처럼 **소수 둘째 자리 문자열**. 1.00 = 등속, 0.70 = 0.7배 |
| 빈 값 | 속도를 읽지 못했거나 범위 밖. **NULL 로 받을 것** |
| 오류 행(-1…-11) | 맨 끝에 열이 없을 수 있다(21칸). 오류 행은 `play_speed` 가 없는 것으로 처리 |
| 기록 시점 | 결과 화면 저장 시점의 옵션창 설정값 (그 판에 적용된 값) |

### 11.2 값을 읽는 방법 (실측)

- 위치: **`playSettings + 0x17A0`** 의 int32 한 개 (이 빌드 `2026101400` 기준 절대 주소 `0x1425DB8F4`). `offsets.txt` 의 `playSettings` 만 있으면 되고 새 키는 필요 없습니다. 모듈 안의 고정 주소라 플레이 중이 아니어도 읽힙니다.
- 이 값은 속도가 아니라 **목록 안 단계 번호**입니다. 변환식은 **속도 = 1.5 − 0.05 × 값** 입니다 (`playSpeedFromSettingValue`, `playLog.ts`).

| 옵션창 속도 | 1.50 | 1.05 | 1.00 | 0.90 | 0.85 | 0.80 | 0.70 |
|-------------|------|------|------|------|------|------|------|
| 읽은 값 | 0 | 9 | 10 | 12 | 13 | 14 | 16 |

위 7개 점을 실제 게임에서 옵션창 값을 바꿔 가며 읽어 확인했습니다 (2026-10-28). **0.70 미만(0.50 등)은 미확인**이며, 코드는 값 0~30 을 받아 변환하고 그 밖은 빈 값으로 둡니다.
- 처음 시도했던 `judgeData + 0x68C` (float 0.70 이 보임)는 **옵션 변경이 바로 반영되지 않아** 쓰지 않습니다.

### 11.3 속도가 1.00 이 아닌 판의 저장 (중요)

옵션창 안내문대로 **1.00 이외 속도로 한 플레이는 게임이 PlayData 를 저장하지 않습니다.** 실측으로 PlayData 가 전부 0 이었고, 그대로면 기록기는 곡 정보 없음(`-2`) 오류 행만 남깁니다. 그래서 `speedChanged`(속도 ≠ 1.00)일 때는 배틀(5장)과 같은 방식으로 만듭니다.

- 곡 ID·난이도·노트 수: CurrentSong (`[곡 ID, SP 난이도 번호, ?, ?, 노트 수]`. 실측 `[30006, 3, 0, 14, 2000]` = IDENTITY, ANOTHER, 2000노트)
- EX·PGREAT·GREAT·미스: 판정 블록의 양쪽 합 (배틀과 같은 식)
- **SP/DP 구분**: CurrentSong 의 노트 수를 곡 목록의 SP 차트·DP 차트 노트 수와 비교해, DP 와만 같으면 DP (난이도 번호 +5, 예 `3` → `DPA`). 둘 다 같거나 못 찾으면 P2 판정 합이 0 보다 크면 DP
- `clear_lamp` = `-1` (저장되지 않은 플레이라 램프를 알 수 없음), `source` = `currentsong`

### 11.4 바뀐 파일

| 파일 | 변경 |
|------|------|
| `src/main/playLog.ts` | `playSpeedFromSettings = 0x17a0`, `playSpeedFromSettingValue()`, `formatPlaySpeed()`, `PLAY_LOG_HEADER_V2`(21열)·`PLAY_LOG_HEADER`(22열), `PlaySnapshot.playSpeed`, `resolvePlay` 의 `speedChanged`/`chartNotes` 분기 |
| `src/main/playLogger.ts` | 속도 단계 읽기, `speedChanged` 일 때 SP/DP 노트 수 조회 후 `resolvePlay` 호출, 계정 CSV 첫 줄이 21열 헤더면 22열로 교체(`upgradeHeader`) |
| `src/main/playLog.test.mjs`, `playLogger.test.mjs` | 22열·`play_speed` 값, 변환표, 속도 ≠ 1.00 경로 테스트 추가 |
| `src/shared/uploadSnapshot.ts` | **변경 없음** (공용 `PLAY_CSV_KEYS` 는 21열 그대로) |

### 11.5 서버·업로더 작업 목록 (이 변경으로 깨지거나 해야 할 것)

1. **업로더가 새 CSV 를 거부합니다.** `src/renderer/src/supabaseSync.ts` 의 `parsePlayHistoryDetailed` 는 헤더가 19열 또는 21열 키와 정확히 일치해야 하며, 22열 헤더면 `-9`(헤더 불일치) 오류 행만 업로드합니다. 행 길이도 19/21 이 아니면 버립니다. 서버 연동을 되살리려면 `PLAY_CSV_KEYS` 에 `play_speed` 를 넣고 헤더·행 검사에 22열(과 기존 19/21열)을 허용해야 합니다.
2. **서버 스키마**: 최근 플레이 R2 JSON(`PUT /api/me/plays`)과 Supabase 쪽에 `play_speed`(문자열 `"0.70"` 또는 빈 값 → `numeric(4,2) NULL`) 필드를 받도록 추가.
3. **옛 줄**은 19/21칸 그대로 남아 있고 `play_speed` 는 NULL 입니다. **1.00 으로 간주하지 마세요**. 그 시절 속도는 알 수 없습니다.
4. **점수 비교 정책**: 같은 곡·난이도라도 속도가 다르면 점수를 비교할 수 없습니다(느리면 쉬움). 랭킹·추천·레이더·DBR 에 섞기 전에 `play_speed IS NULL OR play_speed = 1.00` 만 쓸지 정해야 합니다. 속도 ≠ 1.00 판은 `clear_lamp = -1` 이고 게임 자체도 기록으로 저장하지 않는 플레이입니다.
5. `isCompletedPlay` 등 완주 판정은 `judge_16` 합과 `notes` 를 쓰므로 속도 ≠ 1.00 판도 통과합니다. 제외하려면 `play_speed` 를 확인하세요.

### 11.6 검증 상태 (2026-10-28)

- [x] 단위 테스트 `node --test src/main/*.test.mjs` 41개 통과, `npm run typecheck` 오류 0
- [x] 옵션창 값을 1.50 / 1.05 / 1.00 / 0.90 / 0.85 / 0.80 / 0.70 으로 바꿔 가며 `playSettings + 0x17A0` 값 확인
- [x] 0.70 DP 플레이 뒤 PlayData 가 전부 0, CurrentSong 이 `[30006, 3, 0, 14, 2000]` 인 것 확인
- [x] 0.70 으로 실제 DP 한 판 한 직후의 라이브 메모리에 새 로직을 돌려 줄 생성 확인 (2026-10-28): PlayData 전부 0, CurrentSong `[30006, 3, 0, 14, 2000]`, 단계 값 16 → `0.70`, 결과 `[ ]DENTITY, DPA, 노트 2000, EX 2549, 63.73%, B, source=currentsong, clear_lamp=-1, play_speed=0.70`. 같은 판에서 설치본 0.0.155(이 변경 없음)는 `skipped: 저장할 플레이 정보가 없음` 으로 건너뜀
- [ ] 이 브랜치 빌드를 앱으로 실행해 `plays.csv` 파일에 실제로 줄이 append 되는지 — 미확인 (위 확인은 같은 로직을 단독 스크립트로 돌린 것)
- [ ] 0.70 미만 속도의 값, 판 도중 속도를 바꾸는 경우 — 미확인

### 11.7 알려진 한계

- 읽는 값은 결과 화면 시점의 옵션창 설정입니다. 판 도중에 바꾸는 방식이면 마지막 값만 남습니다.
- SP 를 2P 쪽으로 치는 경우, 노트 수가 SP/DP 와 모두 같을 때만 P2 판정 합 휴리스틱이 쓰여 DP 로 잘못 볼 수 있습니다(드묾).
- 게임 업데이트로 구조가 바뀌면 `0x17A0` 이 어긋납니다. 9장 점검 순서와 함께, 옵션창 속도를 바꿔 가며 같은 단계 값이 따라가는 칸을 다시 찾으세요(모듈 메모리 스냅샷 diff 로 `playSettings` 근처에서 찾음).
