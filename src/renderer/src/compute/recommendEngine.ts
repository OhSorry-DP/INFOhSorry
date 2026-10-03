import { createRecCtx } from '../recommendCore';
import { norm } from '../../../shared/match';
import { makeOptionsKey } from './revisionKey';
import { createResultCache } from './resultCache';
import type { ComputeInput, KernelResources } from './kernels';
import { handleRecommendRequest, type RecRequest } from './recommendBridgeHandler';
import { refreshRecs, recRowToCandidate } from './recommendPresentation';

// UMD context and rows are deliberately confined to this Worker boundary.
type Any = any;
export interface RecommendQueryOptions {
  contextHandle: string;
  operation: 'clear-pool' | 'practice' | 'bridge' | 'cards' | 'refresh';
  layout: 'on' | 'off';
  baseStar?: number;
  stage?: 'ec' | 'hc' | 'exh';
  levelMode?: string;
  djMode?: string;
  rerollToken?: number | string;
  practice?: Record<string, unknown>;
  request?: RecRequest;
  bridge?: { baseStar: number | null; userRStar: number | null; userCharts: Any[] };
  rows?: unknown[];
  previous?: Any;
  charts?: Any[];
  presentation?: 'candidate';
}

/** Canonical recommend.js stratifiedSample: preserve draw count and row ordering. */
function sample(ranked: Any[], n: number): Any[] {
  if (ranked.length <= n) return ranked.slice();
  const shuffle = (a: Any[]): Any[] => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const bandSize = Math.ceil(ranked.length / 3), base = Math.floor(n / 3), rem = n - base * 3;
  let out: Any[] = [], leftover: Any[] = [];
  for (let b = 0; b < 3; b++) {
    const band = shuffle(ranked.slice(b * bandSize, (b + 1) * bandSize));
    const k = Math.min(base + (b < rem ? 1 : 0), band.length);
    out = out.concat(band.slice(0, k));
    leftover = leftover.concat(band.slice(k));
  }
  if (out.length < n) out = out.concat(shuffle(leftover).slice(0, n - out.length));
  return out;
}

function patternsSnapshot(libs: KernelResources): Any {
  const out = { ...libs.patterns };
  for (const extra of [libs.patterns0810, libs.patternsRest]) {
    if (!extra) continue;
    for (const [id, data] of Object.entries(extra) as [string, Any][]) {
      out[id] = out[id] ? { ...out[id], c: { ...out[id].c, ...data.c } } : data;
    }
  }
  return out;
}

function infPredicate(input: ComputeInput): (title: string, chartName?: string) => boolean {
  const excluded = new Set(input.notInInf);
  const slots: Record<string, string> = { DP_NOR: 'DPN', DP_HYP: 'DPH', DP_ANO: 'DPA', DP_LEG: 'DPL' };
  const songs = input.songs == null ? null : new Map<string, NonNullable<typeof input.songs>>();
  for (const song of input.songs || []) {
    const key = norm(song.title);
    songs!.set(key, [...(songs!.get(key) || []), song]);
  }
  return (title, chartName) => {
    const key = norm(title), slot = chartName && slots[chartName];
    if (slot && excluded.has(key + '|' + slot)) return false;
    if (!songs) return true;
    if (!title) return false;
    const isLeg = chartName === 'DP_LEG' || chartName === 'SP_LEG';
    return (songs.get(key) || []).some(song => {
      const value = isLeg ? song.legen : song.ac;
      return typeof value === 'number' && (value & 2) !== 0;
    });
  };
}

function card(ctx: Any, row: Any): Any {
  const categories: Record<string, string> = { 'challenge-hard': 'hard', 'challenge-easy': 'easy', cleanup: 'cleanup', 'exh-near': 'cleanup' };
  try {
    const category = row.category ? categories[row.category] : ['easy', 'hard', 'cleanup'].includes(row._category) ? row._category : 'cleanup';
    const r = { title: row.title, chart: row.chart || row.diff, _category: category || 'cleanup' };
    const match = ctx.chartStrengthMatchByHand(r), tags = ctx.computeChartTags(r);
    const hashtags = ctx.computeRecHashtags({ ...r, _matchByHand: match, _tags: tags });
    return { ...row, _cardHashtags: Array.isArray(hashtags) ? hashtags.join(' ') : '', _cardBestLabel: match?.bestLabel || '' };
  } catch {
    return { ...row, _cardHashtags: '', _cardBestLabel: '' };
  }
}

export function createRecommendEngine() {
  const contexts = new Map<string, { ctx: Any; libs: KernelResources; dto: Any }>();
  const results = createResultCache<Any>({ maxEntries: 64, maxBytes: 16 * 1024 * 1024 });
  const pools = createResultCache<Any[]>({ maxEntries: 64, maxBytes: 16 * 1024 * 1024 });
  const bytes = (value: Any) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const touch = (key: string) => {
    const entry = contexts.get(key);
    if (!entry) throw new Error('RECOMMEND_CONTEXT_MISSING');
    contexts.delete(key); contexts.set(key, entry);
    return entry;
  };
  return {
    context(key: string, input: ComputeInput, libs: KernelResources): Any {
      if (contexts.has(key)) return structuredClone(touch(key).dto);
      const ctx = createRecCtx({ rows: input.rows, ratingData: libs.rating, zasaData: libs.zasa, ereterData: libs.ereter,
        isInfChart: infPredicate(input), libs: { weakness: libs.OhsorryWeakness, normLib: libs.OhsorryNorm,
          recommend: libs.OhsorryRecommend, patterns: patternsSnapshot(libs), rateRef: libs.rateRef,
          featureScores: libs.featureScores, textageMeta: libs.textageMeta, seriesNames: libs.seriesNames,
          weaknessPopMean: libs.weaknessPopMean } });
      const dto = { contextHandle: key, coreVersion: libs.OhsorryRecommend.VERSION || null,
        practiceParents: ctx.practiceParents || null, practiceSubfeats: ctx.practiceSubfeats || null,
        practiceSubfeatsHidden: ctx.practiceSubfeatsHidden || null, practiceZasaDefault: ctx.practiceZasaDefault || null };
      contexts.set(key, { ctx, libs, dto });
      while (contexts.size > 2) {
        const old = contexts.keys().next().value!;
        contexts.delete(old); results.invalidateOwner(old); pools.invalidateOwner(old);
      }
      return structuredClone(dto);
    },
    query(key: string, options: RecommendQueryOptions): Any {
      const entry = touch(key), { ctx, libs } = entry;
      ctx.setLayoutMode(options.layout);
      const resultKey = makeOptionsKey([key, options]);
      // Tokenless bridge requests retain their historical fresh-random behavior.
      const cacheResult = options.rerollToken !== undefined || options.operation === 'cards';
      if (cacheResult && results.has(resultKey)) return structuredClone(results.get(resultKey));
      let result: Any;
      if (options.operation === 'cards') result = (options.rows || []).map(row => card(ctx, row));
      else if (options.operation === 'refresh') {
        const refreshed = refreshRecs(options.previous, options.stage || 'ec', options.charts || [], options.djMode === 'on' ? 'on' : 'off');
        const enrich = (row: Any) => {
          const enriched = card(ctx, row);
          return { ...row, cardHashtags: enriched._cardHashtags, cardBestLabel: enriched._cardBestLabel };
        };
        result = { picked: refreshed.picked.map(enrich), pool: refreshed.pool.map(enrich) };
      }
      else if (options.operation === 'clear-pool') {
        const stage = options.stage || 'ec';
        if (stage !== 'ec' && (options.baseStar ?? 0) < 0.5) return { picked: [], pool: [] };
        const threshold = { ec: 3, hc: 5, exh: 6 }[stage];
        const poolKey = makeOptionsKey([key, options.layout, options.baseStar, stage, options.levelMode, options.djMode]);
        let ranked = pools.get(poolKey);
        if (!ranked) {
          const deterministic = ctx.buildRecsWithPool(threshold, stage, options.baseStar, options.levelMode, options.djMode, { randomize: false });
          ranked = [...deterministic.picked, ...deterministic.pool];
          pools.set(poolKey, ranked!, bytes(ranked), key);
        }
        const picked = sample(ranked!, 10), keys = new Set(picked.map(row => (row.title || '') + '|' + row.chart));
        result = { picked: picked.map(row => card(ctx, row)), pool: ranked!.filter(row => !keys.has((row.title || '') + '|' + row.chart)).map(row => card(ctx, row)) };
      } else if (options.operation === 'practice') {
        const opts = options.practice || {};
        // App's ordinary practice modes have selection-independent row decoration.
        // Request the complete random pool (no RNG draws when topN === poolSize),
        // then perform exactly the canonical sampler. Advanced bridge/BPM modes
        // retain direct canonical execution because their selection differs.
        const supported = new Set(['mode', 'topN', 'handMode', 'strength', 'flipOn', 'randomize', 'zasaMin', 'zasaMax', 'minZasa', 'maxZasa']);
        const canCachePool = opts.randomize === true && Object.keys(opts).every(key => supported.has(key))
          && ['all', 'CHARGE', 'SCRATCH', 'SOF-LAN'].includes(String(opts.mode || 'all'));
        if (canCachePool) {
          const poolKey = makeOptionsKey([key, 'practice', options.layout, options.baseStar, { ...opts, topN: undefined }]);
          let ranked = pools.get(poolKey);
          if (!ranked) {
            ranked = ctx.buildWeaknessRecs(options.baseStar, { ...opts, topN: 60 });
            pools.set(poolKey, ranked!, bytes(ranked), key);
          }
          result = sample(ranked!, typeof opts.topN === 'number' ? opts.topN : 5).map(row => card(ctx, row));
        } else result = ctx.buildWeaknessRecs(options.baseStar, opts).map((row: Any) => card(ctx, row));
      } else {
        if (!options.request) throw new Error('RECOMMEND_REQUEST_MISSING');
        result = handleRecommendRequest(options.request, { recCtx: ctx, ratingData: libs.rating,
          baseStar: options.bridge?.baseStar ?? null, userRStar: options.bridge?.userRStar ?? null,
          userCharts: options.bridge?.userCharts || [], normFn: libs.OhsorryNorm.norm, coreVersion: entry.dto.coreVersion });
      }
      if (options.presentation === 'candidate') {
        if (options.operation === 'clear-pool') result = {
          picked: result.picked.map((row: Any) => recRowToCandidate(row, options.stage || 'ec')),
          pool: result.pool.map((row: Any) => recRowToCandidate(row, options.stage || 'ec')),
        };
        else if (options.operation === 'practice') result = result.map((row: Any) => recRowToCandidate(row, 'weakness'));
        else if (options.operation === 'cards') result = result.map((row: Any) => ({
          ...row, cardHashtags: row._cardHashtags, cardBestLabel: row._cardBestLabel,
        }));
      }
      if (cacheResult) {
        results.set(resultKey, structuredClone(result), bytes(result), key);
      }
      return structuredClone(result);
    },
    clear(): void { contexts.clear(); results.clear(); pools.clear(); },
  };
}
