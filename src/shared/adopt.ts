// adopt.ts — v335E 채택 분기 통합 lib v0.0.1 (TS bundle)
//
// 세 inference lib (oldOSR / OSR / OSR135) 의 raw 값과 group 정보를 받아 최종 ★ 1개를 결정.
// dist/adopt.js (gist UMD) 와 동일 알고리즘. INF오소리는 bundle 우선 사용 + cache (gist) 가 더 최신이면 override.
// ohSorry/recompute/INF오소리 3곳 drift 방지 — 단일 lib 호출로 통일.
// @ts-nocheck — UMD lib 을 bundle 한 모듈. 타입 검증 비활성 (외부 lib 동기화 편의).
const __adoptModule = (function () {
  'use strict';

  const OSR135_TH = 13.5;
  const BLEND_W = 1.0;
  const GAP_GUARD = 3.0;
  const SPREAD_MAX = 2.5;
  const OSR135_UNDER_TH = 13.0;
  const OSR135_UNDER_GAP = 0.35;
  const C_TH = 11.0;
  const C_W = 0.5;

  function isNum(v) { return typeof v === 'number' && !isNaN(v); }

  function adoptStar(input) {
    const starOldRaw = isNum(input && input.starOld) ? input.starOld : null;
    const starNew = isNum(input && input.starNew) ? input.starNew : null;
    const star135 = isNum(input && input.star135) ? input.star135 : null;
    const starEreterOnly = isNum(input && input.starEreterOnly) ? input.starEreterOnly : null;
    const starLv12Only = isNum(input && input.starLv12Only) ? input.starLv12Only : null;
    const osr135Stages = input && input.osr135Stages || null;
    const group = (input && input.group) || null;
    const isAB = group === 'A' || group === 'B';

    let starOld = starOldRaw;
    if (group === 'C' && (starEreterOnly != null || starLv12Only != null)) {
      const cands = [starEreterOnly, starLv12Only].filter(isNum);
      if (cands.length > 0) starOld = Math.max.apply(null, cands);
    }

    let baseStar2 = null;
    let groupLib = null;
    if (isAB) {
      if (isNum(starNew)) { baseStar2 = starNew; groupLib = 'OSR'; }
      else if (isNum(starOld)) { baseStar2 = starOld; groupLib = 'oldOSR(fb)'; }
    } else {
      if (isNum(starNew) && starNew >= C_TH) {
        baseStar2 = starNew; groupLib = 'OSR(C)';
      } else if (isNum(starNew) && starNew >= C_TH - C_W && isNum(starOld)) {
        const ct = (starNew - (C_TH - C_W)) / C_W;
        baseStar2 = starOld * (1 - ct) + starNew * ct;
        groupLib = 'OSR↔oldOSR(C)';
      } else if (isNum(starOld)) {
        baseStar2 = starOld; groupLib = 'oldOSR(C)';
      } else if (isNum(starNew)) {
        baseStar2 = starNew; groupLib = 'OSR(C,fb)';
      }
    }

    let osr135Trusted = true;
    if (osr135Stages) {
      const stagesArr = [osr135Stages.ec, osr135Stages.hc, osr135Stages.exh]
        .filter(function (v) { return isNum(v) && v > 0.01; });
      if (stagesArr.length >= 2 && (Math.max.apply(null, stagesArr) - Math.min.apply(null, stagesArr)) > SPREAD_MAX) {
        osr135Trusted = false;
      }
    }

    let star = null;
    let adoptedLib = null;
    if (!isNum(star135)) {
      if (isNum(baseStar2)) { star = baseStar2; adoptedLib = groupLib; }
    } else if (!osr135Trusted) {
      if (isNum(baseStar2)) { star = baseStar2; adoptedLib = groupLib; }
      else { star = star135; adoptedLib = 'OSR13.5+(fb)'; }
    } else if (star135 >= OSR135_TH) {
      star = star135; adoptedLib = 'OSR135';
    } else if (star135 < OSR135_TH - BLEND_W || !isNum(baseStar2)) {
      if (isNum(baseStar2)) { star = baseStar2; adoptedLib = groupLib; }
      else { star = star135; adoptedLib = 'OSR13.5+(fb)'; }
    } else if (isNum(starNew) && starNew > star135) {
      const lowBase = Math.min(starNew, isNum(starOld) ? starOld : starNew);
      if (
        star135 >= OSR135_UNDER_TH &&
        (starNew - star135) >= OSR135_UNDER_GAP &&
        lowBase > star135
      ) {
        star = star135 * 0.35 + lowBase * 0.65;
        adoptedLib = 'under-blend';
      } else {
        star = star135;
        adoptedLib = 'OSR135';
      }
    } else {
      const t = (star135 - (OSR135_TH - BLEND_W)) / BLEND_W;
      const diffBlend = baseStar2 * (1 - t) + star135 * t;
      if (!isNum(starNew)) {
        star = diffBlend; adoptedLib = 'diffBlend';
      } else {
        const gapW = Math.max(0, Math.min((star135 - starNew) / GAP_GUARD, 1));
        star = diffBlend * (1 - gapW) + star135 * gapW;
        adoptedLib = 'blend';
      }
    }

    return {
      star: star,
      adoptedLib: adoptedLib,
      baseStar2: baseStar2,
      groupLib: groupLib,
      osr135Trusted: osr135Trusted,
      oldStarUsed: starOld,
      version: '0.0.1',
    };
  }

  return {
    adoptStar: adoptStar,
    version: '0.0.1',
  };
})();

export type AdoptInput = {
  starOld: number | null;
  starNew: number | null;
  star135: number | null;
  starEreterOnly: number | null;
  starLv12Only: number | null;
  osr135Stages: { ec: number; hc: number; exh: number } | null;
  group: 'A' | 'B' | 'C' | null;
};

export type AdoptOutput = {
  star: number | null;
  adoptedLib: string | null;
  baseStar2: number | null;
  groupLib: string | null;
  osr135Trusted: boolean;
  oldStarUsed: number | null;
  version: string;
};

export const { adoptStar, version } = __adoptModule as { adoptStar: (input: AdoptInput) => AdoptOutput; version: string };
export default __adoptModule as { adoptStar: (input: AdoptInput) => AdoptOutput; version: string };
