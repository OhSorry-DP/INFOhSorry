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
  category: 'challenge-hard' | 'challenge-easy' | 'cleanup';
}

export type RecStage = 'ec' | 'hc' | 'exh';
export const STAGE_THRESHOLD: Record<RecStage, number> = { ec: 3, hc: 5, exh: 6 };

// 도전곡 최대 offset — baseStar 위로 얼마까지 도전곡 풀에 포함할지.
// 저레벨 (★0.5) 사용자는 +1.0 까지, 고레벨 (★14.0) 사용자는 +0.3 까지. 사이는 선형 보간.
// 범위 밖은 clamp.
export function challengeOffset(baseStar: number): number {
  if (baseStar <= 0.5) return 1.0;
  if (baseStar >= 14.0) return 0.3;
  return 1.0 - ((baseStar - 0.5) * 0.7) / 13.5;
}

// 약 도전 (low challenge) 범위 — baseStar ~ baseStar + 0.2 (고정)
const EASY_CHALLENGE_WIDTH = 0.2;
// 하드 도전 (high challenge) 범위 — baseStar+offset-0.3 ~ baseStar+offset (고정 0.3 폭)
const HARD_CHALLENGE_WIDTH = 0.3;

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

// 3개 풀로 분리:
//   1. 하드 도전 [base+offset-0.3, base+offset] — 클리어 인구수 desc top 10 → 2곡 표시
//   2. 약 도전 [base, base+0.2] — 클리어 인구수 desc top 10 → 5곡 표시
//   3. 정리 [0, base) — 클리어 인구수 desc top 10 → 3곡 표시
// 각 풀에서 표시할 곡은 top 10 중 무작위로 N개 (다양성). 나머지는 pool 에 보충용 보관.
// 합 picked = 2 + 5 + 3 = 10 (한 풀 부족 시 다른 풀에서 보충).
export function buildRecsWithPool(
  matched: RecInputChart[],
  baseStar: number,
  stage: RecStage,
): { picked: RecCandidate[]; pool: RecCandidate[] } {
  if (!Number.isFinite(baseStar)) return { picked: [], pool: [] };
  const threshold = STAGE_THRESHOLD[stage];
  const offset = challengeOffset(baseStar);
  const countField = (stage + '_n') as 'ec_n' | 'hc_n' | 'exh_n';

  // 범위 정의
  const hardMax = baseStar + offset;
  const hardMin = baseStar + offset - HARD_CHALLENGE_WIDTH;
  const easyMax = baseStar + EASY_CHALLENGE_WIDTH;
  const easyMin = baseStar;

  const hardPool: RecCandidate[] = [];
  const easyPool: RecCandidate[] = [];
  const cleanupPool: RecCandidate[] = [];

  for (const c of matched) {
    if (c.lampNum >= threshold) continue;
    const dv = c[stage];
    if (typeof dv !== 'number') continue;
    const dn = c[countField];
    const baseItem = {
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
    };
    // 하드 우선 (overlap 시 약 도전과 중복 방지)
    if (dv >= hardMin && dv <= hardMax && dv > easyMax) {
      hardPool.push({ ...baseItem, category: 'challenge-hard' });
    } else if (dv >= easyMin && dv <= easyMax) {
      easyPool.push({ ...baseItem, category: 'challenge-easy' });
    } else if (dv >= hardMin && dv <= hardMax) {
      // hard 와 easy 가 overlap 영역인 경우 (고렙 사용자) — easy 로 분류 (이미 위에서 처리됨)
      // 이 분기는 dv > easyMax 가 false 인 hard 케이스 처리 — 즉 hard 와 easy 모두 매치.
      // easy 로 이미 가있으니 여기는 unreachable. 안전을 위해 패스.
    } else if (dv < baseStar) {
      cleanupPool.push({ ...baseItem, category: 'cleanup' });
    }
  }

  // 각 풀 → 카운트 desc top 10 + 그 외 풀에서 순 랜덤 5 = 후보 (최대 15곡, 중복 자동 제거)
  const sample15 = (pool: RecCandidate[]): RecCandidate[] => {
    const sorted = [...pool].sort((a, b) => b.diffCount - a.diffCount);
    const top10 = sorted.slice(0, 10);
    const usedKeys = new Set(top10.map(keyOf));
    const rest = pool.filter((r) => !usedKeys.has(keyOf(r)));
    const rand5 = shuffle(rest).slice(0, 5);
    return [...top10, ...rand5];
  };
  const hardCandidates = sample15(hardPool);
  const easyCandidates = sample15(easyPool);
  const cleanupCandidates = sample15(cleanupPool);

  // 후보 셔플 → N곡 표시 (하드 2 / 약 도전 5 / 정리 3)
  const hardPicked = shuffle(hardCandidates).slice(0, 2);
  const easyPicked = shuffle(easyCandidates).slice(0, 5);
  const cleanupPicked = shuffle(cleanupCandidates).slice(0, 3);

  const used = new Set<string>([...hardPicked, ...easyPicked, ...cleanupPicked].map(keyOf));

  // 한 풀 부족 시 다른 풀 후보에서 채워서 총 10 유지
  const allCandidates = [...hardCandidates, ...easyCandidates, ...cleanupCandidates];
  let need = 10 - hardPicked.length - easyPicked.length - cleanupPicked.length;
  const extras: RecCandidate[] = [];
  if (need > 0) {
    const rest = allCandidates.filter((r) => !used.has(keyOf(r)));
    const extra = shuffle(rest).slice(0, need);
    for (const r of extra) {
      extras.push(r);
      used.add(keyOf(r));
    }
  }

  // 표시 순서: 카테고리 무관, 전체 10곡 ★ asc 통합 정렬
  const picked = [...hardPicked, ...easyPicked, ...cleanupPicked, ...extras].sort(
    (a, b) => a.diffValue - b.diffValue,
  );

  // pool = 후보 합집합 - picked 사용분 (보충용)
  const pool = allCandidates.filter((r) => !used.has(keyOf(r)));

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
