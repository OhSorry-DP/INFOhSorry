# 보고서 — SP 단위가 六級으로 남는 문제 (빌드 2026111100 offset 갱신 중 발견)

작성: 2026-11-15. 대상 계정: `C200074777849`. 코드·데이터는 이 보고서 작성 시점에 수정하지 않았습니다.

## 요약

- 게임에서 SP 단위는 **미취득**인데 앱 프로필 카드에 SP **六級**이 표시되었습니다.
- gist 를 새 빌드로 고친 뒤 앱을 재시작해도 六級이 사라지지 않았습니다.
- 당시 원인은 두 개가 겹친 것으로 판단했습니다.
  1. gist 에 새 빌드 항목이 없어 **옛 빌드 주소**를 읽었고, 거기서 나온 값 `1` 이 六級으로 해석되어 계정 meta 에 저장되었다.
  2. 당시에는 단위 미취득을 기존 값과 구분하지 못해 저장된 옛 값이 남았다.
- 서버(Supabase)에 틀린 SP 단위가 올라갔는지는 **확인하지 못했습니다.**

## 증상

| 항목 | 값 |
|---|---|
| 게임 화면(프로필) | SP `-`(미취득), DP 十段 |
| 앱 프로필 카드 | SP 六級, DP 十段 |
| `users/C200074777849/meta.json` | `"spRank":"六級"`, `"spRankInt":-5`, `"dpRank":"十段"`, `"dpRankInt":10` |
| 같은 meta 의 레이더 | 화면 값과 일치 (SP NOTES 94.19, DP NOTES 110.12 등) |

레이더는 맞고 단위만 틀립니다. 레이더는 새 주소에서 정상으로 읽히고 있다는 뜻입니다.

## 원인

### 1. gist 에 현재 빌드가 없어 옛 주소를 읽음

당시 `resolveBuild()`는 실행 중 게임의 datecode 와 같은 build 를 gist 에서 찾고, 없으면 `builds[0]`(최신 항목)을 선택했습니다. 당시 `builds[0]` 은 `2026101400` 이었습니다. 현재 프로필 정책은 matched·blind·legacy 에 `normal`, latest 에 상수 빌드 일치 시 `constants-only`·불일치 시 `blocked`를 적용합니다. gist fetch 실패 시에도 상수 빌드와 실측 datecode가 일치하면 `constants-only`, 실측 null이면 `normal` + null profile, 불일치면 `blocked`입니다.

그 항목의 `dan` 주소는 `0x698d5c` 이고 새 빌드의 실제 주소는 `0x699d6c` 입니다. 게임 메모리를 직접 읽어 비교한 값은 이렇습니다.

| 주소 | 읽은 값 | 해석 |
|---|---|---|
| `0x698d5c` (옛 gist) | `1 1080578288` | SP index 1 = 六級, DP 는 범위 밖이라 버려짐 |
| `0x699d6c` (새 빌드) | `-1 16` | SP 미취득, DP 十段 |

`parseDanBlock`(`src/renderer/src/useProfile.ts`)은 `-1 ~ 18` 이 아니면 `null` 로 버리지만 `1` 은 정상 범위라 그대로 통과합니다. 범위 검사로는 이 오독을 걸러낼 수 없습니다. DP 쪽 十段은 읽힌 값이 아니라 Supabase/기존 meta 에서 온 값입니다.

### 2. 읽은 값이 null 이면 저장된 값이 그대로 남음

`src/renderer/src/App.tsx:1252-1255`

```ts
spRank: profile.spRank ?? cardBase?.spRank ?? null,
spRankInt: profile.spRankInt ?? cardBase?.spRankInt ?? null,
```

당시에는 `danName(-1)` 과 `danIndexToRankInt(-1)` 이 `null` 을 돌려줘 "미취득"과 "읽지 못함"이 구분되지 않았고, 저장된 `cardBase` 값이 남았습니다. 현재는 같은 poll·세션의 유효 ID와 최상위 non-null 레이더가 있을 때 단위를 권위 있게 판독합니다. `spRankReadState`/`dpRankReadState`는 `value | none | unread`이며 `none`은 삭제, `unread`는 보존입니다. 카드에는 정상 판독이 반영되는 렌더부터 적용하고, meta·서버 교정은 기존 snapshot·업로드 기회에 반영됩니다. 서버 RPC는 `upsert_user_upload_profile_memory`와 `p_sp_rank_overwrite`/`p_dp_rank_overwrite`를 사용합니다. 레이더 null 삭제는 없습니다. DB migration 42 배포와 PostgREST schema reload 확인 뒤 새 INF를 배포하며 구 DB RPC 폴백도 없습니다.

당시에는 **SP 를 하지 않는 계정이 잘못 저장된 SP 단위를 스스로 지울 수 없었습니다.** 현재는 권위 있는 `none` 판독이 다음 기존 meta snapshot 또는 업로드 기회에 반영되면 해당 값을 지울 수 있습니다.

## 영향

- **로컬:** 이 PC 의 meta 와 프로필 카드. 값은 `spRank` 와 `spRankInt` 두 필드입니다.
- **서버:** 앱은 계정 프로필 세트의 `spRankInt`/`dpRankInt` 를 `upsert_user` 의 `p_sp_rank`/`p_dp_rank` 로 올립니다. 오독이 있던 구간(2026-11-15 00:40 전후 앱 실행)에 업로드가 있었는지, 값이 무엇이었는지는 **알 수 없습니다.** 앱 로그에는 `[upload] pending saved` 만 남아 있고 대기 파일은 이미 사라졌습니다. 웹 프로필에서 SP 단위가 六級으로 보이는지로 확인해야 합니다.
- **다른 사용자:** 새 빌드 이후 gist 가 갱신되기 전에 앱을 실행한 사용자는 같은 값이 저장되었을 수 있습니다. 이 계정에서 일어난 일이 그대로 재현되는 조건입니다.

## 확인 방법과 한계

- 새 주소 값은 게임 메모리를 읽기 전용으로 읽어 화면과 대조했습니다(프로필 화면 SP `-` / DP 十段, 레이더 12개).
- gist 가 갱신된 것은 gist 원본을 내려받아 `builds[0]` 이 `2026111100` 인지, 미러 필드가 같은지로 확인했습니다.
- meta.json 이 재실행 후 다시 쓰였는데도 `六級` 이 남아 있다는 점으로 2번 원인(병합)을 추정했습니다. 병합 코드 경로를 코드로 읽었지만 **디버거로 한 줄씩 확인한 것은 아닙니다.**

## 후속 구현 및 현재 동작

1. **미취득 덮어쓰기 구현:** `none`은 삭제 지시, `unread`는 기존 값 보존으로 구분합니다.
2. **최신 빌드 불일치 차단 구현:** latest에서 상수 빌드와 불일치하면 profile 판독을 막습니다.
3. **오독 방지 검증:** 동일 poll·세션의 유효 ID와 최상위 non-null 레이더가 단위 판독 권위 조건입니다.
4. **데이터 정정:** 기존 snapshot·업로드 기회에서 교정됩니다. 당시 서버 상태와 실제 교정 완료 여부는 확인되지 않았습니다.

## 열린 항목

- 서버에 올라간 SP 단위 확인(웹 프로필).
- 위 수정 중 1·2 를 구현할지, 구현한다면 어느 릴리스에 넣을지.
- 이 계정 meta.json 정정은 아직 하지 않았습니다.

## 관련

- offset 갱신 과정과 결과: `src/shared/profileOffsets.ts`, `src/main/reflux.ts` 의 2026111100 항목
- gist 구조와 빌드 매칭: [memory-reading.md](memory-reading.md) 5절
