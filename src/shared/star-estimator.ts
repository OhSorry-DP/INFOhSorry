// ohSorry v3.3.3 별값 추정 모델 — INFOhSorry 용 포팅
//
// 원본: d:\work\ohSorry\2-calc-score.js (v3.3.3 / 2026-05-10 기준)
//
// v3.3.x 변경사항:
//   v3.3.1: 추정 하한 0.5 → 0.01 (LOW_FALLBACK + RAW_BOUNDS)
//   v3.3.2: EC-only 사용자 (HC/EXH 클리어 < 10) 에 raw + max_clear 기반 선형 보정
//           true ≈ -0.158 + 0.761·raw_s + 0.250·fEc.max_clear (16명 fit, MAE 41% 감소)
//   v3.3.3: caller 가 4종 fitData scope 동시 계산해서 max 채택 (이 파일은 단일 호출만 처리,
//           multi-scope 처리는 App.tsx 에서)
//
// 단계:
//   1. raw S grid search (logistic NLL, alpha = quadratic of S)
//   2. golden-section refinement
//   3. feature 추출 (lamp 별 6개 + AC/FC 8개 + v3.2 7개 = 21+8+7+intercept+rawS+rawS²=36)
//   4. Ridge 회귀 (α=5.0, learned coef hardcoded)
//   5. v3.2.7 bin clear-rate 누적 post-correction
//   6. v3.2.6 djLevel boost (M lamp = EC + djLv ≥ A 일 때)
//   7. v3.2.10 ridge muting (bin 보너스 활성 + ridge < 0 면 ridge=0)
//   8. clamp [0, 15]
//
// 입력:
//   fitData: NP 제외, ★11.6~12.7, 매칭된 차트들의 (d, p, stage) 배열
//     - d = ereter 의 ★ 값 (ec/hc/exh 별)
//     - p = 1 (그 stage 도달) / 0 (실패). ASSIST 는 ohSorry 규칙대로 모든 stage 에서 fail.
//     - stage = 'ec' | 'hc' | 'exh'
//   poolCharts: 매칭된 모든 차트 (level + lamp + djLevel + ec/hc/exh).
//     v3.2 의 M, top10_avg 등 feature 계산용. NP 도 포함 (lamp == 0 처리됨).
//
// 출력: StarResult — { star, raw, ... 디버깅 필드 }, 또는 표본 부족 시 null.

export interface FitDatum {
  d: number;
  p: 0 | 1;
  stage: 'ec' | 'hc' | 'exh';
}

export interface PoolChart {
  lampNum: number; // 0..7
  level: number; // ereter ★
  djLevel: string | null; // 'AAA'/'AA'/'A'/'B'/'C'/'D'/'E'/'F' or null
  ec: number | null;
  hc: number | null;
  exh: number | null;
}

export interface StarResult {
  star: number;
  raw: number;
  validStages: string[];
  fitDataCount: number;
  nClearedV32: number;
  isUnderCutoff: boolean;
  ridgeCorrection: number;
  ridgeMuted: boolean;
  postCorrection: number;
  djBoost: number;
  djBoostInfo: { djLevel: string; gap: number; curveW: number } | null;
  binImplied: { stage: string; implied: number; bonus: number } | null;
  isEcOnlyValid: boolean; // v3.3.2: HC/EXH 클리어 < 10 → EC 만 유효
  ecOnlyApplied: boolean; // v3.3.2: 실제 EC-only 보정이 starEstimate 를 끌어올렸는지
}

// ============================================================
// 모델 파라미터 (v3.2.10)
// ============================================================
// alpha 의 quadratic coefficients (raw S 의 함수)
const ALPHA_COEFF: Record<'ec' | 'hc' | 'exh', [number, number, number]> = {
  ec: [194.445153, 41.489739, 6.085698],
  hc: [119.451394, 295.165202, -20.796304],
  exh: [2.722775, 0.444754, 3.689284],
};

// 36-feature Ridge 계수 (intercept 포함)
const RIDGE_COEF = [
  -0.006071, -0.464910, -0.011718,
  // ec base 6
  +0.112154, -0.007165, -0.046545, -0.059173, -0.049017, +0.224936,
  // hc base 6
  +0.056395, -0.009976, +0.050729, -0.032504, -0.007578, -0.000059,
  // exh base 6
  +0.003160, +0.001351, -0.030269, +0.034971, -0.054444, +0.024824,
  // AC/FC 8
  -0.060741, -0.016712, -0.112941, +0.019729, +0.132479, -0.115328, -0.038194, +0.036031,
  // v3.2 추가 7
  +0.210155, +0.368437, -0.139323, -0.019140, -0.092587, -0.027596, -0.004606,
];

const CUTOFF_N_CLEARED = 50;
const SIGMA_PROB = 1.0;
const PROB_NOISE_THRESHOLD = 0.99;
const MARGIN_TH = 1.3;
const MIN_CLEAR_PER_LAMP = 10;
const LOW_FALLBACK = 0.01; // v3.3.1+: 0.5 → 0.01
const RAW_BOUNDS: [number, number] = [0.01, 14.5]; // v3.3.1+

// v3.3.2: EC-only 보정 계수
const EC_ONLY_INTERCEPT = -0.158;
const EC_ONLY_RAW_COEF = 0.761;
const EC_ONLY_MAXCLEAR_COEF = 0.25;
const Z_CLAMP = 50;

// v3.2.4 + v3.2.7 + v3.2.10 — bin post-correction
const STAGE_BONUS_V324: Record<'ec' | 'hc' | 'exh', number> = { ec: 0.05, hc: 0.1, exh: 0.15 };
const STAGE_MIN_V324: Record<'ec' | 'hc' | 'exh', number> = { ec: 4, hc: 3, exh: 2 };
const NEXT_BIN_W_V324 = [1.0, 0.5, 0.25];
const POSTCOR_WEIGHT_V324 = 0.7;
const BIN_W_V324 = 0.1;
const RATE_LO_V327 = 0.8;

// v3.2.6 djLevel boost
const DJ_ORD: Record<string, number> = { F: 0, E: 1, D: 2, C: 3, B: 4, A: 5, AA: 6, AAA: 7 };
const V326_MIN_DJ_ORD = 5;
const V326_MIN_RAW_S = 3;
const V326_GAP_LO = 2.5;
const V326_GAP_HI = 4.0;
const V326_WEIGHT = 0.7;

// ============================================================
// 핵심 함수
// ============================================================
function alphaOf(S: number, st: 'ec' | 'hc' | 'exh'): number {
  const [a0, a1, a2] = ALPHA_COEFF[st];
  return Math.max(a2 * S * S + a1 * S + a0, 0.1);
}

function p50(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function estimateStar(
  fitData: FitDatum[],
  poolCharts: PoolChart[],
): StarResult | null {
  if (fitData.length < 30) return null;

  // 1단계 prep — lamp 별 분리
  const byLamp: Record<'ec' | 'hc' | 'exh', { d: number; p: 0 | 1 }[]> = {
    ec: [],
    hc: [],
    exh: [],
  };
  for (const { d, p, stage } of fitData) byLamp[stage].push({ d, p });

  const clearCounts = {
    ec: byLamp.ec.filter((x) => x.p === 1).length,
    hc: byLamp.hc.filter((x) => x.p === 1).length,
    exh: byLamp.exh.filter((x) => x.p === 1).length,
  };
  const validStages = (['ec', 'hc', 'exh'] as const).filter(
    (st) => clearCounts[st] >= MIN_CLEAR_PER_LAMP,
  );

  // v3.3.2: EC-only 사용자 식별 (HC/EXH 클리어 < 10)
  const isEcOnlyValid = validStages.length === 1 && validStages[0] === 'ec';

  if (validStages.length === 0) {
    // 모든 lamp 에서 클리어 < 10 — 저렙 fallback
    return {
      star: LOW_FALLBACK,
      raw: LOW_FALLBACK,
      validStages: [],
      fitDataCount: fitData.length,
      nClearedV32: 0,
      isUnderCutoff: true,
      ridgeCorrection: 0,
      ridgeMuted: false,
      postCorrection: 0,
      djBoost: 0,
      djBoostInfo: null,
      binImplied: null,
      isEcOnlyValid: false,
      ecOnlyApplied: false,
    };
  }

  // 1단계: NLL grid search
  const negLogLik = (S: number): number => {
    let total = 0;
    for (const st of validStages) {
      const a = alphaOf(S, st);
      for (const { d, p } of byLamp[st]) {
        let z = a * (d - S);
        if (z > Z_CLAMP) z = Z_CLAMP;
        else if (z < -Z_CLAMP) z = -Z_CLAMP;
        const sp = Math.max(z, 0) + Math.log(1 + Math.exp(-Math.abs(z)));
        const logSig = -sp;
        const log1m = z - sp;
        total -= p === 1 ? logSig : log1m;
      }
    }
    return total;
  };

  const lo = Math.round(RAW_BOUNDS[0] * 100);
  const hi = Math.round(RAW_BOUNDS[1] * 100);
  let bestS = RAW_BOUNDS[0];
  let bestNll = Infinity;
  for (let i = lo; i <= hi; i++) {
    const S = i / 100;
    const nll = negLogLik(S);
    if (nll < bestNll) {
      bestNll = nll;
      bestS = S;
    }
  }

  // golden-section refinement (±0.01 구간)
  const gsLo = Math.max(RAW_BOUNDS[0], bestS - 0.01);
  const gsHi = Math.min(RAW_BOUNDS[1], bestS + 0.01);
  const phi = (Math.sqrt(5) - 1) / 2;
  let aGS = gsLo;
  let bGS = gsHi;
  let cGS = bGS - phi * (bGS - aGS);
  let dGS = aGS + phi * (bGS - aGS);
  let fc = negLogLik(cGS);
  let fd = negLogLik(dGS);
  for (let iter = 0; iter < 30; iter++) {
    if (Math.abs(bGS - aGS) < 1e-5) break;
    if (fc < fd) {
      bGS = dGS;
      dGS = cGS;
      fd = fc;
      cGS = bGS - phi * (bGS - aGS);
      fc = negLogLik(cGS);
    } else {
      aGS = cGS;
      cGS = dGS;
      fc = fd;
      dGS = aGS + phi * (bGS - aGS);
      fd = negLogLik(dGS);
    }
  }
  const refinedS = (aGS + bGS) / 2;
  if (negLogLik(refinedS) < bestNll) bestS = refinedS;

  const rawS = bestS;

  // 2단계: lamp feature 6개씩 (ec/hc/exh)
  const lampFeats = (data: { d: number; p: 0 | 1 }[]) => {
    let max_clear = 0,
      min_fail = 0,
      p50_clear = 0,
      frac_clear = 0,
      fail_below = 0,
      clear_above = 0;
    if (data.length === 0)
      return { max_clear, min_fail, p50_clear, frac_clear, fail_below, clear_above };
    const cleared = data.filter((x) => x.p === 1).map((x) => x.d);
    const failed = data.filter((x) => x.p === 0).map((x) => x.d);
    if (cleared.length > 0) {
      max_clear = Math.max(...cleared);
      p50_clear = p50(cleared);
    }
    if (failed.length > 0) min_fail = Math.min(...failed);
    frac_clear = cleared.length / data.length;
    let nBelow = 0,
      failBelow = 0,
      nAbove = 0,
      clearAbove = 0;
    for (const { d, p } of data) {
      if (d >= rawS - MARGIN_TH && d < rawS) {
        nBelow++;
        if (p === 0) failBelow++;
      }
      if (d > rawS && d <= rawS + MARGIN_TH) {
        nAbove++;
        if (p === 1) clearAbove++;
      }
    }
    if (nBelow > 0) fail_below = failBelow / nBelow;
    if (nAbove > 0) clear_above = clearAbove / nAbove;
    return { max_clear, min_fail, p50_clear, frac_clear, fail_below, clear_above };
  };
  const fEc = validStages.includes('ec')
    ? lampFeats(byLamp.ec)
    : { max_clear: 0, min_fail: 0, p50_clear: 0, frac_clear: 0, fail_below: 0, clear_above: 0 };
  const fHc = validStages.includes('hc')
    ? lampFeats(byLamp.hc)
    : { max_clear: 0, min_fail: 0, p50_clear: 0, frac_clear: 0, fail_below: 0, clear_above: 0 };
  const fExh = validStages.includes('exh')
    ? lampFeats(byLamp.exh)
    : { max_clear: 0, min_fail: 0, p50_clear: 0, frac_clear: 0, fail_below: 0, clear_above: 0 };

  // v3.1 AC/FC pool — ★11.6~12.7 + 시도(lamp>0) + exh ★ 있음
  const acfcPool: { lamp: number; d: number }[] = [];
  for (const c of poolCharts) {
    if (c.level == null || c.level < 11.6 || c.level > 12.7) continue;
    if (c.lampNum > 0 && typeof c.exh === 'number') acfcPool.push({ lamp: c.lampNum, d: c.exh });
  }
  let ac_frac = 0,
    ac_max_d = 0,
    ac_p50_d = 0;
  let fc_frac = 0,
    fc_max_d = 0,
    fc_p50_d = 0,
    fc_fail_near = 0,
    fc_to_exh_ratio = 0;
  if (acfcPool.length > 0) {
    const acClearedDs = acfcPool.filter((x) => x.lamp >= 2).map((x) => x.d);
    const fcClearedDs = acfcPool.filter((x) => x.lamp >= 7).map((x) => x.d);
    const exhClearedN = acfcPool.filter((x) => x.lamp >= 6).length;
    ac_frac = acClearedDs.length / acfcPool.length;
    ac_max_d = acClearedDs.length ? Math.max(...acClearedDs) : 0;
    ac_p50_d = p50(acClearedDs);
    fc_frac = fcClearedDs.length / acfcPool.length;
    fc_max_d = fcClearedDs.length ? Math.max(...fcClearedDs) : 0;
    fc_p50_d = p50(fcClearedDs);
    let nNear = 0,
      fcFailNear = 0;
    for (const x of acfcPool) {
      if (x.d >= rawS - MARGIN_TH && x.d <= rawS + MARGIN_TH) {
        nNear++;
        if (x.lamp < 7) fcFailNear++;
      }
    }
    fc_fail_near = nNear > 0 ? fcFailNear / nNear : 0;
    fc_to_exh_ratio = exhClearedN > 0 ? fcClearedDs.length / exhClearedN : 0;
  }

  // v3.2 — M / top10 / gap / interaction / prob
  const v32Cleared: { d: number; lamp: number; djLevel: string | null }[] = [];
  const v32FailedEc: number[] = [];
  for (const c of poolCharts) {
    if (c.level == null || c.level < 11.6 || c.level > 12.7) continue;
    if (c.lampNum >= 6 && typeof c.exh === 'number') {
      v32Cleared.push({ d: c.exh, lamp: c.lampNum, djLevel: c.djLevel });
    } else if (c.lampNum === 5 && typeof c.hc === 'number') {
      v32Cleared.push({ d: c.hc, lamp: c.lampNum, djLevel: c.djLevel });
    } else if (c.lampNum >= 3 && typeof c.ec === 'number') {
      v32Cleared.push({ d: c.ec, lamp: c.lampNum, djLevel: c.djLevel });
    } else if (c.lampNum === 1 && typeof c.ec === 'number') {
      v32FailedEc.push(c.ec);
    }
  }
  const nClearedV32 = v32Cleared.length;
  let v32_M = 0,
    v32_M_top10_avg = 0,
    v32_gap_top10 = 0;
  let v32_gap_x_is_ec = 0,
    v32_gap_x_is_hc = 0,
    v32_gap_x_is_exh = 0,
    v32_prob_sum = 0;
  let v32MLamp: number | null = null;
  let v32MDjLevel: string | null = null;
  if (nClearedV32 > 0) {
    v32Cleared.sort((a, b) => b.d - a.d);
    v32_M = v32Cleared[0].d;
    v32MLamp = v32Cleared[0].lamp;
    v32MDjLevel = v32Cleared[0].djLevel;
    const M_lamp = v32Cleared[0].lamp;
    const is_ec = M_lamp === 3 || M_lamp === 4 ? 1 : 0;
    const is_hc = M_lamp === 5 ? 1 : 0;
    const is_exh = M_lamp >= 6 ? 1 : 0;
    const padded: number[] = [];
    for (let k = 0; k < 10; k++) {
      padded.push(k < v32Cleared.length ? v32Cleared[k].d : v32Cleared[v32Cleared.length - 1].d);
    }
    v32_M_top10_avg = padded.reduce((s, x) => s + x, 0) / 10;
    v32_gap_top10 = v32_M - padded[9];
    v32_gap_x_is_ec = v32_gap_top10 * is_ec;
    v32_gap_x_is_hc = v32_gap_top10 * is_hc;
    v32_gap_x_is_exh = v32_gap_top10 * is_exh;
    const S_hat = v32_M_top10_avg;
    for (const d of v32FailedEc) {
      const prob = 1 / (1 + Math.exp(-(S_hat - d) / SIGMA_PROB));
      if (prob > PROB_NOISE_THRESHOLD) continue;
      v32_prob_sum += prob;
    }
  }

  const isUnderCutoff = nClearedV32 < CUTOFF_N_CLEARED;

  // 36-dim feature vector
  const features = [
    1.0,
    rawS,
    rawS * rawS,
    fEc.max_clear,
    fEc.min_fail,
    fEc.p50_clear,
    fEc.frac_clear,
    fEc.fail_below,
    fEc.clear_above,
    fHc.max_clear,
    fHc.min_fail,
    fHc.p50_clear,
    fHc.frac_clear,
    fHc.fail_below,
    fHc.clear_above,
    fExh.max_clear,
    fExh.min_fail,
    fExh.p50_clear,
    fExh.frac_clear,
    fExh.fail_below,
    fExh.clear_above,
    ac_frac,
    ac_max_d,
    ac_p50_d,
    fc_frac,
    fc_max_d,
    fc_p50_d,
    fc_fail_near,
    fc_to_exh_ratio,
    v32_M,
    v32_M_top10_avg,
    v32_gap_top10,
    v32_gap_x_is_ec,
    v32_gap_x_is_hc,
    v32_gap_x_is_exh,
    v32_prob_sum,
  ];

  // 3단계: ridge correction (일단 계산만 — v3.2.10 muting 조건부 적용)
  let correction = 0;
  for (let i = 0; i < RIDGE_COEF.length; i++) correction += RIDGE_COEF[i] * features[i];

  // 4단계 (v3.2.7): bin clear-rate 누적 post-correction
  let binImplied: { stage: 'ec' | 'hc' | 'exh'; implied: number; bonus: number } | null = null;
  for (const stage of ['ec', 'hc', 'exh'] as const) {
    const bins = new Map<string, { start: number; total: number; cleared: number }>();
    for (const { d, p, stage: st } of fitData) {
      if (st !== stage) continue;
      const start = Math.round(Math.floor(d / BIN_W_V324) * BIN_W_V324 * 10) / 10;
      const key = start.toFixed(1);
      let b = bins.get(key);
      if (!b) {
        b = { start, total: 0, cleared: 0 };
        bins.set(key, b);
      }
      b.total++;
      if (p === 1) b.cleared++;
    }
    const minSamples = STAGE_MIN_V324[stage];
    type Eligible = { start: number; total: number; cleared: number; rate: number; rateW: number };
    const eligible: Eligible[] = [];
    for (const b of bins.values()) {
      if (b.total < minSamples) continue;
      const rate = b.cleared / b.total;
      if (rate < RATE_LO_V327) continue;
      const rateW = (rate - RATE_LO_V327) / (1.0 - RATE_LO_V327);
      if (rateW <= 0) continue;
      eligible.push({ start: b.start, total: b.total, cleared: b.cleared, rate, rateW });
    }
    if (eligible.length === 0) continue;
    eligible.sort((a, b) => b.start - a.start);
    const used = eligible.slice(0, NEXT_BIN_W_V324.length);
    let bonus = 0;
    for (let i = 0; i < used.length; i++) {
      bonus += STAGE_BONUS_V324[stage] * NEXT_BIN_W_V324[i] * used[i].rateW;
    }
    const stageImplied = used[0].start + bonus;
    if (!binImplied || stageImplied > binImplied.implied) {
      binImplied = { stage, implied: stageImplied, bonus };
    }
  }

  // v3.2.10: bin 보너스 활성 + ridge 음수 → ridge muting
  const predRidgeApplied = rawS + correction;
  const binActive = binImplied != null && binImplied.implied > predRidgeApplied;
  const ridgeMuted = binActive && correction < 0;
  if (ridgeMuted) correction = 0;

  let starEstimate = rawS + correction;

  let postCorrection = 0;
  if (binImplied) {
    const diff = binImplied.implied - starEstimate;
    if (diff > 0) postCorrection = diff * POSTCOR_WEIGHT_V324;
  }
  starEstimate += postCorrection;

  // 5단계 (v3.2.6): djLevel boost
  let djBoost = 0;
  let djBoostInfo: { djLevel: string; gap: number; curveW: number } | null = null;
  if (
    nClearedV32 > 0 &&
    rawS >= V326_MIN_RAW_S &&
    v32MLamp != null &&
    (v32MLamp === 3 || v32MLamp === 4) &&
    v32MDjLevel != null
  ) {
    const djOrd = DJ_ORD[v32MDjLevel];
    if (djOrd != null && djOrd >= V326_MIN_DJ_ORD) {
      const diff = v32_M - starEstimate;
      if (diff > 0) {
        const gap = Math.max(0, v32_M - rawS);
        const curveW = Math.max(0, Math.min(1, (gap - V326_GAP_LO) / (V326_GAP_HI - V326_GAP_LO)));
        djBoost = diff * V326_WEIGHT * curveW;
        djBoostInfo = { djLevel: v32MDjLevel, gap, curveW };
      }
    }
  }
  starEstimate += djBoost;

  starEstimate = Math.max(0.0, Math.min(15.0, starEstimate));

  // v3.3.2: EC-only 사용자 (HC/EXH 클리어 < 10) 에 raw + max_clear 기반 선형 보정.
  // 16명 EC-only 샘플 fit: true ≈ -0.158 + 0.761·raw_s + 0.250·fEc.max_clear (MAE 41% 감소).
  // 정상 starEstimate 와 보정값 중 더 큰 쪽 채택 — collapse 방지 + 시스템 underestimate 보상.
  let ecOnlyApplied = false;
  if (isEcOnlyValid) {
    const ecCorrected =
      EC_ONLY_INTERCEPT + EC_ONLY_RAW_COEF * rawS + EC_ONLY_MAXCLEAR_COEF * fEc.max_clear;
    const adjusted = Math.max(starEstimate, ecCorrected);
    const clamped = Math.max(0.01, Math.min(15.0, adjusted));
    if (Math.abs(clamped - starEstimate) > 0.005) ecOnlyApplied = true;
    starEstimate = clamped;
  }

  return {
    star: starEstimate,
    raw: rawS,
    validStages: [...validStages],
    fitDataCount: fitData.length,
    nClearedV32,
    isUnderCutoff,
    ridgeCorrection: correction,
    ridgeMuted,
    postCorrection,
    djBoost,
    djBoostInfo,
    binImplied: binImplied
      ? { stage: binImplied.stage, implied: binImplied.implied, bonus: binImplied.bonus }
      : null,
    isEcOnlyValid,
    ecOnlyApplied,
  };
}
