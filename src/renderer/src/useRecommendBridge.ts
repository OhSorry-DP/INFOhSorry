// useRecommendBridge — main(http-server /api/recommend) 이 보낸 추천 요청을 renderer 의 recCtx 로 처리한다.
//
// 왜 renderer 인가:
//   recCtx(코어 recommend.js) 는 이미 App.tsx 가 patterns/rate-ref/feature-scores/textage(~3MB) + 모듈 3개를
//   로드해 만들어 둔다. main 에 같은 걸 다시 올리는 대신, main→renderer 요청/응답 채널로 그 ctx 를 재사용한다.
//   → INF 창이 떠 있고 lib 로딩이 끝났을 때만 동작. 아니면 main 이 12초 뒤 timeout → /api/recommend 503.
//
// 요청 kind:
//   meta     — 코어 버전 + 연습곡 피처 목록(practiceParents/Subfeats) + baseStar/userRStar
//   clear    — 클리어 추천 (buildRecs). params: { stage?, baseStar?, levelMode?, djMode?, layout?, limit? }
//   practice — 연습곡 추천 (buildWeaknessRecs). params: { baseStar?, feature?, strength?, handMode?, flipOn?, topN?, layout?, zasaMin?, zasaMax? }
//   ladder   — 추천곡 v3 (buildEstLadder). params: { baseStar?, preset?, topN? }
//   targets  — E모드 등급 목표 폴더(A/AA/AAA/MAX−). params: { grade?, limit? }

import { useEffect, useRef } from 'react';
import { computeTargetFolders, type UserDpChart } from './emodeTargets';
import { norm } from '../../shared/match';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface RecRequest {
  reqId: string;
  kind: 'meta' | 'clear' | 'practice' | 'ladder' | 'targets';
  params?: Record<string, unknown>;
}

export interface RecommendBridgeDeps {
  recCtx: Any; // App.tsx 의 recCtx (null 이면 아직 준비 안 됨)
  ratingData: Any; // window.infohsorry.rating.get() 결과
  userRStar: number | null;
  baseStar: number | null; // 표시 별값 (기본 baseStar)
  userCharts: UserDpChart[]; // 유저 DP 플레이 기록 (목표 폴더 현재 rate 판정용)
}

function normFn(): (s: string) => string {
  return (window as unknown as { OhsorryNorm?: { norm: (s: string) => string } }).OhsorryNorm?.norm || norm;
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

function handle(req: RecRequest, deps: RecommendBridgeDeps): Record<string, unknown> {
  const { recCtx, ratingData, userRStar, baseStar, userCharts } = deps;
  const p = req.params || {};

  if (req.kind === 'meta') {
    return {
      ready: !!recCtx,
      coreVersion: recCtx?.VERSION || null,
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
    const folders = computeTargetFolders(ratingData, userRStar, userCharts, normFn());
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

export function useRecommendBridge(deps: RecommendBridgeDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const api = (window as unknown as { infohsorry?: { recommend?: { onRequest?: (cb: (r: RecRequest) => void) => (() => void); respond?: (p: unknown) => void } } }).infohsorry;
    const rec = api?.recommend;
    if (!rec?.onRequest || !rec?.respond) return; // 구버전 preload (원격 브라우저 등) — 무시
    const off = rec.onRequest((req: RecRequest) => {
      try {
        const result = handle(req, depsRef.current);
        rec.respond!({ reqId: req.reqId, ok: true, result });
      } catch (e) {
        rec.respond!({ reqId: req.reqId, ok: false, error: (e as Error).message });
      }
    });
    return off;
  }, []);
}
