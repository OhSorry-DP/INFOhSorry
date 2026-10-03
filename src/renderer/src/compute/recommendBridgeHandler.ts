import { computeTargetFolders, type UserDpChart } from '../emodeTargets';

type Any = any;
export interface RecRequest {
  reqId: string;
  kind: 'meta' | 'clear' | 'practice' | 'ladder' | 'targets';
  params?: Record<string, unknown>;
}
export interface RecommendRequestDeps {
  recCtx: Any;
  ratingData: Any;
  userRStar: number | null;
  baseStar: number | null;
  userCharts: UserDpChart[];
  normFn: (s: string) => string;
  coreVersion: string | null;
}

// 코어 rec row → 챗봇용 슬림 형태. 내부 점수/디버그 필드는 버린다.
function slimRow(r: Any): Record<string, unknown> {
  if (!r || typeof r !== 'object') return {};
  const out: Record<string, unknown> = {
    title: r.title,
    diff: r.chart,
    star: r.level,
    ec: r.ec ?? null,
    hc: r.hc ?? null,
    exh: r.exh ?? null,
  };
  if (typeof r.diffValue === 'number' && !r._hideDiffValue) out.targetStar = r.diffValue;
  if (r.currentLamp) out.lamp = r.currentLamp;
  if (typeof r.lampNum === 'number') out.lampNum = r.lampNum;
  if (r.djLevel) out.djLevel = r.djLevel;
  if (typeof r.exScore === 'number') out.exScore = r.exScore;
  if (typeof r.scoreRate === 'number' && r.scoreRate != null) out.scoreRate = r.scoreRate;
  // 곡 밀도 — 초당 노트 수(스크래치 제외). 평균 / 2초 창 피크. slim 차트에 없을 수 있다.
  if (r._nps && typeof r._nps.a === 'number') out.nps = r._nps.a;
  if (r._nps && typeof r._nps.p === 'number') out.peakNps = r._nps.p;
  if (typeof r.margin === 'number') out.margin = r.margin;
  if (typeof r.gameLevel === 'number') out.gameLevel = r.gameLevel;
  if (r._category) out.category = r._category;
  if (r._clearType) out.clearType = r._clearType;
  if (r._practiceType) out.practiceType = r._practiceType;
  if (Array.isArray(r._hashtags) && r._hashtags.length) out.hashtags = r._hashtags;
  if (Array.isArray(r._tags) && r._tags.length) out.featureTags = r._tags;
  if (typeof r._targetRate === 'number') out.targetRate = r._targetRate;
  if (r._targetDjLevel) out.targetDjLevel = r._targetDjLevel;
  if (typeof r._targetExScore === 'number') out.targetExScore = r._targetExScore;
  if (typeof r._currentExScore === 'number') out.currentExScore = r._currentExScore;
  if (r._matchByHand && r._matchByHand.bestLabel) out.layout = r._matchByHand.bestLabel;
  return out;
}

function toNum(v: unknown, dflt: number | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

// 추천곡 v3/v4 재설계 Phase 1 — 엔진 _growthExplain → 브릿지 payload. 코치 API growthExplainOf 와 동형.
//   전부 buildGrowthLandscape 가 반환한 factual 값 — 여기서 파생/추측하지 않는다.
function growthSlim(ge: Any, axis: string): Record<string, unknown> | null {
  if (!ge) return null;
  const g = ge.growth || {}, res = ge.residual || {}, phy = ge.physical || {}, cl = ge.cluster || {}, val = ge.validation || {};
  return {
    mode: ge.mode || axis,
    currentStage: g.currentStage ?? null,
    expectedStage: res.expectedStage ?? null,
    targetStage: g.targetStage ?? null,          // 밴드 배치 stage
    nextStage: g.nextStage ?? null,              // 현재 성취 바로 위 (terminal 이면 null)
    nextStageAxisVal: g.nextStageAxisVal ?? null,
    growthReason: g.growthReason ?? null,        // FRESH_TARGET | STAGE_UP | SCORE_REFINE | PRIMARY_TERMINAL
    primaryTerminal: !!g.primaryTerminal,
    targetGradeFolder: g.targetGradeFolder ?? null,
    nextGradeFolder: g.nextGradeFolder ?? null,
    discreteResidual: res.discrete ?? null,
    discreteStratum: res.discreteStratum ?? null,
    rawMargin: res.rawMargin ?? null,
    effectiveMargin: res.effectiveMargin ?? null,
    physical: { hardGate: phy.hardGate ?? null, confidencePenalty: phy.confidencePenalty ?? null },
    cluster: {
      type: cl.type ?? null, detector: cl.detector ?? null, range: cl.range ?? null, center: cl.center ?? null,
      confidence: cl.confidence ?? null, evidence: cl.evidenceNote ?? null, marginBand: cl.marginBand ?? null,
      boundaryReliability: cl.boundaryReliability ?? null,
    },
    validated: cl.type === 'solid' ? !!val.solidValidated : false,
    fallbackReason: val.fallbackReason ?? (ge.fallback && ge.fallback.reason) ?? null,
  };
}

export function handleRecommendRequest(req: RecRequest, deps: RecommendRequestDeps): Record<string, unknown> {
  const { recCtx, ratingData, userRStar, baseStar, userCharts } = deps;
  const p = req.params || {};

  if (req.kind === 'meta') {
    return {
      ready: !!recCtx,
      coreVersion: deps.coreVersion || null,
      baseStar,
      userRStar,
      practiceParents: recCtx?.practiceParents || null,
      practiceSubfeats: recCtx?.practiceSubfeats || null,
      practiceSubfeatsHidden: recCtx?.practiceSubfeatsHidden || null,
      practiceZasaDefault: recCtx?.practiceZasaDefault || null,
      targetsAvailable: userRStar != null && !!ratingData?.rateStar?.scale,
    };
  }

  if (req.kind === 'targets') {
    const folders = computeTargetFolders(ratingData, userRStar, userCharts, deps.normFn);
    const limit = toNum(p.limit, 15) || 15;
    const grade = typeof p.grade === 'string' ? p.grade.toLowerCase() : null;
    const clip = (rows: Any[]): Any[] => rows.slice(0, limit);
    if (grade && ['a', 'aa', 'aaa', 'maxm'].includes(grade)) {
      return { available: folders.available, userRStar: folders.userRStar, grade, rows: clip((folders as Any)[grade]) };
    }
    return {
      available: folders.available,
      userRStar: folders.userRStar,
      a: clip(folders.a), aa: clip(folders.aa), aaa: clip(folders.aaa), maxm: clip(folders.maxm),
      counts: { a: folders.a.length, aa: folders.aa.length, aaa: folders.aaa.length, maxm: folders.maxm.length },
    };
  }

  // 아래 kind 는 모두 recCtx 필수.
  if (!recCtx) throw new Error('recCtx not ready (INF 창이 열려있고 추천 lib 로딩이 끝나야 함)');
  const fnFor: Record<string, string> = { clear: 'buildRecs', practice: 'buildWeaknessRecs', ladder: 'buildEstLadder' };
  const needFn = fnFor[req.kind];
  if (needFn && typeof recCtx[needFn] !== 'function') {
    throw new Error(`코어 recommend.js 에 ${needFn} 없음 (구버전 캐시 — INF 재시작)`);
  }
  const bs = toNum(p.baseStar, baseStar);
  if (bs == null) throw new Error('baseStar 없음 (별값 미산출 — DP 플레이 기록 필요)');

  const layout = p.layout === 'on' ? 'on' : 'off';
  if (typeof recCtx.setLayoutMode === 'function') recCtx.setLayoutMode(layout);

  if (req.kind === 'clear') {
    const levelMode = p.levelMode === 'lv12' ? 'lv12' : 'lv11+12';
    const djMode = p.djMode === 'on' ? 'on' : 'off';
    const limit = toNum(p.limit, 10) || 10;
    const stageArg = typeof p.stage === 'string' ? p.stage.toLowerCase() : null;
    const THRESH: Record<string, number> = { ec: 3, hc: 5, exh: 6 };
    const runStage = (stage: string): Any[] => {
      if ((stage === 'hc' || stage === 'exh') && bs < 0.5) return [];
      const rows = recCtx.buildRecs(THRESH[stage], stage, bs, levelMode, djMode) as Any[];
      return (rows || []).slice(0, limit).map(slimRow);
    };
    if (stageArg && THRESH[stageArg]) {
      return { baseStar: bs, layout, stage: stageArg, rows: runStage(stageArg) };
    }
    return { baseStar: bs, layout, ec: runStage('ec'), hc: runStage('hc'), exh: runStage('exh') };
  }

  if (req.kind === 'practice') {
    const opts: Record<string, unknown> = {
      mode: typeof p.feature === 'string' && p.feature ? p.feature : 'all',
      strength: toNum(p.strength, 1) || 1,
      handMode: p.handMode === 'left' || p.handMode === 'right' ? p.handMode : 'both',
      flipOn: p.flipOn !== false,
      topN: toNum(p.topN, 5) || 5,
    };
    if (toNum(p.zasaMin, null) != null) opts.zasaMin = p.zasaMin;
    if (toNum(p.zasaMax, null) != null) opts.zasaMax = p.zasaMax;
    const rows = recCtx.buildWeaknessRecs(bs, opts) as Any[];
    return { baseStar: bs, layout, feature: opts.mode, strength: opts.strength, handMode: opts.handMode, rows: (rows || []).map(slimRow) };
  }

  if (req.kind === 'ladder') {
    const preset = p.preset === 'light' || p.preset === 'hard' ? p.preset : 'normal';
    const topN = toNum(p.topN, 5) || 5;
    const mode = typeof p.mode === 'string' ? p.mode.toLowerCase()
      : typeof p.axis === 'string' ? p.axis.toLowerCase() : '';

    // 추천곡 v3/v4 재설계 Phase 1 — mode 없으면 아래 레거시 buildEstLadder 무변경.
    if (mode === 'lamp' || mode === 'score') {
      if (typeof recCtx.buildGrowthLandscape !== 'function') {
        throw new Error('코어 recommend.js 에 buildGrowthLandscape 없음 (구버전 캐시 — INF 재시작)');
      }
      const axis = mode === 'score' ? 'score' : 'lamp';
      // 축별 base 분리 — lamp=별값(bs) / score=유저 r★(userRStar). r★ 결손이면 안전하게 빈 결과.
      const gBase = axis === 'score' ? userRStar : bs;
      if (gBase == null) {
        return {
          mode: axis, base: null, baseKind: axis === 'score' ? 'r_star' : 'star',
          error: axis === 'score' ? 'no_r_star' : 'no_star',
          hint: axis === 'score' ? 'DP r★ 미산출 (점수 기록 더 필요)' : 'DP 별값 미산출',
          sections: [],
        };
      }
      const res = recCtx.buildGrowthLandscape(gBase, { axis, topN }) as Any;
      const sections = ((res && res.sections) || []).map((s: Any) => ({
        key: s.key, // 'solid' | 'aspiration'
        label: s.label,
        validated: !!s.validated,
        confidence: s.confidence ?? null,
        range: s.range ?? null,
        center: s.center ?? null,
        target: s.target ?? null,
        fixedStep: !!s.fixedStep,
        fallbackReason: s.fallbackReason ?? null,
        short: !!s.short,
        rows: (s.recs || []).map((r: Any) => {
          const o = slimRow(r);
          if (axis === 'score') { delete o.targetStar; delete o.margin; } // 클리어 축 값 — score 문맥 혼동 방지
          o.growth = growthSlim(r._growthExplain, axis);
          return o;
        }),
      }));
      return {
        mode: axis, base: gBase, baseKind: axis === 'score' ? 'r_star' : 'star',
        version: (res && res.version) || 'phase1-solid',
        explain: (res && res.explain) || null,
        sections,
      };
    }

    // 레거시 buildEstLadder (3섹션 solid/t1/t2) — 무변경.
    const sections = recCtx.buildEstLadder(bs, { preset, topN }) as Any[];
    return {
      baseStar: bs,
      preset,
      sections: (sections || []).map((s: Any) => ({
        key: s.key, // solid / t1 / t2
        target: s.target,
        fellback: s.fellback,
        short: s.short,
        rows: (s.recs || []).map(slimRow),
      })),
    };
  }

  throw new Error(`unknown kind: ${req.kind}`);
}


