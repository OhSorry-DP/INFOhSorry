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
  ec_n: number | null; // 해당 stage 클리어 인구수 (이레터넷의 ec_count)
  hc_n: number | null;
  exh_n: number | null;
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
  ec_n: number | null;
  hc_n: number | null;
  exh_n: number | null;
  diffValue: number; // 해당 stage 의 ★
  diffCount: number; // 해당 stage 의 클리어 인구수 (정렬용)
  margin: number; // baseStar - diffValue (음수면 도전, 양수면 정리)
  category: 'challenge' | 'cleanup';
}

export type RecStage = 'ec' | 'hc' | 'exh';
export const STAGE_THRESHOLD: Record<RecStage, number> = { ec: 3, hc: 5, exh: 6 };

// 도전곡 범위 — baseStar 위로 얼마까지 추천할지.
// 저레벨 (★0.5) 사용자는 +1.2 까지, 고레벨 (★14.0) 사용자는 +0.3 까지. 사이는 선형 보간.
// 범위 밖은 clamp.
export function challengeOffset(baseStar: number): number {
  if (baseStar <= 0.5) return 1.2;
  if (baseStar >= 14.0) return 0.3;
  return 1.2 - ((baseStar - 0.5) * 0.9) / 13.5;
}

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

// 도전곡 10개 + 정리곡 10개 = 총 20곡 샘플링.
// 그 중 picked 10곡 (도전 6 : 정리 4 비율) 을 화면에 표시, 나머지 10곡은 pool 에 보관.
// 클리어로 picked 가 줄어들면 pool 에서 보충, picked 가 9 미만으로 떨어지면 RecCard 가
// "다시 받기" 버튼 표시 (재 reroll 트리거).
export function buildRecsWithPool(
  matched: RecInputChart[],
  baseStar: number,
  stage: RecStage,
): { picked: RecCandidate[]; pool: RecCandidate[] } {
  if (!Number.isFinite(baseStar)) return { picked: [], pool: [] };
  const threshold = STAGE_THRESHOLD[stage];
  const offset = challengeOffset(baseStar);
  // stage 별 클리어 인구수 필드
  const countField = (stage + '_n') as 'ec_n' | 'hc_n' | 'exh_n';

  const challenge: RecCandidate[] = [];
  const cleanup: RecCandidate[] = [];
  for (const c of matched) {
    if (c.lampNum >= threshold) continue; // 이미 그 stage 클리어한 곡 skip
    const dv = c[stage];
    if (typeof dv !== 'number') continue;
    const dn = c[countField];
    const item: RecCandidate = {
      title: c.title,
      slot: c.slot,
      diff: c.diff,
      level: c.level,
      currentLamp: c.lamp,
      ec: c.ec,
      hc: c.hc,
      exh: c.exh,
      ec_n: c.ec_n,
      hc_n: c.hc_n,
      exh_n: c.exh_n,
      diffValue: dv,
      diffCount: typeof dn === 'number' ? dn : 0,
      margin: baseStar - dv,
      category: 'cleanup',
    };
    if (dv >= baseStar && dv <= baseStar + offset) {
      item.category = 'challenge';
      challenge.push(item);
    } else if (dv < baseStar) {
      item.category = 'cleanup';
      cleanup.push(item);
    }
  }

  // 도전곡 / 정리곡 후보 각 10곡 = 카운트 많은 순 5 + 순 랜덤 5 (중복 제거).
  // 합친 10곡을 다시 셔플 → picked 선택 시 순서 무관해짐 (표시는 후에 ★ desc 정렬).
  const sample10ByCountAndRandom = (pool: RecCandidate[]): RecCandidate[] => {
    const byCount = [...pool].sort((a, b) => b.diffCount - a.diffCount);
    const top5 = byCount.slice(0, 5);
    const usedKeys = new Set(top5.map(keyOf));
    const rest = pool.filter((r) => !usedKeys.has(keyOf(r)));
    const rand5 = shuffle(rest).slice(0, 5);
    return shuffle([...top5, ...rand5]);
  };
  const challengeRand = sample10ByCountAndRandom(challenge);
  const cleanupRand = sample10ByCountAndRandom(cleanup);

  // picked = 도전 6 + 정리 4, 한 쪽 부족하면 다른 쪽에서 보충해서 총 10
  const used = new Set<string>();
  let chPick = challengeRand.slice(0, 6);
  chPick.forEach((r) => used.add(keyOf(r)));
  let clPick = cleanupRand.filter((r) => !used.has(keyOf(r))).slice(0, 4);
  clPick.forEach((r) => used.add(keyOf(r)));

  if (chPick.length + clPick.length < 10 && clPick.length < 4) {
    const extra = challengeRand
      .filter((r) => !used.has(keyOf(r)))
      .slice(0, 10 - chPick.length - clPick.length);
    chPick = [...chPick, ...extra];
    extra.forEach((r) => used.add(keyOf(r)));
  }
  if (chPick.length + clPick.length < 10) {
    const extra = cleanupRand
      .filter((r) => !used.has(keyOf(r)))
      .slice(0, 10 - chPick.length - clPick.length);
    clPick = [...clPick, ...extra];
    extra.forEach((r) => used.add(keyOf(r)));
  }

  // 표시 순서: 도전 (★ desc) → 정리 (★ desc)
  chPick.sort((a, b) => b.diffValue - a.diffValue);
  clPick.sort((a, b) => b.diffValue - a.diffValue);
  const picked = [...chPick, ...clPick];

  // pool = 샘플된 20곡 - picked 사용분 (최대 10곡, 양쪽 부족 시 더 적음)
  const pool = [...challengeRand, ...cleanupRand].filter((r) => !used.has(keyOf(r)));

  return { picked, pool };
}

// 호환용 — picked 만 반환
export function buildRecs(
  matched: RecInputChart[],
  baseStar: number,
  stage: RecStage,
): RecCandidate[] {
  return buildRecsWithPool(matched, baseStar, stage).picked;
}
