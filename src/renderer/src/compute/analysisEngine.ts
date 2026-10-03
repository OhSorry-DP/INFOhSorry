import type { SongChart } from '../../../shared/types';
import { makeOptionsKey } from './revisionKey';
import { encodeValue } from './workerBoundary';
import { sha256 } from './workerResources';

export interface AnalysisWeaknessChart {
  title: string;
  diff: string;
  exScore: number;
  noteCount: number;
  scorePercent: number;
  lampNum: number;
}

const SLOT_TO_DIFF: Record<string, string> = {
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};
const LAMP_TO_NUM: Record<string, number> = {
  NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7,
};

/** Preserve the Analysis.tsx adapter's order and value semantics. */
export function analysisChartsToWeaknessCharts(charts: SongChart[]): AnalysisWeaknessChart[] {
  const out: AnalysisWeaknessChart[] = [];
  for (const chart of charts) {
    const diff = SLOT_TO_DIFF[chart.slot];
    if (!diff || !chart.noteCount || chart.noteCount <= 0) continue;
    out.push({
      title: chart.title,
      diff,
      exScore: chart.exScore || 0,
      noteCount: chart.noteCount,
      scorePercent: ((chart.exScore || 0) / (chart.noteCount * 2)) * 100,
      lampNum: LAMP_TO_NUM[chart.lamp] ?? 0,
    });
  }
  return out;
}

type AnalysisLibs = {
  OhsorryNorm: { norm: (title: string) => unknown };
  OhsorryWeakness: { calcUserWeakness: (input: Record<string, unknown>) => any; computePatternScoreVec?: (input: Record<string, unknown>) => unknown };
  patterns: unknown;
  rateRef?: unknown;
  rating?: { ratings?: unknown } | null;
  zasa?: { charts?: unknown } | null;
  featureScores?: unknown;
  computePatternScoreVec?: (input: Record<string, unknown>) => unknown;
};

export function runAnalysisWeakness(charts: SongChart[], libs: AnalysisLibs): { vec: any; allCharts: AnalysisWeaknessChart[] } | null {
  const allCharts = analysisChartsToWeaknessCharts(charts);
  if (allCharts.length === 0) return null;
  const vec = libs.OhsorryWeakness.calcUserWeakness({
    allCharts,
    patternsMap: libs.patterns,
    normFn: libs.OhsorryNorm.norm,
    ratingMap: libs.rating?.ratings || null,
    zasaMap: libs.zasa?.charts || null,
    rateRef: libs.rateRef,
  });
  return vec && vec.__entries ? { vec, allCharts } : null;
}

// makeOptionsKey intentionally normalizes -0 to 0 and rejects non-finite numbers.
// Encode worker scalars first, then give -0 its own explicit marker for digesting.
function digestValue(value: unknown): unknown {
  if (typeof value === 'number' && Object.is(value, -0)) return { __analysisScalar: '-0' };
  if (Array.isArray(value)) return value.map(digestValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, digestValue(record[key])]));
  }
  return value;
}

export async function runAnalysisPatternScore(charts: SongChart[], libs: AnalysisLibs): Promise<{ vec: unknown; digest: string } | null> {
  if (!libs.featureScores) return null;
  const allCharts = analysisChartsToWeaknessCharts(charts);
  if (allCharts.length === 0) return null;
  const compute = libs.computePatternScoreVec ?? libs.OhsorryWeakness?.computePatternScoreVec;
  if (typeof compute !== 'function') return null;
  const vec = compute({ charts: allCharts, featureScores: libs.featureScores,
    patternsMap: libs.patterns, normFn: libs.OhsorryNorm.norm });
  if (vec == null) return null;
  return { vec, digest: await sha256(makeOptionsKey(digestValue(encodeValue(vec)))) };
}
