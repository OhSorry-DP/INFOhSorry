// E모드 등급 목표 폴더(A / AA / AAA / MAX−) — 순수 데이터 로직.
//
// 오소리웹 user/tabs/playdata.js 의 "등급 목표 폴더" 로직(약 405~493행)을 HTML 없이 이식한 것.
//   내부 r★(ratingRStarIndex)와 사용자 r★의 거리로 "곧 올릴 수 있는" 곡을 등급별로 뽑는다.
//   웹은 이 결과를 chartRow 로 렌더하지만, 여기서는 챗봇(OpenWebUI Tools)이 읽을 raw 배열만 반환한다.
//
// ⚠️ 상수(GRADE_TH / BASELINE_UNIT / lo·hi 밴드)는 웹 정본과 1:1 로 유지할 것 — 어긋나면 폴더 구성이 갈라진다.
// 웹과의 차이: variant(AC≠INF) 채보 제외를 하지 않는다(normKey title|diff 로만 매칭). 개인용 INF 도구라 영향 미미.

import { slotToDiff } from '../../shared/match';
import type { ChartSlot } from '../../shared/types';

// 등급별 달성 기준 rate (EX SCORE 비율). 웹 playdata.js 의 GRADE_TH 와 동일.
const GRADE_TH = { A: 6 / 9, AA: 7 / 9, AAA: 8 / 9, MAXM: 0.944444 } as const;
// 웹이 밴드 폭을 스케일할 때 쓰는 기준 unit(rate-star.json unit 이 바뀌어도 밴드가 흔들리지 않게).
const BASELINE_UNIT = 2.5462094128788015;

// ratingData.ratings 한 행에서 뽑는 내부 r★ (등급별 목표 별값 + 신뢰도 + scoreOffset).
interface RStarEntry {
  title: string; // 원제목 (index 키는 norm 이라 별도 보관)
  ra: number | null;
  raa: number | null;
  raaa: number | null;
  maxm: number | null;
  maxmSource: 'observed' | 'estimated' | null;
  scoreOffset: number | null;
  confA: string | null;
  confAa: string | null;
  confAaa: string | null;
  confMaxm: string | null;
}

// 목표 폴더 한 곡.
export interface TargetRow {
  title: string;
  diff: string; // NORMAL / HYPER / ANOTHER / LEGGENDARIA
  targetStar: number; // 이 등급 목표의 내부 r★
  scoreOffset: number | null;
  currentRate: number | null; // 현재 EX SCORE 비율 (미플레이는 null)
  confidenceLow: boolean; // 추정 신뢰도 낮음 표식
  estimated: boolean; // MAX− 목표가 실측이 아닌 추정치
}

export interface TargetFolders {
  a: TargetRow[];
  aa: TargetRow[];
  aaa: TargetRow[];
  maxm: TargetRow[];
  userRStar: number | null;
  available: boolean; // r★ / scale / 등급별 r★ 필드가 모두 있어야 true
}

// 유저 DP 차트(플레이 기록) — normFn(title)+'|'+diff 로 현재 rate 를 조회하기 위한 최소 형태.
export interface UserDpChart {
  title: string;
  slot: ChartSlot;
  exScore: number | null;
  noteCount: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRating = any;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ratingData.ratings → normKey → RStarEntry 인덱스. 웹 playdata.js 130~145행과 동일 규칙.
function buildRStarIndex(
  ratings: AnyRating[],
  normFn: (s: string) => string,
): { index: Map<string, RStarEntry>; hasRStar: boolean } {
  const index = new Map<string, RStarEntry>();
  let hasRStar = false;
  for (const r of ratings) {
    if (!r || !r.title || !r.diff) continue;
    if (num(r.rStarAa) != null) hasRStar = true;
    const maxmVal = num(r.rStarMaxm) != null ? num(r.rStarMaxm)
      : (num(r.rStarMaxmEstimated) != null ? num(r.rStarMaxmEstimated) : null);
    const entry: RStarEntry = {
      title: r.title,
      ra: num(r.rStarA),
      raa: num(r.rStarAa),
      raaa: num(r.rStarAaa),
      maxm: maxmVal,
      maxmSource: maxmVal == null ? null : (num(r.rStarMaxm) != null ? 'observed' : 'estimated'),
      scoreOffset: num(r.scoreOffset),
      confA: typeof r.confidenceA === 'string' ? r.confidenceA : null,
      confAa: typeof r.confidenceAa === 'string' ? r.confidenceAa : null,
      confAaa: typeof r.confidenceAaa === 'string' ? r.confidenceAaa : null,
      confMaxm: typeof r.confidenceMaxm === 'string' ? r.confidenceMaxm : null,
    };
    if (entry.ra != null || entry.raa != null || entry.raaa != null || entry.maxm != null) {
      index.set(normFn(r.title) + '|' + r.diff, entry);
    }
  }
  return { index, hasRStar };
}

interface Spec {
  key: 'a' | 'aa' | 'aaa' | 'maxm';
  field: 'ra' | 'raa' | 'raaa' | 'maxm';
  confField: 'confA' | 'confAa' | 'confAaa' | 'confMaxm';
  th: number;
  floor: number | null;
  lo: number | null;
  hi: number;
}

/**
 * 등급 목표 폴더 4개를 계산한다.
 * @param ratingData  window.infohsorry.rating.get() 결과 (ratings + rateStar.scale)
 * @param userRStar   App.tsx inferUserRStar 결과 (표본부족이면 null → available:false)
 * @param userCharts  유저 DP 플레이 기록 (현재 rate 판정용)
 * @param normFn      OhsorryNorm.norm
 */
export function computeTargetFolders(
  ratingData: { ratings?: AnyRating[]; rateStar?: { scale?: { unit?: number } | null } | null } | null,
  userRStar: number | null,
  userCharts: UserDpChart[],
  normFn: (s: string) => string,
): TargetFolders {
  const empty: TargetFolders = { a: [], aa: [], aaa: [], maxm: [], userRStar, available: false };
  const ratings = ratingData && Array.isArray(ratingData.ratings) ? ratingData.ratings : null;
  const unit = num(ratingData?.rateStar?.scale?.unit);
  if (!ratings || userRStar == null || unit == null) return empty;

  const { index, hasRStar } = buildRStarIndex(ratings, normFn);
  if (!hasRStar) return empty;

  // 현재 rate 인덱스 — normKey → EX SCORE 비율.
  const rateByKey = new Map<string, number>();
  for (const c of userCharts) {
    const ex = num(c.exScore);
    const nc = num(c.noteCount);
    if (ex == null || nc == null || ex <= 0 || nc <= 0) continue;
    rateByKey.set(normFn(c.title) + '|' + slotToDiff(c.slot), ex / (nc * 2));
  }

  const S = BASELINE_UNIT / unit;
  const U = userRStar;
  const specs: Spec[] = [
    { key: 'a', field: 'ra', confField: 'confA', th: GRADE_TH.A, floor: null, lo: null, hi: 0.0885724242083653 * S },
    { key: 'aa', field: 'raa', confField: 'confAa', th: GRADE_TH.AA, floor: GRADE_TH.A, lo: -0.0885724242083653 * S, hi: 0.0885724242083653 * S },
    { key: 'aaa', field: 'raaa', confField: 'confAaa', th: GRADE_TH.AAA, floor: GRADE_TH.AA, lo: -0.05904828280557687 * S, hi: 0.14762070701394217 * S },
    { key: 'maxm', field: 'maxm', confField: 'confMaxm', th: GRADE_TH.MAXM, floor: GRADE_TH.AAA, lo: -2 * unit, hi: 0.5 * unit },
  ];

  const out: TargetFolders = { a: [], aa: [], aaa: [], maxm: [], userRStar, available: true };
  for (const spec of specs) {
    const rows: TargetRow[] = [];
    for (const [key, stars] of index) {
      const v = stars[spec.field];
      if (v == null) continue;
      const delta = v - U;
      if (spec.lo != null && delta < spec.lo) continue;
      if (delta > spec.hi) continue;
      const rate = rateByKey.get(key) ?? null;
      // 이미 이 등급을 달성한 곡은 목표가 아니다.
      if (rate != null && rate >= spec.th) continue;
      // 하한 — 목표 등급의 직전 등급에 이미 도달한 곡만. 미플레이는 하한이 없는 A 목표에만 남긴다.
      if (spec.floor != null && (rate == null || rate < spec.floor)) continue;
      const diff = key.slice(key.indexOf('|') + 1);
      const isEst = spec.key === 'maxm' && stars.maxmSource === 'estimated';
      rows.push({
        title: stars.title,
        diff,
        targetStar: v,
        scoreOffset: stars.scoreOffset,
        currentRate: rate,
        confidenceLow: !isEst && stars[spec.confField] === 'low',
        estimated: isEst,
      });
    }
    rows.sort((a, b) => a.targetStar - b.targetStar);
    out[spec.key] = rows;
  }
  return out;
}
