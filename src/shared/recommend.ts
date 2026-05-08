// ohSorry 의 추천곡 로직 — INFOhSorry 용 포팅
//
// 원본: 2-calc-score.js 의 buildRecs / buildPools.
//
// 알고리즘 요약:
//   1. 사용자 별값 (baseStar) 기준으로 도전 / 정리 풀 분리
//      - 도전: ★ 가 baseStar 이상 baseStar+0.8 이하 (살짝 위)
//      - 정리: ★ 가 baseStar 미만
//   2. 각 풀에서 랜덤 10개 sample → quota 만큼 pick
//      - 일반 (★ ≥ 2.0): 도전 6 / 정리 4
//      - 저렙 (★ < 2.0): 도전 3 / 정리 7
//   3. 부족하면 다른 풀에서 채워서 총 10곡 맞춤
//   4. ★ 내림차순 정렬 (도전 → 정리)
//
// 매번 random shuffle 이라 호출할 때마다 결과 바뀜 ("다시 뽑기" 효과).
import type { ChartSlot, Lamp } from './types';

// 추천곡의 input — 매칭된 차트 (★ EC/HC/EXH 다 있어야 의미 있음)
export interface RecInputChart {
  title: string;
  slot: ChartSlot;
  diff: string; // 'NORMAL' / 'HYPER' / 'ANOTHER' / 'LEGGENDARIA'
  level: number; // ereter ★ (소수)
  lamp: Lamp;
  lampNum: number;
  djLevel: string | null; // DJ Level (AAA/AA/A/B/C/D/E/F) — v3.2.6 djLevel boost 에 사용
  ec: number | null;
  hc: number | null;
  exh: number | null;
}

export interface RecCandidate {
  title: string;
  slot: ChartSlot;
  diff: string;
  level: number;
  currentLamp: Lamp;
  ec: number | null;
  hc: number | null;
  exh: number | null;
  diffValue: number; // 해당 stage 의 ★
  margin: number; // baseStar - diffValue (음수면 도전, 양수면 정리)
  category: 'challenge' | 'cleanup';
}

export type RecStage = 'ec' | 'hc' | 'exh';
const STAGE_THRESHOLD: Record<RecStage, number> = { ec: 3, hc: 5, exh: 6 };

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function keyOf(r: RecCandidate): string {
  return r.title + '|' + r.slot;
}

export function buildRecs(
  matched: RecInputChart[],
  baseStar: number,
  stage: RecStage,
): RecCandidate[] {
  if (!Number.isFinite(baseStar)) return [];
  const threshold = STAGE_THRESHOLD[stage];

  const challenge: RecCandidate[] = [];
  const cleanup: RecCandidate[] = [];
  for (const c of matched) {
    if (c.lampNum >= threshold) continue; // 이미 그 stage 클리어한 곡은 skip
    const dv = c[stage];
    if (typeof dv !== 'number') continue;
    const item: RecCandidate = {
      title: c.title,
      slot: c.slot,
      diff: c.diff,
      level: c.level,
      currentLamp: c.lamp,
      ec: c.ec,
      hc: c.hc,
      exh: c.exh,
      diffValue: dv,
      margin: baseStar - dv,
      category: 'cleanup',
    };
    if (dv >= baseStar && dv <= baseStar + 0.8) {
      item.category = 'challenge';
      challenge.push(item);
    } else if (dv < baseStar) {
      item.category = 'cleanup';
      cleanup.push(item);
    }
  }

  const isLowLevel = baseStar < 2.0;
  const challengeQuota = isLowLevel ? 3 : 6;
  const cleanupQuota = isLowLevel ? 7 : 4;

  // 풀에서 랜덤 10개 sample
  const challengeRand = shuffle(challenge).slice(0, 10);
  const cleanupRand = shuffle(cleanup).slice(0, 10);

  const used = new Set<string>();
  let chPick = challengeRand.slice(0, challengeQuota);
  chPick.forEach((r) => used.add(keyOf(r)));
  let clPick = cleanupRand.filter((r) => !used.has(keyOf(r))).slice(0, cleanupQuota);
  clPick.forEach((r) => used.add(keyOf(r)));

  // 부족하면 다른 풀에서 채움 (총 10)
  const totalNow = chPick.length + clPick.length;
  if (totalNow < 10) {
    const need = 10 - totalNow;
    if (clPick.length < cleanupQuota) {
      const extra = challengeRand.filter((r) => !used.has(keyOf(r))).slice(0, need);
      chPick = [...chPick, ...extra];
      extra.forEach((r) => used.add(keyOf(r)));
    }
    const stillNeed = 10 - chPick.length - clPick.length;
    if (stillNeed > 0) {
      const extra = cleanupRand.filter((r) => !used.has(keyOf(r))).slice(0, stillNeed);
      clPick = [...clPick, ...extra];
    }
  }

  // 표시 순서: 도전 (★ 높은→낮은) → 정리 (★ 높은→낮은)
  chPick.sort((a, b) => b.diffValue - a.diffValue);
  clPick.sort((a, b) => b.diffValue - a.diffValue);
  return [...chPick, ...clPick];
}
