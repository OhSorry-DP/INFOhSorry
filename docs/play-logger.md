# 플레이 기록기 — 결과 화면마다 메모리 값을 CSV 로 저장

> 게임(INFINITAS, `bm2dx.exe`)이 저장하지 않는 **배틀 모드 기록**과, 게임이 보여 주는 결과 값(곡명, 노트 수, 점수, DJ 레벨, 게이지, 판정)을 플레이마다 로컬 CSV 로 남기는 기능입니다.
> 상위 조망: [`../../docs/INFOhSorry.md`](../../docs/INFOhSorry.md) · 인덱스: [README.md](README.md) · 메모리 리딩 기반: [memory-reading.md](memory-reading.md)

---

## 1. 무엇을 하는가

- 실행 중인 `bm2dx.exe` 메모리를 주기적으로 읽습니다.
- **플레이 중 → 결과 화면**으로 바뀌는 순간에만 한 줄을 추가합니다. 결과 화면이 떠 있는 동안 여러 줄이 쌓이지 않습니다.
- 결과 화면을 벗어나 선택 화면으로 가도 줄은 추가되지 않습니다.
- 중단(Quit)한 플레이도 결과 화면이 뜨면 저장됩니다. 게임 기록에 남지 않는 **배틀 모드**도 저장됩니다(곡 정보를 얻는 방식이 다릅니다 — 5장).
- 모든 데이터는 로컬 파일에만 저장됩니다. 외부 서버로 보내지 않습니다.

## 2. 파일 구성

| 파일 | 역할 |
|------|------|
| `src/main/playLog.ts` | 순수 로직 (메모리 I/O 없음). 상태 판정, 마커 탐색, 곡 조회, CSV 행 생성, `offsets.txt` 파싱 |
| `src/main/playLogger.ts` | 런타임. 게임 붙기/떼기, 주기 폴링, 결과 전환 감지, CSV 추가 |
| `src/main/playLog.test.mjs` | 순수 로직 단위 테스트 (`node --test src/main/playLog.test.mjs`) |
| `src/main/index.ts` | 앱 시작(`whenReady`)에 `startPlayLogger` 호출, 종료(`before-quit`)에 정지 |

**출력 위치:** `%APPDATA%\ohSorryScoreINF\play-log\plays.csv`
(`app.getPath('userData')/play-log/plays.csv`). 앱 로그는 `appendDiagLine` 으로 같은 진단 로그에 남깁니다.

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

한 줄 = 결과 화면 한 번. 헤더 19개 열입니다.

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
| `settings_p1_11` | playSettings 11 int32 | 원본. 워드 0 스타일, 1 게이지, 2 어시스트, 3 미러 플립, 4 범위, 5 P2 스타일(DP), 8 배틀(Reflux 값, 이 빌드에서는 0 — 아래 참고), 10 배틀(+0x28) |
| `settings_p2_11` | playSettings + 0x48 | P2 쪽 같은 구조 |
| `battle_flag` | playSettings + 0x28 | 배틀 ON = 1 |
| `gauge_p1_w77` / `gauge_p2_w78` | judgeData 77, 78 | 게이지 원본 값 (아래 한계 참고) |
| `source` | 계산 | `playdata` = 일반 플레이(PlayData), `currentsong` = 배틀(CurrentSong + 판정 블록, 5장) |

- `settings_p1_11` 의 워드 8 은 Reflux 가 배틀로 읽는 칸이지만 이 빌드에서는 배틀과 무관합니다. 배틀 판정은 `battle_flag` 열을 쓰세요.
- 설정 값 해석 표(스타일, 게이지, 어시스트, 범위 이름)는 Reflux `Settings.cs` 와 같습니다.

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
- **배틀의 클리어 램프와 게이지는 기록되지 않거나 의미가 불명확합니다.** 램프는 `-1`, 게이지는 원본 값 그대로 저장합니다.

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
node --test src/main/playLog.test.mjs   # 순수 로직 13개 (배틀 보정 포함)
npm run typecheck:node                  # 타입 검사
```

게임과 연결된 동작은 자동 테스트가 없습니다. 실제 플레이로 확인합니다.
