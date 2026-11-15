# 새 INFINITAS 빌드 메모리 offset 갱신 런북

> 게임이 패치되어 앱 증상이 나타났을 때, **빠짐없이** offset 을 찾아 반영하고 검증하는 절차입니다.
> 2026111100 빌드 갱신(2026-11-15)에서 실제로 쓴 방법과, 그때 겪은 누락·함정을 정리했습니다.
> 찾기 단계는 [tools/scan/find-offsets.ps1](../tools/scan/find-offsets.ps1) 로 자동화했습니다(읽기 전용).
> 배경: [memory-reading.md](memory-reading.md) · 로거 구조: [play-logger.md](play-logger.md)

## 0. 언제 하나

패치 직후 아래 중 하나라도 보이면 offset 이 밀린 것입니다.

| 증상 | 의심 offset |
|---|---|
| 프로필 카드에 DJ NAME / IIDX ID 가 안 뜸, 계정 TSV 를 못 불러옴 | 프로필 `djName` / `iidxId` |
| 단위·노트레이더가 엉뚱하거나 비어 있음 | 프로필 `dan` / `radar` |
| `tracker.tsv` 가 비어 있거나 곡 데이터가 안 맞음 | Reflux 키 7개 |
| 플레이 기록이 안 쌓이거나 곡명·판정이 틀림 | `playSettings` / `playData` / `currentsong` / `judgeData` / `songList` |
| `plays_detail.jsonl` 에 `lanes_ok:false` | **레인별 판정 블록** (offsets.txt 키가 아님) |

앱 로그에 `게임 빌드 ... 에 맞는 항목이 gist 에 없음` 이 뜨면 gist 에 새 빌드가 없다는 뜻이고, 이때 앱은 `builds[0]`(옛 빌드)의 주소로 진행해 **옛 주소를 읽습니다**(§7, §9).

## 1. 준비

- 게임(`bm2dx.exe`)을 실행합니다. 게임 메모리에는 **쓰지 않습니다**(읽기 전용).
- 새 빌드 datecode: `powershell -File tools\scan\find-offsets.ps1 -Static` 첫 줄에 나옵니다(모듈 안에서 가장 큰 `P2D:J:B:A:YYYYMMDDxx`).
- 앱을 개발 모드로 띄울 때는 VSCode 터미널의 `ELECTRON_RUN_AS_NODE` 를 해제합니다(`unset ELECTRON_RUN_AS_NODE`). 켜져 있으면 `electron.app` 이 undefined 로 죽습니다.
- PowerShell 스크립트에서 함수 이름을 `rd` 로 짓지 마세요(`Remove-Item` 별칭이라 인자 오류).
- 직전 빌드 값은 Reflux 폴더의 `offsets.txt`(`%APPDATA%\ohSorryScoreINF\Reflux\offsets.txt`)와 gist 의 `builds[0]` 에 있습니다. 갱신 전에 복사해 두면 이동폭을 비교할 수 있습니다.

## 2. 갱신 대상 전체 목록 (체크리스트)

**하나라도 빠지면 일부 기능만 조용히 틀립니다.** 2026111100 에서는 ⑬(레인 블록)을 한 번 빠뜨렸습니다.

| # | 항목 | 종류 | 정의 위치 | 찾는 방법 (§3~5) |
|---|---|---|---|---|
| ① | songList | Reflux 키 | `reflux.ts` `BUNDLED_OFFSETS`, gist `reflux` | `5.1.1.` UTF-16 + `+0x5b0 == 1000` |
| ② | unlockdata | Reflux 키 | 〃 | int32 `1000, 1, 462` |
| ③ | datamap | Reflux 키 | 〃 | int32 `0x7FFF, 0` 의 24바이트 앞, 직전 −2MB 이후 첫 매치 |
| ④ | playSettings | Reflux 키 | 〃 | 레인 배열 `0..7,0..7` − `0x37CC` |
| ⑤ | judgeData | Reflux 키 | 〃 | 쪽별 판정 합 = 화면 합계 |
| ⑥ | currentsong | Reflux 키 | 〃 | `[곡ID, ?, ?, ?, 노트수]` |
| ⑦ | playData | Reflux 키 | 〃 | `[곡ID, 난이도, EX, 미스, PG, GREAT, 램프]` (일반 판만) |
| ⑧ | djName | 프로필 | `profileOffsets.ts` `PROFILE_OFFSETS`, gist `profile` | 문자열 UTF-8 |
| ⑨ | iidxId | 프로필 | 〃 | 문자열 UTF-8 (하이픈 없는 13자, djName − 0xE) |
| ⑩ | radar (12) | 프로필 | `PROFILE_NUMERIC_OFFSETS`, gist | 화면 값 ×100 정수 12개 |
| ⑪ | dan (SP,DP) | 프로필 | 〃 | `DJ POINT sp,dp` 뒤 `dan sp,dp` |
| ⑫ | 빌드 datecode | 자동 | `gameBuild.ts` | 메모리에서 직접 읽음(하드코딩 없음) |
| ⑬ | **레인별 판정 P1/P2** | **judgeData 기준 상대 word** | `playDetail.ts` `laneWordsP1/P2` | 레인 열 합 = 쪽별 판정 |

판정 이후의 **상대 오프셋**(아래)은 한 구조체 안의 값이라 보통 그대로 맞지만, 새 빌드에서 **검증**은 해야 합니다.

| 기준 | 상대값 | 의미 |
|---|---|---|
| playSettings | `-0x18` | 선곡 화면이면 1 |
| playSettings | `+0x28` | 배틀 플래그 |
| playSettings | `+0x48` | P2 설정 블록 |
| playSettings | `+0x17A0` | 곡 재생 속도 단계 (10=1.00, 16=0.70) |
| playSettings | `+0x37CC` / `+0x37EC` | 실제 레인 배치 P1 / P2 |
| playSettings | `+0x2B0` | playData (관례) |
| judgeData | word 0..15 | `judge_16` |
| judgeData | word 77 / 78 | 게이지 P1 / P2 |
| judgeData | `+0x1E4` | currentsong (관례) |
| judgeData | `+144` 부근 | 상태 마커 (`playLog.ts` `findMarkerDelta`) |
| songList | `0x730` 간격, ID `+0x5b0`, 제목 UTF-16 `0x100`, 노트 `+0x370` | 곡 엔트리 |

## 3. 찾기 ① — 게임을 막 켠 선곡 화면 (`-Static`)

옵션은 전부 OFF(랜덤 안 친 상태)여야 `playSettings` 가 유일하게 잡힙니다.

```powershell
powershell -ExecutionPolicy Bypass -File tools\scan\find-offsets.ps1 -Static
```

- 빌드 datecode, ①②③④ 를 찾습니다. ③ 은 직전 `offsets.txt` 가 있어야 검색 창이 정해집니다(`-PrevOffsets` 로 지정 가능).
- ④ 가 안 잡히면(랜덤으로 친 뒤라 배열이 정배가 아님) 게임을 껐다 켠 뒤 다시 하거나, Reflux 방식(§8)으로 찾습니다.
- songList 는 Reflux `OffsetSearcher` 가 보고하는 값(ASCII `5.1.1.` 매치)이 **title2 라서 0x100 뒤**입니다. 스크립트는 UTF-16 제목으로 엔트리 시작을 직접 찾습니다.

## 4. 찾기 ② — 프로필 화면 값 (`-Profile`)

게임의 프로필 화면(DJ NAME, INFINITAS ID, 단위, DJ POINT)과 노트레이더 화면의 값을 인자로 줍니다. 값은 화면에서 직접 읽어 옮깁니다.

```powershell
powershell -ExecutionPolicy Bypass -File tools\scan\find-offsets.ps1 -Profile `
  -DjName GROM -IidxId C2000-7477-7849 -SpDan -1 -DpDan 16 -SpPoint 14130 -DpPoint 45149 `
  -Radar 9419,11012,9346,11766,9716,13303,7974,12659,11569,13889,10083,12777
```

- 단위 값은 `DAN_NAMES` index (0=七級 … 6=一級, 7=初段 … 16=十段, 17=中伝, 18=皆伝), 미취득은 `-1`.
- 레이더는 축마다 **SP,DP 쌍**이 연속이고 순서는 notes, peak, scratch, soflan, charge, chord, 값은 ×100 (`94.19` → `9419`). 합계 레이더 스코어는 메모리에 없습니다.
- `djName` / `iidxId` 는 문자열 매치가 여러 개 나옵니다. **14바이트 간격(iidxId + 0xE = djName)으로 붙은 쌍**이 정답입니다. 이번 빌드는 `iidxId 0x699D40`, `djName 0x699D4E`.
- `dan` 은 `DJ POINT sp,dp` 바로 뒤(+8)에 붙습니다.
- 출력은 모듈 상대 offset(`0x…`) 이며, 그대로 `profileOffsets.ts` / gist `profile` 에 넣습니다.

## 5. 찾기 ③ — 한 판 친 뒤 결과 화면 (`-Play`)

**결과 화면에서 나가지 말고** 화면 수치를 인자로 줍니다(선곡 화면으로 나가면 지워집니다).

```powershell
powershell -ExecutionPolicy Bypass -File tools\scan\find-offsets.ps1 -Play -SongId 11015 -Notes 1288 `
  -Pg 663 -Gr 287 -Gd 209 -Bd 18 -Poor 103 -ComboBreak 99 -Fast 105 -Slow 391 -Ex 1613
```

- **DP 는 화면의 합계 수치 그대로** 줍니다. 메모리에서는 1P 블록(word 0..4)과 2P 블록(5..9)에 나뉘어 있고, 스크립트가 쪽별 합으로 매칭합니다(Reflux 의 한쪽 패턴은 DP 에서 안 맞습니다).
- `-Notes` 는 배틀이면 차트 노트의 **2배**입니다.
- ⑤ judgeData, ⑥ currentsong, ⑬ 레인 블록을 찾습니다. 레인 블록은 `judgeData` 기준 word 로 출력되고, 7레인 검색 결과를 우선합니다(8번째 레인은 0).
- ⑦ playData 는 **일반 판(속도 1.00, 배틀 OFF)** 에서만 채워집니다. 배틀이나 속도 변경 판은 `playData` 가 전부 0 이고 로거가 `currentsong` 으로 기록합니다. 그래서 ⑦ 은 `-Ex` 를 주고 **일반 판 결과 화면에서** 따로 찾으세요.
- 레인 블록 후보가 두 개 나오면 위치가 겹친 것입니다. 7레인 매치와 일치하는 쪽을 고릅니다.

### 한 번에 몇 판이 필요한가

| 판 | 조건 | 얻는 것 |
|---|---|---|
| A | 일반 DP, 속도 1.00, 배틀 OFF, 완주 | ⑤ ⑥ ⑦ ⑬, 로거 정상 경로(`playdata`) |
| B | RANDOM, 클리어 가능한 곡 | 레인 배치 검증, 게이지(클리어) |
| C | 속도 0.70, 배틀 OFF | 속도 `+0x17A0` 검증 (`playData` 비어 `currentsong` 경로) |
| D | 일부러 실패한 판 | 게이지 실패 값 |

A 한 판으로 offset 은 전부 찾을 수 있고, B~D 는 검증용입니다.

## 6. 반영

찾은 값을 코드에 넣습니다.

1. [reflux.ts](../src/main/reflux.ts) `BUNDLED_OFFSETS` 7줄 + 첫 줄 datecode + `BUNDLED_OFFSETS_VERSION`.
2. [profileOffsets.ts](../src/shared/profileOffsets.ts) `djName` / `iidxId` / `radar` / `dan` + `refluxVersion` + 이동 이력 주석.
3. [playDetail.ts](../src/main/playDetail.ts) `laneWordsP1` / `laneWordsP2`.
4. 문서의 옛 값: [memory-reading.md](memory-reading.md) 의 프로필 주소·버전 표기, [play-logger.md](play-logger.md) 의 레인 word 위치.

## 7. gist 갱신 (배포된 앱까지 고치는 유일한 방법)

배포된 앱은 코드 상수가 아니라 **gist 의 `builds` 에서 현재 빌드 항목**을 먼저 찾습니다. 없으면 `builds[0]` 을 씁니다.

- `builds[0]` 에 새 빌드 항목(`version`, `note`, `reflux`, `profile`)을 **맨 위에 추가**합니다.
- 구버전 앱 호환용 최상위 `version` / `reflux` / `profile` 도 같은 값으로 갱신합니다(삭제 금지).
- 모르는 profile 필드는 키를 빼지 말고 `null` 로 둡니다(키가 없으면 옛 코드 상수로 fallback 해서 엉뚱한 메모리를 읽음).
- `playLogger.detail.laneWordsP1/P2` 는 새 gist 로 갱신할 수 있으며, 코드값은 기본값으로 사용됩니다.
- gist 갱신 대상은 새 secret gist `b586710a7a6efc3a245da2c85db8d1f2` 입니다. 기존 `30c3ba6f…` 는 구버전 `≤0.0.162` 전용으로 동결합니다.
- gist 경로가 바뀌면 [src](../src) 안의 6개 URL 을 함께 바꿔야 합니다(`offsetsRemote.ts`, `serviceStatus.ts`, `workerResources.ts`, `recommendCore.ts`, `supabaseSync.ts`, `dataSource.ts`).

## 8. 스크립트로 못 찾을 때

- **playSettings**: Reflux 방식 — 옵션을 `RANDOM / EXHARD / OFF / SUDDEN+` 으로 둔 뒤 int32 `1,4,0,0,1` 을, 다시 `MIRROR / EASY / AUTO-SCRATCH / HIDDEN+` 으로 바꾼 뒤 `4,2,1,0,2` 를 찾아 두 결과가 같은 위치인지 확인합니다. 2P 로 친 판이면 `−0x48`.
- **datamap**: 직전 `offsets.txt` 가 없으면 매치가 수만 개라 못 정합니다. 직전 값을 구해 오세요.
- **빠른 추정**: 같은 그룹은 함께 움직입니다. 이력으로 보면 `playSettings / playData / currentsong / judgeData` 가 같은 폭, `songList / datamap` 이 같은 폭입니다(§10 표). 이동폭을 추정한 뒤 검증 항목으로 확인하세요. **추정만으로 확정하지 마세요.**
- Reflux 원본 탐색기 소스: `olji/Reflux` 의 `Reflux/OffsetSearcher.cs` (곡 한 판 + 판정 수치 입력 방식).

## 9. 앱에서 검증 (갱신 후)

앱을 띄우고(`ELECTRON_RUN_AS_NODE` 해제) 확인합니다. 값은 항상 **화면과 직접 대조**합니다.

- [ ] 앱 로그에 `offsets.txt 자동 갱신: … → <새 빌드>` 가 뜨고 `%APPDATA%\ohSorryScoreINF\Reflux\offsets.txt` 가 새 값
- [ ] 프로필 카드: DJ NAME, IIDX ID, SP/DP 단위(미취득은 `-`), 노트레이더 SP/DP 12개
- [ ] 계정 TSV 로드(최근 플레이·곡 목록 표시), 로그에 `스냅샷 거부` 가 지속되지 않음
- [ ] 판 A 후 `users/<IIDX_ID>/plays.csv` 에 행이 생김: 곡명·노트·EX·판정 합·BP·FAST/SLOW(`judge_16` 12~15)·DJ 레벨·`game_version`
- [ ] `plays_detail.jsonl` 의 새 줄이 **`lanes_ok:true`**
- [ ] 판 B: `lane_order_p1/p2` 가 0~6 순열로 바뀜 (OFF 는 `0123456`)
- [ ] 판 C: `play_speed` 가 옵션창 값과 같음 (0.70 → 단계 16)
- [ ] 클리어 판 / 실패 판: 게이지 `gauge_p1_w77` / `gauge_p2_w78` (플레이한 쪽 값이 화면과 비슷, 실패 판은 클리어 기준 아래)
- [ ] 배틀 판: `battle_flag=1`, `source=currentsong`, 노트 수가 차트의 2배
- [ ] `meta.json` 의 SP/DP 단위가 화면과 같음 (아래 함정 참고)

## 10. 이동 이력 (참고·회귀 확인용)

| 빌드 | 프로필 이동 | playSettings 그룹 | songList / datamap | unlockdata |
|---|---|---|---|---|
| 2026080500 → 2026101400 | +0x1040 | +0x1000 | +0x1010 / +0x1020 | +0x1010 |
| 2026101400 → 2026111100 | +0x1010 (djName 기준) | +0x1000 | +0x1090 / +0x1090 | +0x1060 |

2026111100 정답값(스크립트 회귀 확인용, 선호 베이스 0x140000000):

```
songList = 0x1431D6910     unlockdata = 0x14290AA50     datamap = 0x1435BCC38
playSettings = 0x1425DB154 playData = 0x1425DB404
currentsong = 0x142888370  judgeData = 0x14288818C
profile: iidxId 0x699d40 / djName 0x699d4e / radar 0x69b7e0 / dan 0x699d6c / DJ POINT 0x699d64
레인 블록(judgeData 기준 word): P1 3448385 / P2 3452299
```

## 11. 알려진 함정

- **gist 에 새 빌드가 없으면 프로필 latest 정책을 확인합니다.** 상수 빌드와 실측 빌드가 다르면 profile 판독은 blocked 됩니다. 유효한 단위 판독은 `value` 또는 `none`으로 기존 값을 덮어쓰고, `unread`는 보존합니다. 카드 교정은 정상 판독 렌더부터, meta·서버 교정은 기존 snapshot·업로드 기회에 발생합니다. 자세한 내용은 [report-sp-rank-stale-meta.md](report-sp-rank-stale-meta.md).
- 레인 블록(⑬)은 offsets.txt 키가 아니라서 빠뜨리기 쉽습니다. `playDetail.ts` 를 꼭 확인하세요.
- 스캐너(MemoryScanner) 슬롯은 문자열(djName/iidxId) 전용이라 radar/dan 은 gist·코드 상수로만 고칠 수 있습니다.
- 결과 화면에서 선곡 화면으로 나가면 판정 값이 0 으로 지워집니다. 값을 찾는 동안은 결과 화면에 머무세요.
- 게임을 껐다 켜도 모듈 베이스가 같으면(`0x140000000`) 모듈 영역 주소는 그대로입니다. 힙 주소는 바뀝니다.
- 속도를 바꾼 판, 배틀 판은 `playData` 가 비어 `clear_lamp=-1`, `source=currentsong` 이 정상입니다.
- 앱이 `offsets.txt` 를 갱신하는 규칙: 게임 빌드가 gist 와 일치하면 그 값(다운그레이드 허용), 아니면 `max(디스크, 번들, gist, olji)`. 번들 `BUNDLED_OFFSETS_VERSION` 을 올리지 않으면 옛 번들이 이깁니다.

## 12. 관련 파일

- 스크립트: [tools/scan/find-offsets.ps1](../tools/scan/find-offsets.ps1), 메모리 덤프 [tools/scan/dump-mem.ps1](../tools/scan/dump-mem.ps1)
- 레인 배치 실측 보고: [tools/scan/REPORT.md](../tools/scan/REPORT.md), [tools/lane-scan-brief.md](../tools/lane-scan-brief.md)
- 코드: `src/main/reflux.ts`, `src/shared/profileOffsets.ts`, `src/main/playDetail.ts`, `src/main/playLog.ts`, `src/main/gameBuild.ts`, `src/main/offsetsRemote.ts`
