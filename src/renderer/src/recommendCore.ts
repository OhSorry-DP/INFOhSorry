// recommend.js (ohSorry 본체와 동일 모듈) 호출 헬퍼.
//
// 흐름:
//   1. recommend.js / calcWeakness.js / normTitle.js gist fetch (PlayData / WeaknessRecommend 와 module global cache 공유)
//   2. patterns-all-slim.json / rate-reference-slim.json / feature-scores-slim.json / textage-meta / series-name.json fetch
//   3. TSV (SongRow[]) + ratingData + zasaData + ereterData → deps 빌드 (allCharts / ereterMap / ratingMap / zasaMap / etc)
//   4. window.OhsorryRecommend.createContext(deps) 호출 → ctx
//   5. ctx.buildRecs(threshold, stage, baseStar, levelMode, djMode) → 클리어 추천 10곡
//   6. ctx.buildWeaknessRecs(baseStar, opts) → 연습곡 추천 N곡
//
// 결과 row 형식: recommend.js 의 raw row 그대로 (RecRow). _hashtags / _matchByHand / _category 등 포함.
// UI 가 RecRow 를 받아 표시 (App.tsx / RecommendByCore.tsx).

import type { SongRow, ChartSlot, RatingData, ZasaData, EreterData } from '../../shared/types';
import { norm } from '../../shared/match';

// ─── gist URL ────────────────────────────────────────────────────────
export const GIST_RAW = 'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw';
const SERIES_GIST = 'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw';
const CALC_WEAKNESS_URL = `${GIST_RAW}/calcWeakness.js`;
const NORM_TITLE_URL = `${GIST_RAW}/normTitle.js`;
const RECOMMEND_URL = `${GIST_RAW}/recommend.js`;
const PATTERNS_URL = `${GIST_RAW}/patterns-all-slim.json`;
const RATE_REF_URL = `${GIST_RAW}/rate-reference-slim.json`;
const FEATURE_SCORES_URL = `${GIST_RAW}/feature-scores-slim.json`;
const TEXTAGE_META_URL = `${GIST_RAW}/textage-meta.json`;
const SERIES_NAME_URL = `${SERIES_GIST}/series-name.json`;

// ─── module global cache (Analysis / PlayData / WeaknessRecommend 와 공유) ───
export async function loadGistModule(url: string, globalKey: string): Promise<unknown> {
  const w = window as unknown as Record<string, unknown>;
  if (w[globalKey]) return w[globalKey];
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${globalKey} fetch HTTP ${res.status}`);
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(text)();
  return w[globalKey];
}
async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`JSON fetch HTTP ${res.status}`);
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLib = any;

// ─── 결과 row 형식 (recommend.js buildRecs / buildWeaknessRecs 의 raw row) ───
// UI 가 이 형식 그대로 받아 표시. 모든 필드 optional 처리 (recommend.js 가 case 별로 다르게 채움).
export interface RecRow {
  title: string;
  chart: string;                     // 'NORMAL' / 'HYPER' / 'ANOTHER' / 'LEGGENDARIA'
  level: number;                     // zasa★
  ec: number | null;
  hc: number | null;
  exh: number | null;
  ec_n?: number | null;
  hc_n?: number | null;
  exh_n?: number | null;
  diffValue: number;                 // stage 별 ★ (estEc/estHc/estExh)
  currentLamp?: string;              // 본인 lamp (풀네임)
  margin?: number;
  gameLevel?: number | null;
  ratingOnly?: boolean;
  lampNum?: number;
  djLevel?: string | null;
  exScore?: number;
  noteCount?: number;
  scoreRate?: number | null;
  _hideDiffValue?: boolean;
  _category?: 'cleanup' | 'easy' | 'hard' | 'weakness';
  _clearScore?: number;
  _clearType?: 'near-lamp' | 'score-ready' | 'popular' | 'fit';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _matchByHand?: any;                // { bestLabel, bestTotal, best, ... }
  _tags?: string[];                  // 차트 feature top 3
  _hashtags?: string[];              // 카테고리 / 시리즈 / FLIP / 한손 / pattern 태그
  _layoutGain?: number;
  // buildWeaknessRecs 전용
  _weaknessRate?: number | null;
  _weaknessDeficit?: number;
  _practiceScore?: number;
  _practiceType?: 'review' | 'pattern' | 'score' | 'practical';
  _targetRate?: number | null;
  _targetExScore?: number | null;
  _targetDjLevel?: string | null;
  _currentExScore?: number | null;
}

// ─── deps 빌드 ────────────────────────────────────────────────────────
const SLOT_TO_DIFF_KEY: Record<string, string> = {
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};
const LAMP_ABBR_TO_NUM: Record<string, number> = {
  NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7,
};
const LAMP_ABBR_TO_FULL: Record<string, string> = {
  NP: 'NO PLAY', F: 'FAILED', AC: 'ASSIST', EC: 'EASY', NC: 'CLEAR',
  HC: 'HARD', EX: 'EX HARD', FC: 'FULL COMBO', PFC: 'PERFECT FC',
};

// TSV → recommend.js 가 받는 allCharts 형식. lampNum 포함.
//   ohSorry dbConn 의 charts_json 과 같은 구조 — title, diff, slot, lamp/lampNum, exScore, missCount, noteCount, level, djLevel, gameLevel.
function rowsToAllCharts(rows: SongRow[]): AnyLib[] {
  const out: AnyLib[] = [];
  for (const r of rows) {
    for (const slot of ['DPN', 'DPH', 'DPA', 'DPL'] as ChartSlot[]) {
      const c = r.charts[slot];
      if (!c) continue;
      const diff = SLOT_TO_DIFF_KEY[slot];
      if (!diff) continue;
      out.push({
        title: r.title,
        diff,
        slot,
        lamp: LAMP_ABBR_TO_FULL[c.lamp] || c.lamp,    // 풀네임 (recommend.js currentLamp 호환)
        lampNum: LAMP_ABBR_TO_NUM[c.lamp] ?? 0,
        exScore: c.exScore || 0,
        noteCount: c.noteCount || 0,
        scorePercent: c.noteCount > 0 ? (c.exScore / (c.noteCount * 2)) * 100 : null,
        missCount: typeof c.missCount === 'number' ? c.missCount : null,
        djLevel: c.letter || null,
        gameLevel: typeof c.level === 'number' ? c.level : null,
      });
    }
  }
  return out;
}

// ratingData → Map<norm(title)+'|'+diff, { zasaLevel, gameLevel, estEc, estHc, estExh, nEcCleared, nHcCleared, nExhCleared }>
function buildRatingMap(ratingData: RatingData | null): Map<string, AnyLib> {
  const m = new Map<string, AnyLib>();
  if (!ratingData?.ratings) return m;
  for (const r of ratingData.ratings) {
    if (!r.title || !r.diff) continue;
    m.set(norm(r.title) + '|' + r.diff, r);
  }
  return m;
}

// ereterData → Map<norm(title)+'|'+diff, { level, ec, hc, exh, ec_n, hc_n, exh_n }>
function buildEreterMap(ereterData: EreterData | null): Map<string, AnyLib> {
  const m = new Map<string, AnyLib>();
  if (!ereterData?.charts) return m;
  for (const c of ereterData.charts) {
    if (!c.title || !c.diff) continue;
    m.set(norm(c.title) + '|' + c.diff, c);
  }
  return m;
}

// zasaData → Map<norm(title)+'|'+diff, { level }>
function buildZasaMap(zasaData: ZasaData | null): Map<string, AnyLib> {
  const m = new Map<string, AnyLib>();
  if (!zasaData?.charts) return m;
  for (const z of zasaData.charts) {
    if (!z.title || !z.diff) continue;
    m.set(norm(z.title) + '|' + z.diff, z);
  }
  return m;
}

// zasaData 의 (gameLevel → 평균 zasa level) — recommend.js 의 low-level 추천 fallback 에 사용.
function buildZasaAvgByGameLv(zasaData: ZasaData | null): Record<number, number> {
  const out: Record<number, number> = {};
  if (!zasaData?.charts) return out;
  const bins: Record<number, { sum: number; n: number }> = {};
  for (const z of zasaData.charts) {
    const gl = (z as unknown as { gameLevel?: number }).gameLevel;
    if (typeof gl !== 'number' || typeof z.level !== 'number') continue;
    if (!bins[gl]) bins[gl] = { sum: 0, n: 0 };
    bins[gl].sum += z.level;
    bins[gl].n += 1;
  }
  for (const k of Object.keys(bins)) {
    const b = bins[+k];
    out[+k] = b.sum / b.n;
  }
  return out;
}

// patterns-all-slim.json 의 title → song id 인덱스.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPatternsTitleMap(patternsMap: AnyLib, normFn: (s: string) => string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const id of Object.keys(patternsMap)) {
    const t = patternsMap[id]?.t;
    if (!t) continue;
    const k = normFn(t);
    if (k && !m[k]) m[k] = id;
  }
  return m;
}

// textage-meta 의 (title → series_no) Map. recommend.js 의 #시리즈명 해시태그 용.
interface TextageMeta {
  songs: Record<string, { title?: string; series_no?: number }>;
}
function buildTextageSeriesByNorm(meta: TextageMeta | null, normFn: (s: string) => string): Map<string, number> {
  const m = new Map<string, number>();
  if (!meta?.songs) return m;
  for (const id of Object.keys(meta.songs)) {
    const e = meta.songs[id];
    if (!e?.title || typeof e.series_no !== 'number') continue;
    const k = normFn(e.title);
    if (k && !m.has(k)) m.set(k, e.series_no);
  }
  return m;
}

// ─── lib 로드 + ctx 생성 ────────────────────────────────────────────
//   마운트 1회만 lib fetch. ctx 생성은 데이터 변경 시마다 (TSV 갱신 / rating / zasa / ereter 변경).
export interface RecCoreLibs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  weakness: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normLib: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recommend: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patterns: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rateRef: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  featureScores: any;
  textageMeta: TextageMeta;
  seriesNames: Record<string, string>;
}

export async function loadRecLibs(): Promise<RecCoreLibs> {
  const [weakness, normLib, recommend, patterns, rateRef, featureScores, textageMeta, seriesNames] = await Promise.all([
    loadGistModule(CALC_WEAKNESS_URL, 'OhsorryWeakness'),
    loadGistModule(NORM_TITLE_URL, 'OhsorryNorm'),
    loadGistModule(RECOMMEND_URL, 'OhsorryRecommend'),
    loadJson(PATTERNS_URL),
    loadJson(RATE_REF_URL),
    loadJson(FEATURE_SCORES_URL),
    loadJson<TextageMeta>(TEXTAGE_META_URL),
    loadJson<Record<string, string>>(SERIES_NAME_URL).catch(() => ({} as Record<string, string>)),
  ]);
  return { weakness, normLib, recommend, patterns, rateRef, featureScores, textageMeta, seriesNames };
}

export interface RecContextInput {
  libs: RecCoreLibs;
  rows: SongRow[];
  ratingData: RatingData | null;
  zasaData: ZasaData | null;
  ereterData: EreterData | null;
  // INF 수록 여부 필터 (title, chartName) → boolean. supabaseSync.getInfChartChecker() 결과.
  //   buildWeaknessRecs 가 patternsMap 전체(AC+INF)를 순회하므로 INF 수록 차트만 남기는 데 필수.
  //   없으면 모든 차트 통과 (필터 비활성 — 로딩 전 fallback).
  isInfChart?: (title: string, chartName?: string) => boolean;
}

// recommend.js 의 createContext 호출 + ctx 반환. ctx 안에 buildRecs / buildWeaknessRecs / setLayoutMode 등.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRecCtx(input: RecContextInput): any {
  const { libs, rows, ratingData, zasaData, ereterData } = input;
  const normFn = (libs.normLib?.norm) as (s: string) => string;
  if (!normFn) throw new Error('normLib.norm 없음');
  // 1. allCharts (TSV 변환) — INF 미수록 차트 제외.
  //   Reflux TSV 에는 데이터가 있어도 실제 INFINITAS 에 노출 안 되는 차트가 섞여 있음 (notInINF / songs.legen 미수록).
  //   clear 추천 풀(buildPools)·userVec 모두 이 비수록 차트를 빼야 함.
  const SLOT_TO_CN: Record<string, string> = { DPN: 'DP_NOR', DPH: 'DP_HYP', DPA: 'DP_ANO', DPL: 'DP_LEG' };
  const allChartsRaw = rowsToAllCharts(rows);
  const isInf = input.isInfChart;
  const allCharts = isInf
    ? allChartsRaw.filter((c) => isInf(String(c.title || ''), SLOT_TO_CN[c.slot as string]))
    : allChartsRaw;
  // 2. userVec — calcWeakness.calcUserWeakness 호출
  const userVec = libs.weakness.calcUserWeakness({
    allCharts,
    patternsMap: libs.patterns,
    normFn,
    ratingMap: ratingData?.ratings || null,
    zasaMap: zasaData?.charts || null,
    rateRef: libs.rateRef,
  });
  // 3. 인덱스 빌드
  const patternsTitleMap = buildPatternsTitleMap(libs.patterns, normFn);
  const ereterMap = buildEreterMap(ereterData);
  const ratingMap = buildRatingMap(ratingData);
  const zasaMap = buildZasaMap(zasaData);
  const zasaAvgByGameLv = buildZasaAvgByGameLv(zasaData);
  const textageSeriesByNorm = buildTextageSeriesByNorm(libs.textageMeta, normFn);
  // INF 수록 차트만 통과 — buildWeaknessRecs 가 patternsMap 전체(AC+INF)를 순회하므로 필수.
  //   input.isInfChart (songs.ac/legen + service-status notInINF 기반) 사용. 미전달 시 모든 차트 통과(로딩 전 fallback).
  const isInfChartInSeries = input.isInfChart || ((): boolean => true);
  // pdLayoutMap — buildWeaknessRecs 가 layoutLabel 기록할 외부 객체 (PlayData 의 배치 토글과 같은 패턴).
  const pdLayoutMap: Record<string, string> = {};
  const ctx = libs.recommend.createContext({
    userVec, weaknessLib: libs.weakness,
    patternsMap: libs.patterns, patternsTitleMap, normFn,
    seriesNames: libs.seriesNames, textageSeriesByNorm,
    allCharts, ereterMap, ratingMap, zasaMap, zasaAvgByGameLv,
    featureScoresMap: libs.featureScores,
    isInfChartInSeries,
    pdLayoutMap,
  });
  return ctx;
}
