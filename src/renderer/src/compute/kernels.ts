import type { SongRow } from '../../../shared/types';
import { extractCharts, DP_SLOTS, SP_SLOTS } from '../../../shared/types';

export const S1_KINDS = ['dp-star', 'r-star', 'sp-star', 'weakness', 'layout'] as const;
export type S1Kind = typeof S1_KINDS[number];
export interface ComputeInput {
  rows: SongRow[];
  osrCharts: { title: string; diff: string; lampNum: number }[];
  notInInf: string[];
  songs: { title: string; ac: number | null; legen: number | null }[];
}
export interface KernelOptions {
  prevStar?: number | null;
  prevRStar?: number | null;
  style?: 'sp' | 'dp';
  layoutMode?: boolean;
}
// UMD APIs and data have heterogeneous schemas; keep this boundary local.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KernelResources = Record<string, any>;
const DIFF: Record<string, string> = {
  SPB: 'BEGINNER', SPN: 'NORMAL', SPH: 'HYPER', SPA: 'ANOTHER', SPL: 'LEGGENDARIA',
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};
const LAMP: Record<string, number> = { NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7 };
const CN: Record<string, string> = { NORMAL: 'DP_NOR', HYPER: 'DP_HYP', ANOTHER: 'DP_ANO', LEGGENDARIA: 'DP_LEG' };

/** PlayData/gistLib adapter, including unplayed and locked cells with notes. */
export function rowsToWeaknessCharts(rows: SongRow[]) {
  const out = [];
  for (const r of rows) for (const slot of DP_SLOTS) {
    const c = r.charts[slot];
    if (!c || !c.noteCount || c.noteCount <= 0) continue;
    out.push({ title: r.title, diff: DIFF[slot], exScore: c.exScore || 0,
      noteCount: c.noteCount, scorePercent: ((c.exScore || 0) / (c.noteCount * 2)) * 100,
      lampNum: LAMP[c.lamp] ?? 0 });
  }
  return out;
}

export function runKernel(kind: S1Kind, input: ComputeInput, options: KernelOptions, libs: KernelResources): unknown {
  const normFn = libs.OhsorryNorm.norm as (s: string) => string;
  const excluded = new Set(input.notInInf);
  switch (kind) {
    case 'dp-star': {
      if (!input.osrCharts.length) return null;
      const r = libs.onlyOSRtoEreter.inferEreter(input.osrCharts, libs.rating,
        { charts: libs.ereter.charts, players: {} }, options.prevStar != null ? { prevStar: options.prevStar } : undefined);
      if (typeof r.ereterStar !== 'number') return null;
      return { star: r.ereterStar,
        starRaw: typeof r.ereterStarRaw === 'number' ? r.ereterStarRaw : r.ereterStar,
        ratcheted: r.ratcheted,
        nativeStar: typeof r.ohsorryStar === 'number' ? r.ohsorryStar : r.ereterStar,
        tier: r.tier ?? null, nFit12: r.nFit12 ?? null };
    }
    case 'r-star': {
      const charts = extractCharts(input.rows, { slots: DP_SLOTS }).filter(c =>
        ((LAMP[c.lamp] ?? 0) > 0 || c.exScore > 0) && !excluded.has(normFn(c.title) + '|' + c.slot));
      if (!charts.length) return null;
      const r = libs.userRateStar.inferUserRStar(charts.map(c => ({ title: c.title, diff: DIFF[c.slot],
        exScore: c.exScore, noteCount: c.noteCount })), libs.rating,
      { normFn, scale: libs.rating.rateStar?.scale ?? null, prevRStar: options.prevRStar ?? null });
      return typeof r.rStar === 'number' && Number.isFinite(r.rStar) ? r.rStar : null;
    }
    case 'sp-star': {
      const charts = extractCharts(input.rows, { slots: SP_SLOTS, level: 12 })
        .filter(c => !excluded.has(normFn(c.title) + '|' + c.slot));
      if (!charts.length) return null;
      const own = charts.map(c => ({ title: c.title, diff: DIFF[c.slot], gameLevel: 12, lampNum: LAMP[c.lamp] ?? 0 }));
      const r = libs.spSkillCpi.computeSpStarGuarded
        ? libs.spSkillCpi.computeSpStarGuarded(own, libs.cpi, { normFn })
        : libs.spSkillCpi.computeUserSpCpi(own, libs.cpi, { normFn, mode: 'unified' });
      return r.cpi == null ? null : r;
    }
    case 'weakness': {
      const allCharts = rowsToWeaknessCharts(input.rows);
      if (!allCharts.length) return null;
      const v = libs.OhsorryWeakness.calcUserWeakness({ allCharts, patternsMap: libs.patterns,
        normFn, ratingMap: libs.rating?.ratings || null, zasaMap: libs.zasa?.charts || null, rateRef: libs.rateRef });
      return v && v.__entries ? v : null;
    }
    case 'layout': {
      if (options.style === 'sp' || !options.layoutMode) return null;
      const userVec = Object.prototype.hasOwnProperty.call(libs, 'userVec')
        ? libs.userVec : runKernel('weakness', input, options, libs);
      if (!userVec) return null;
      const titleToPatternId: Record<string, string> = {};
      for (const id of Object.keys(libs.patterns)) {
        const t = libs.patterns[id]?.t;
        if (!t) continue;
        const k = normFn(t);
        if (k && !titleToPatternId[k]) titleToPatternId[k] = id;
      }
      const out = new Map<string, string>();
      for (const meta of input.songs) {
        if (!meta.title || typeof meta.ac !== 'number' || (meta.ac & 2) === 0) continue;
        const sid = titleToPatternId[normFn(meta.title)];
        const sp = sid && libs.patterns[sid];
        if (!sp?.c) continue;
        for (const diff of Object.keys(CN)) {
          if (diff === 'LEGGENDARIA' && !(typeof meta.legen === 'number' && (meta.legen & 2) !== 0)) continue;
          if (!sp.c[CN[diff]]) continue;
          try {
            const r = libs.OhsorryWeakness.chartStrengthMatch8Way(sp.c[CN[diff]], userVec);
            if (typeof r?.bestLabel === 'string') out.set(normFn(meta.title) + '|' + diff, r.bestLabel);
          } catch { /* Existing PlayData policy: skip a failed chart. */ }
        }
      }
      return Array.from(out.entries());
    }
  }
}
