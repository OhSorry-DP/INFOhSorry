// 추천곡 관련 공용 타입 + refresh 보조 함수 (INFOhSorry).
//
// 추천 풀 / 추천곡 산출(buildRecs / buildWeaknessRecs)은 ohSorry 본체와 100% 동일하게
// 코어 recommend.js (gist) 의 buildRecsWithPool / buildWeaknessRecs 로 일원화됨 (recommendCore.ts 참고).
// 이 파일은 그 결과를 담는 타입(RecInputChart / RecCandidate)과,
// 표시 중인 추천곡을 tracker.tsv 갱신에 맞춰 갱신/제거하는 refreshRecs(App.tsx)가 쓰는
// stage 판정 보조 함수(STAGE_THRESHOLD / isReachedLamp / isAccuracyOK / shouldDropFromRecs / compareRateDesc)만 보유.
//
// (구) 로컬 포팅 알고리즘(buildPoolsBuckets / buildRecsWithPool / buildExhRecs 등)은
//      코어 recommend.js 로 대체되어 제거됨.
import type { ChartSlot, Lamp } from './types';

// 추천곡의 input — ohSorryRating.json 등재곡만 풀에 포함.
//
// 내부 추천 평가용 (level / ec / hc / exh) = ohSorryRating estimates 사용
//   level = zasaLevel, ec = estEc, hc = estHc, exh = estExh
// 표시용 (displayEc / displayHc / displayExh / displayLevel) = ereter 실측 우선, 없으면 estimates 로 fallback
// ereter 실측 (ereterEc / ereterHc / ereterExh) = oldOSR fitData 빌더에서 사용
export interface RecInputChart {
  title: string;
  slot: ChartSlot;
  diff: string; // 'NORMAL' / 'HYPER' / 'ANOTHER' / 'LEGGENDARIA'
  // 내부 추천 평가용 — ohSorryRating estimates (모든 풀곡에 채워짐)
  level: number; // zasaLevel
  ec: number | null; // estEc
  hc: number | null; // estHc
  exh: number | null; // estExh
  ec_n: number | null; // nEcCleared (인구수, 정렬용)
  hc_n: number | null; // nHcCleared
  exh_n: number | null; // estimates 에는 보통 없음 → 0
  // 사용자 플레이 정보
  lamp: Lamp;
  lampNum: number;
  djLevel: string | null; // DJ Level (AAA/AA/A/B/C/D/E/F)
  missCount: number | null; // BP — Reflux tracker.tsv
  // ereter 실측 — 있을 때만 채움. oldOSR fitData / 일부 표시 용.
  ereterLevel: number | null;
  ereterEc: number | null;
  ereterHc: number | null;
  ereterExh: number | null;
  ereterEcN: number | null;
  ereterHcN: number | null;
  ereterExhN: number | null;
  // 메타
  gameLevel?: number | null; // INF 게임 lv (11 / 12)
  zasaLevel?: number | null; // zasa★ (10.2~12.7)
  isRatingFallback?: boolean; // true: ereter 미등재 (UI 색 구분 / 추정값 표시 fallback)
  // Reflux TSV 추가 정보 (supabase 업로드용)
  unlocked?: boolean; // false = 미해금 채보 → 추천에 포함하되 UI 에 자물쇠 표기
  exScore?: number | null;
  noteCount?: number | null;
  djPoints?: number | null;
  songType?: string | null;
  songLabel?: string | null;
}

export interface RecCandidate {
  title: string;
  slot: ChartSlot;
  diff: string;
  // 내부 알고리즘 평가용 — ratingMap estimates (level=zasaLevel, ec/hc/exh=estEc/Hc/Exh)
  level: number;
  currentLamp: Lamp;
  missCount: number | null;
  ec: number | null;
  hc: number | null;
  exh: number | null;
  ec_n: number | null;
  hc_n: number | null;
  exh_n: number | null;
  diffValue: number; // 해당 stage 의 ★ (알고리즘용 — ratingMap estimates)
  diffCount: number; // 해당 stage 의 클리어 인구수 (정렬용)
  margin: number; // baseStar - diffValue (음수면 도전, 양수면 정리)
  category: 'challenge-hard' | 'challenge-easy' | 'cleanup' | 'exh-near';
  // 표시용 — ereter 실측 (있으면 UI 에서 우선 표시)
  ereterLevel: number | null;
  ereterEc: number | null;
  ereterHc: number | null;
  ereterExh: number | null;
  ereterEcN: number | null;
  ereterHcN: number | null;
  ereterExhN: number | null;
  gameLevel?: number | null; // INF 게임 lv (11 / 12).
  isRatingFallback?: boolean; // true 면 UI 색 구분 (ratingMap 추정 / 미매칭). ereter 매칭 곡은 false/undefined.
  // ohSorry 의 reached 카테고리 여부 — stage 는 깼지만 DJ Level 미달 (예: HC 깼는데 AA 미달).
  // refreshRecs 에서 제거 조건이 달라짐 (DJ Level 통과 시 제거).
  reached?: boolean;
  // EXH 전용 — exScore / (noteCount*2). refreshRecs 의 EXH 정렬 / "거의 통과" 표시용.
  rate?: number | null;
  // 사용자 플레이 메타 — refreshRecs 가 EXH rate 재계산에 사용.
  exScore?: number | null;
  noteCount?: number | null;
  djLevel?: string | null;
  lampNum?: number;
  // 미해금 채보 여부 — false 면 UI 에 자물쇠 표기 (추천에서 제외하진 않음).
  unlocked?: boolean;
  // 연습곡 (stage='weakness') 전용 — recommend.js buildWeaknessRecs 결과의 _* 필드.
  practiceType?: 'review' | 'pattern' | 'score' | 'practical';
  targetRate?: number | null;       // 목표 rate (% 100기준)
  targetExScore?: number | null;
  currentExScore?: number | null;
  targetDjLevel?: string | null;
  // 본체 hashtag / 배치 뱃지 (recommend.js 결과 그대로).
  hashtags?: string[];
  bestLabel?: string;
}

export type RecStage = 'ec' | 'hc' | 'exh';
export type RecLevelMode = 'all' | 'lv12';
// 복습곡(reached — 램프는 깼지만 DJ레벨 미달) 추천 풀 포함 여부.
//   'on'  = 복습곡 포함 (클리어램프 미달 + DJ레벨 미달 둘 다)
//   'off' = 클리어램프 미달 곡만
export type RecDjMode = 'on' | 'off';
export const STAGE_THRESHOLD: Record<RecStage, number> = { ec: 3, hc: 5, exh: 6 };

// stage 별 "DJ Level 미달이면 reached 풀에 들어갈 lamp" — 해당 stage 깬 곡 중 추가 클리어 단계 미진입
export function isReachedLamp(stage: RecStage, lampNum: number): boolean {
  if (stage === 'exh') return lampNum >= 6;     // EXH/FC/PFC
  if (stage === 'hc') return lampNum === 5;     // HC (EXH 이상은 EXH stage 에서 처리)
  return lampNum === 3 || lampNum === 4;        // EC/NC (EC stage)
}

// stage 별 DJ Level 통과 조건 — 도달 시 추천 풀에서 제외 (개선 여지 없음)
export function isAccuracyOK(stage: RecStage, djLevel: string | null | undefined): boolean {
  if (djLevel == null) return false;
  if (stage === 'exh') return djLevel === 'AAA';
  if (stage === 'hc') return djLevel === 'AAA' || djLevel === 'AA';
  return djLevel === 'AAA' || djLevel === 'AA' || djLevel === 'A';
}

// EXH 정렬 비교 — rate desc, null 은 뒤로. App.tsx 의 refreshRecs 가 EXH picked 재정렬에 사용.
export function compareRateDesc(ra: number | null | undefined, rb: number | null | undefined): number {
  if (ra == null && rb == null) return 0;
  if (ra == null) return 1;
  if (rb == null) return -1;
  return rb - ra;
}

// stage 별 picked / pool 에서 제거할 조건 (App.tsx refreshRecs 에서 사용):
//   - 더 강한 lamp 까지 클리어 (under 도 아니고 reached 도 아닌 lamp) → 제거
//   - reached + DJ Level 통과 → 제거 (개선 여지 없음)
//   - 복습곡 제외 모드(djMode='off') → reached 곡 자체를 제거
export function shouldDropFromRecs(
  stage: RecStage,
  lampNum: number,
  djLevel: string | null | undefined,
  djMode: RecDjMode = 'on',
): boolean {
  const threshold = STAGE_THRESHOLD[stage];
  const under = lampNum < threshold;
  const reachedForDj = isReachedLamp(stage, lampNum);
  if (!under && !reachedForDj) return true;
  if (djMode === 'off' && reachedForDj) return true;
  if (reachedForDj && isAccuracyOK(stage, djLevel)) return true;
  return false;
}
