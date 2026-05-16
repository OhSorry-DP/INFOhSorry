// 오소리레이팅 inference 라이브러리 v0.0.2 — 사용자 plays + ratingData → 사용자 ★ 추정
//
// 사용 예시 (브라우저):
//   const rating = await fetch('https://gist.../ohSorryRating.json').then(r => r.json());
//   const lib = await fetch('https://gist.../ohsorry-rating-infer.js').then(r => r.text());
//   eval(lib);  // window.ohSorryRating 등록
//   const r = ohSorryRating.inferUser(myCharts, rating);
//   console.log(r.nativeStar, r.ereterCompatStar);
//
// 사용 예시 (Node.js):
//   const lib = require('./ohsorry-rating-infer');
//   const rating = require('./ohSorryRating.json');
//   const r = lib.inferUser(myCharts, rating);
//
// charts 형식: [{ title, diff, lampNum }]
//   - title: 곡 제목 (ereter / zasa 와 동일 표기, decode 후 norm 으로 매칭)
//   - diff: 'HYPER' | 'ANOTHER' | 'LEGGENDARIA'
//   - lampNum: 0(NO PLAY) / 1(FAILED) / 2(ASSIST) / 3(EASY) / 4(CLEAR) / 5(HARD) / 6(EX-HARD) / 7(FULL COMBO)
//
// 반환값:
//   {
//     nativeStar:        zasa-anchored 우리 모델 native ★ (HC top-5 of nativeBetaHc, ~10~15),
//     ereterCompatStar:  ereter user★ scale 매핑 (~0~14.5),
//     nHcCleared:        HC 이상 클리어 곡 수,
//     nEnriched:         학습 대상 (zasa 11.6~12.7) 차트 매칭 수,
//     reason?:           추정 불가 사유 ('few_plays' 등)
//   }
// @ts-nocheck — UMD lib 을 INFOhSorry 에 bundle 한 모듈. 타입 검증 비활성 (외부 lib 동기화 편의).
const __osrModule = (function () {
  'use strict';

  const ALPHA_COEFF = {
    ec: [194.445153, 41.489739, 6.085698],
    hc: [119.451394, 295.165202, -20.796304],
    exh: [2.722775, 0.444754, 3.689284],
  };
  const MARGIN_TH = 1.3;
  const MIN_CLEAR_PER_LAMP = 10;
  const RAW_BOUNDS = [0.01, 14.5];

  function alphaOf(S, st) {
    const [a0, a1, a2] = ALPHA_COEFF[st];
    return Math.max(a2 * S * S + a1 * S + a0, 0.1);
  }
  function norm(s) {
    return (s || '').toLowerCase()
      .replace(/[\s　]+/g, '')
      .replace(/[~∼〜～]/g, '~')
      .replace(/[!！]/g, '!')
      .replace(/[?？]/g, '?')
      .replace(/[(（]/g, '(')
      .replace(/[)）]/g, ')')
      .normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFKC');
  }
  function decode(s) {
    if (!s) return s;
    const m = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&apos;': "'", '&nbsp;': ' ' };
    return s.replace(/&(amp|lt|gt|quot|#039|apos|nbsp);/g, (x) => m[x] || x)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  }
  function p50(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
  }

  function inferUser(charts, ratingData, options) {
    if (!ratingData || !Array.isArray(ratingData.ratings) || !ratingData.userStarRidge) {
      return { reason: 'invalid_rating_data' };
    }
    const opts = options || {};
    const zasaMin = typeof opts.zasaMin === 'number' ? opts.zasaMin : 11.6;
    const zasaMax = typeof opts.zasaMax === 'number' ? opts.zasaMax : 12.7;
    const gameLevelFilter = opts.gameLevel; // 12 또는 undefined
    // lv11Weight (0~1, default 0) — Group C 에서 lv11 HC/EXH 부분 가중치.
    //   gameLevelFilter=12 일 때 lv11 도 통과 (단 fitData 의 lv11 EC stage 는 스킵).
    //   NLL 계산 시 weight 만큼 영향.
    const lv11Weight = (typeof opts.lv11Weight === 'number') ? Math.max(0, Math.min(1, opts.lv11Weight)) : 0;
    const includeLv11 = lv11Weight > 0;
    const lookup = new Map();
    for (const r of ratingData.ratings) lookup.set(norm(r.title) + '|' + r.diff, r);

    // 매칭 + enriched + HC top-5 (native)
    const hcClearedNative = [];
    const enriched = [];
    for (const c of charts) {
      if (!c.title || !c.diff) continue;
      const k = norm(decode(c.title)) + '|' + c.diff;
      const r = lookup.get(k);
      if (!r) continue;
      // HC 이상 클리어 (native ★ 용)
      if (c.lampNum >= 5 && typeof r.nativeBetaHc === 'number') {
        hcClearedNative.push(r.nativeBetaHc);
      }
      // ereter-compat 용 (zasa cutoff 옵션화 — default 11.6~12.7)
      if (r.zasaLevel < zasaMin || r.zasaLevel > zasaMax) continue;
      if (gameLevelFilter && r.gameLevel !== gameLevelFilter) {
        if (!(includeLv11 && r.gameLevel === 11)) continue;
      }
      enriched.push({
        lamp: c.lampNum,
        ec: r.estEc, hc: r.estHc, exh: r.estExh,
        gameLevel: r.gameLevel,
      });
    }

    let nativeStar = null;
    if (hcClearedNative.length > 0) {
      const sorted = [...hcClearedNative].sort((a, b) => b - a);
      const top = sorted.slice(0, Math.min(5, sorted.length));
      nativeStar = top.reduce((a, b) => a + b, 0) / top.length;
    }

    // ereter-compat ★ — 36-dim ridge
    let ereterCompatStar = null;
    let reason;
    const fitData = [];
    for (const c of enriched) {
      if (c.lamp == null || c.lamp <= 0) continue;
      // weight: lv12 → 1, lv11 → lv11Weight (HC/EXH 만, EC 는 trivial 스킵)
      const isLv11 = c.gameLevel === 11;
      const w = isLv11 ? lv11Weight : 1;
      if (!isLv11 && typeof c.ec === 'number') fitData.push({ d: c.ec, p: c.lamp >= 3 ? 1 : 0, stage: 'ec', w });
      if (typeof c.hc === 'number') fitData.push({ d: c.hc, p: c.lamp >= 5 ? 1 : 0, stage: 'hc', w });
      if (typeof c.exh === 'number') fitData.push({ d: c.exh, p: c.lamp >= 6 ? 1 : 0, stage: 'exh', w });
    }
    if (fitData.length < 30) {
      reason = 'few_plays';
    } else {
      const byLamp = { ec: [], hc: [], exh: [] };
      for (const { d, p, stage, w } of fitData) byLamp[stage].push({ d, p, w: typeof w === 'number' ? w : 1 });
      // 클리어 카운트 — weighted sum (lv11 entries 가중치 lv11Weight 만큼 기여)
      const cc = {
        ec: byLamp.ec.filter((x) => x.p === 1).reduce((s, x) => s + x.w, 0),
        hc: byLamp.hc.filter((x) => x.p === 1).reduce((s, x) => s + x.w, 0),
        exh: byLamp.exh.filter((x) => x.p === 1).reduce((s, x) => s + x.w, 0),
      };
      const validStages = ['ec', 'hc', 'exh'].filter((st) => cc[st] >= MIN_CLEAR_PER_LAMP);
      if (validStages.length === 0) {
        reason = 'no_valid_stage';
      } else {
        const Z = 50;
        const nll = (S) => {
          let t = 0;
          for (const st of validStages) {
            const a = alphaOf(S, st);
            for (const { d, p, w } of byLamp[st]) {
              let z = a * (d - S); if (z > Z) z = Z; else if (z < -Z) z = -Z;
              const sp = Math.max(z, 0) + Math.log(1 + Math.exp(-Math.abs(z)));
              t -= w * (p === 1 ? -sp : (z - sp));
            }
          }
          return t;
        };
        const lo = Math.round(RAW_BOUNDS[0] * 100), hi = Math.round(RAW_BOUNDS[1] * 100);
        let bestS = RAW_BOUNDS[0], bestNll = Infinity;
        for (let i = lo; i <= hi; i++) {
          const S = i / 100;
          const n2 = nll(S);
          if (n2 < bestNll) { bestNll = n2; bestS = S; }
        }
        const lf = (ld) => {
          let mc = 0, mf = 0, p50v = 0, fc = 0, fb = 0, ca = 0;
          if (ld.length === 0) return [mc, mf, p50v, fc, fb, ca];
          const cl = ld.filter((x) => x.p === 1).map((x) => x.d);
          const fl = ld.filter((x) => x.p === 0).map((x) => x.d);
          if (cl.length > 0) { mc = Math.max.apply(null, cl); p50v = p50(cl); }
          if (fl.length > 0) mf = Math.min.apply(null, fl);
          fc = cl.length / ld.length;
          let nB = 0, fB = 0, nA = 0, cA = 0;
          for (const { d, p } of ld) {
            if (d >= bestS - MARGIN_TH && d < bestS) { nB++; if (p === 0) fB++; }
            if (d > bestS && d <= bestS + MARGIN_TH) { nA++; if (p === 1) cA++; }
          }
          if (nB > 0) fb = fB / nB;
          if (nA > 0) ca = cA / nA;
          return [mc, mf, p50v, fc, fb, ca];
        };
        const fEc = validStages.indexOf('ec') >= 0 ? lf(byLamp.ec) : [0, 0, 0, 0, 0, 0];
        const fHc = validStages.indexOf('hc') >= 0 ? lf(byLamp.hc) : [0, 0, 0, 0, 0, 0];
        const fExh = validStages.indexOf('exh') >= 0 ? lf(byLamp.exh) : [0, 0, 0, 0, 0, 0];
        const acPool = enriched.filter((c) => c.lamp > 0 && typeof c.exh === 'number').map((c) => ({ lamp: c.lamp, d: c.exh }));
        let ac_frac = 0, ac_max_d = 0, ac_p50_d = 0, fc_frac = 0, fc_max_d = 0, fc_p50_d = 0, fc_fail_near = 0, fc_to_exh_ratio = 0;
        if (acPool.length > 0) {
          const ad = acPool.filter((x) => x.lamp >= 2).map((x) => x.d);
          const fd = acPool.filter((x) => x.lamp >= 7).map((x) => x.d);
          const exhCl = acPool.filter((x) => x.lamp >= 6).length;
          ac_frac = ad.length / acPool.length;
          ac_max_d = ad.length ? Math.max.apply(null, ad) : 0;
          ac_p50_d = p50(ad);
          fc_frac = fd.length / acPool.length;
          fc_max_d = fd.length ? Math.max.apply(null, fd) : 0;
          fc_p50_d = p50(fd);
          let nN = 0, fcN = 0;
          for (const x of acPool) if (x.d >= bestS - MARGIN_TH && x.d <= bestS + MARGIN_TH) { nN++; if (x.lamp < 7) fcN++; }
          fc_fail_near = nN > 0 ? fcN / nN : 0;
          fc_to_exh_ratio = exhCl > 0 ? fd.length / exhCl : 0;
        }
        const v32 = []; const v32Fec = [];
        for (const c of enriched) {
          if (c.lamp == null) continue;
          if (c.lamp >= 6 && typeof c.exh === 'number') v32.push({ d: c.exh, lamp: c.lamp });
          else if (c.lamp === 5 && typeof c.hc === 'number') v32.push({ d: c.hc, lamp: c.lamp });
          else if (c.lamp >= 3 && typeof c.ec === 'number') v32.push({ d: c.ec, lamp: c.lamp });
          else if (c.lamp === 1 && typeof c.ec === 'number') v32Fec.push(c.ec);
        }
        let M = 0, top10 = 0, gap = 0, gec = 0, ghc = 0, gexh = 0, pSum = 0;
        if (v32.length > 0) {
          v32.sort((a, b) => b.d - a.d);
          M = v32[0].d;
          const lm = v32[0].lamp;
          const padded = [];
          for (let k = 0; k < 10; k++) padded.push(k < v32.length ? v32[k].d : v32[v32.length - 1].d);
          top10 = padded.reduce((a, b) => a + b, 0) / 10;
          gap = M - padded[9];
          gec = gap * ((lm === 3 || lm === 4) ? 1 : 0);
          ghc = gap * (lm === 5 ? 1 : 0);
          gexh = gap * (lm >= 6 ? 1 : 0);
          for (const d of v32Fec) {
            const p = 1 / (1 + Math.exp(-(top10 - d)));
            if (p <= 0.99) pSum += p;
          }
        }
        const features = [
          1.0, bestS, bestS * bestS,
          fEc[0], fEc[1], fEc[2], fEc[3], fEc[4], fEc[5],
          fHc[0], fHc[1], fHc[2], fHc[3], fHc[4], fHc[5],
          fExh[0], fExh[1], fExh[2], fExh[3], fExh[4], fExh[5],
          ac_frac, ac_max_d, ac_p50_d, fc_frac, fc_max_d, fc_p50_d, fc_fail_near, fc_to_exh_ratio,
          M, top10, gap, gec, ghc, gexh, pSum,
        ];
        const coef = ratingData.userStarRidge.coefficients;
        let result = 0;
        for (let i = 0; i < features.length; i++) result += coef[i] * features[i];
        ereterCompatStar = Math.max(0, Math.min(15, result));
      }
    }

    const out = {
      nativeStar: nativeStar != null ? Math.round(nativeStar * 100) / 100 : null,
      ereterCompatStar: ereterCompatStar != null ? Math.round(ereterCompatStar * 100) / 100 : null,
      nHcCleared: hcClearedNative.length,
      nEnriched: enriched.length,
    };
    if (reason) out.reason = reason;
    return out;
  }

  // ============================================================
  // tiered inference — 사용자 클리어 수에 따라 다른 scope + band correction 적용
  //   A (lv12 클리어 < 30): zasaMin=10.2 (전체 zasa)
  //   B (12.0+ 클리어 < 30): zasaMin=11.6 (default) + B 보정
  //   C (12.0+ 클리어 ≥ 30): gameLevel=12 (lv12 only) + B 보정
  //
  // 897명 in-sample 측정 (2026-05-12) — predicted band 기반 보정.
  //   default scope MAE 0.376 → tiered MAE 0.325 (-13.5%)
  // ============================================================
  const BAND_CORR_DEFAULT = {
    "1.0": -0.78, "1.5": -0.546, "2.0": -0.353, "2.5": -0.338, "3.0": -0.137, "3.5": 0.157,
    "4.0": -0.077, "4.5": 0.069, "5.0": 0.223, "5.5": 0.253, "6.0": 0.06, "6.5": 0.001,
    "7.0": -0.007, "7.5": -0.011, "8.0": -0.014, "8.5": -0.071, "9.0": 0.016, "9.5": 0.044,
    "10.0": -0.105, "10.5": -0.043, "11.0": -0.073, "11.5": -0.058, "12.0": 0.107, "12.5": 0.116,
    "13.0": 0.297, "13.5": 0.089, "14.0": -0.021, "14.5": 0.105,
  };
  const BAND_CORR_LV12 = {
    "1.0": -0.218, "1.5": -0.23, "2.0": -0.207, "2.5": -0.078, "3.0": 0.161, "3.5": 0.127,
    "4.0": -0.138, "4.5": 0.021, "5.0": 0.051, "5.5": 0.035, "6.0": -0.175, "6.5": -0.294,
    "7.0": -0.196, "7.5": -0.248, "8.0": -0.25, "8.5": -0.366, "9.0": -0.308, "9.5": -0.308,
    "10.0": -0.474, "10.5": -0.492, "11.0": -0.509, "11.5": -0.405, "12.0": -0.263, "12.5": -0.251,
    "13.0": -0.01, "13.5": -0.18, "14.0": -0.191, "14.5": -0.295,
  };
  // Group A 전용 — 876명 in-sample (2026-05-16), A scope (zasaMin=10.2) raw 의 over-estimate 끌어내림.
  // A → B 전환 점프 완화 효과 (B 의 BAND_CORR_DEFAULT 와 분포 align).
  const BAND_CORR_A = {
    "1.0": 0.470, "1.5": 0.439, "2.0": -0.035, "2.5": -0.137,
    "3.0": -0.925, "3.5": -0.899, "4.0": -0.865, "4.5": -0.793,
    "5.0": -0.595, "5.5": -0.517, "6.0": -0.843, "6.5": -0.953,
    "7.0": -1.040, "7.5": -0.816, "8.0": -0.740, "8.5": -0.498,
    "9.0": -0.419, "9.5": -0.278, "10.0": -0.287, "10.5": -0.367,
    "11.0": -0.327, "11.5": -0.325, "12.0": -0.313, "12.5": -0.265,
    "13.0": -0.181, "13.5": -0.226, "14.0": -0.311, "14.5": -0.300,
  };
  function bandCorr(table, predStar) {
    const b = Math.floor(predStar * 2) / 2;
    const key = b.toFixed(1);
    if (table[key] != null) return table[key];
    if (predStar < 1.0) return table["1.0"] || 0;
    if (predStar > 14.5) return table["14.5"] || 0;
    return 0;
  }

  function inferUserTiered(charts, ratingData) {
    if (!ratingData || !Array.isArray(ratingData.ratings) || !ratingData.userStarRidge) {
      return { reason: 'invalid_rating_data' };
    }
    const lookup = new Map();
    for (const r of ratingData.ratings) lookup.set(norm(r.title) + '|' + r.diff, r);
    let nLv12Cleared = 0, nZ12_0upCleared = 0;
    for (const c of charts) {
      if (!c.title || !c.diff || (c.lampNum || 0) < 3) continue;
      const r = lookup.get(norm(decode(c.title)) + '|' + c.diff);
      if (!r) continue;
      if (r.gameLevel === 12) {
        nLv12Cleared++;
        if (r.zasaLevel >= 12.0) nZ12_0upCleared++;
      }
    }
    let group, scopeOpts, corrTable;
    if (nLv12Cleared < 30) {
      group = 'A';
      scopeOpts = { zasaMin: 10.2 };
      corrTable = BAND_CORR_A;  // A 전용 보정 (★3~8 over-estimate 끌어내림, A→B 점프 완화)
    } else if (nZ12_0upCleared < 30) {
      group = 'B';
      scopeOpts = {};  // default zasaMin=11.6
      corrTable = BAND_CORR_DEFAULT;
    } else {
      group = 'C';
      scopeOpts = { gameLevel: 12, lv11Weight: 0.1 };
      corrTable = BAND_CORR_LV12;
    }
    const r = inferUser(charts, ratingData, scopeOpts);
    if (typeof r.ereterCompatStar !== 'number') {
      return Object.assign({}, r, { group: group, nLv12Cleared: nLv12Cleared, nZ12_0upCleared: nZ12_0upCleared });
    }
    const correction = corrTable ? bandCorr(corrTable, r.ereterCompatStar) : 0;
    const tieredStar = Math.max(0, Math.min(15, r.ereterCompatStar + correction));
    return Object.assign({}, r, {
      ereterCompatStar: Math.round(tieredStar * 100) / 100,
      ereterCompatStarRaw: r.ereterCompatStar,
      group: group,
      nLv12Cleared: nLv12Cleared,
      nZ12_0upCleared: nZ12_0upCleared,
      bandCorrection: Math.round(correction * 1000) / 1000,
    });
  }

  return {
    version: '0.0.6',
    inferUser,
    inferUserTiered,
  };
})();

export const { inferUser, inferUserTiered, version } = __osrModule;
export default __osrModule;
