// Analysis 탭 — ohSorryWeb 분석탭과 동일 모듈 (window.OhsorryAnalysisRender) 사용.
//   gist 의 analysisRender.js 한 곳만 갱신하면 ohSorryWeb + INFOhSorry 양쪽 즉시 반영.
//
// 흐름:
//   1. mount 시 gist fetch (calcWeakness + normTitle + patterns + rateRef + analysisRender)
//   2. SongChart (TSV) → calcWeakness chart 형식
//   3. calcUserWeakness → userVec
//   4. supabase upsert + percentile fetch
//   5. window.OhsorryAnalysisRender.attachClickHandlers(panel, opts, handlers)
//      → 모듈이 panel.innerHTML 채우고 클릭 위임. 곡 클릭 시 onPickChart 호출.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SongChart, RatingData, ZasaData } from '../../shared/types';
import { IS_BROWSER_REMOTE } from './api';

const GIST_RAW = 'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw';
// 평소 11·12 만 fetch (7MB→1.8MB). 약점 분석은 고렙 기준이라 1112 로 충분.
const PATTERNS_URL = `${GIST_RAW}/patterns-dp-1112.json`;
const RATE_REF_URL = `${GIST_RAW}/rate-reference-slim.json`;
const CALC_WEAKNESS_URL = `${GIST_RAW}/calcWeakness.js`;
const NORM_TITLE_URL = `${GIST_RAW}/normTitle.js`;
const ANALYSIS_RENDER_URL = `${GIST_RAW}/analysisRender.js`;
// feature-scores-slim.json — 차트별 11 feature quantile score (0~100). 분석탭 기여곡 표의 곡 점수.
//   dbConn v0.0.407 의 user_ohsorry_radars feature score 백필 알고리즘과 동일 데이터 — DB 값과 일관성 있게 표시.
const FEATURE_SCORES_URL = `${GIST_RAW}/feature-scores-slim.json`;

const SUPABASE_URL = 'https://cvxpeecxiawddmrzbdvn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2eHBlZWN4aWF3ZGRtcnpiZHZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5ODMxMzQsImV4cCI6MjA5NDU1OTEzNH0.lWnnSsSIFFLs7NsJq5yI6fe9HPiT9yQ3Pj-8sgfGuxI';

const SLOT_TO_DIFF: Record<string, string> = {
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};
const DIFF_TO_SLOT: Record<string, string> = {
  NORMAL: 'DPN', HYPER: 'DPH', ANOTHER: 'DPA', LEGGENDARIA: 'DPL',
};
const LAMP_TO_NUM: Record<string, number> = {
  NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7,
};

async function loadGistModule(url: string, globalKey: string, force = false): Promise<unknown> {
  const w = window as unknown as Record<string, unknown>;
  if (!force && w[globalKey]) return w[globalKey];
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

function songChartsToWeaknessCharts(charts: SongChart[]): {
  title: string; diff: string; exScore: number; noteCount: number;
  scorePercent: number; lampNum: number;
}[] {
  const out: { title: string; diff: string; exScore: number; noteCount: number;
    scorePercent: number; lampNum: number; }[] = [];
  for (const c of charts) {
    const diff = SLOT_TO_DIFF[c.slot];
    if (!diff) continue;
    if (!c.noteCount || c.noteCount <= 0) continue;
    out.push({
      title: c.title, diff,
      exScore: c.exScore || 0,
      noteCount: c.noteCount,
      scorePercent: ((c.exScore || 0) / (c.noteCount * 2)) * 100,
      lampNum: LAMP_TO_NUM[c.lamp] ?? 0,
    });
  }
  return out;
}

// 본인 user_ohsorry_radars 10 feature score (quantile score 평균, 0~100). 빈 {} 가능.
type UserFeatureScore = Record<string, number | null>;

// user_ohsorry_radars REST 로 본인 DP row 직접 fetch (RPC 안 씀). 분석탭 헤더 score 용.
//   INFOhSorry 는 유저 목록 화면 미보유. percentile/rank 계산만 위해
//   별도 fetchAllUsersFeatureScores 가 전체 row 받음 (목록 표시 X, 순위 계산만).
async function fetchUserFeatureScore(iidxId: string): Promise<UserFeatureScore | null> {
  if (!iidxId) return null;
  const id = iidxId.replace(/-/g, '');
  try {
    const cols = 'notes,chord,peak,charge,scratch,soflan,phrase,jack,trill,rand';
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_ohsorry_radars?iidx_id=eq.${encodeURIComponent(id)}&play_style=eq.1&select=${cols}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r = rows[0];
    return {
      NOTES: r.notes, CHORD: r.chord, PEAK: r.peak,
      CHARGE: r.charge, SCRATCH: r.scratch, 'SOF-LAN': r.soflan,
      PHRASE: r.phrase, JACK: r.jack, TRILL: r.trill, RAND: r.rand,
    };
  } catch { return null; }
}

// percentile + 인라인 랭킹표용 — 모든 user 의 dj_name + os_pattern_score fetch.
//   users 테이블 + user_ohsorry_radars nested select (play_style=1 DP row).
//   ohSorryWeb api.js fetchAllUsersUncached 와 동일 형태 — analysisRender 가 dj_name / iidx_id / os_pattern_score 한 번에 활용.
//   페이지네이션 (PostgREST 기본 max 1000). 10분 module-level cache 로 카드 전환마다 재fetch 안 함.
const OS_FEATS = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN', 'PHRASE', 'JACK', 'TRILL', 'RAND'] as const;
interface AllUserScoreRow {
  iidx_id: string;
  dj_name: string | null;
  // 오소리웹 fetchAllUsersUncached 와 동일 필드 — analysisRender 의 랭킹보기에서 ★ / 단위 / 갱신일 표시 + 정렬에 사용.
  //   이 필드들 없으면 랭킹표에 ? 로 표시됨.
  star: number | null;
  ereter_star: number | null;
  sp_rank: number | null;
  dp_rank: number | null;
  date: string | null;
  os_pattern_score: Record<string, number | null>;
}
let _allUsersFsCache: { data: AllUserScoreRow[]; ts: number } | null = null;
const ALL_USERS_FS_TTL_MS = 10 * 60 * 1000;  // 10분 — 분석탭 열린 동안 자동 갱신 주기와 동기화

async function fetchAllUsersFeatureScores(): Promise<AllUserScoreRow[]> {
  const now = Date.now();
  if (_allUsersFsCache && (now - _allUsersFsCache.ts) < ALL_USERS_FS_TTL_MS) return _allUsersFsCache.data;
  const PAGE = 1000;
  const out: AllUserScoreRow[] = [];
  let offset = 0;
  for (;;) {
    // 오소리웹 fetchAllUsersUncached 와 동일 SELECT — analysisRender 랭킹보기에서 ★ / 단위 / 갱신일 표시에 사용.
    const url = `${SUPABASE_URL}/rest/v1/users`
      + `?select=iidx_id,dj_name,star,ereter_star,sp_rank,dp_rank,date,`
      + `user_ohsorry_radars(play_style,notes,chord,peak,charge,scratch,soflan,phrase,jack,trill,rand)`
      + `&order=star.desc.nullslast&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    if (!res.ok) break;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dpRow = Array.isArray(r.user_ohsorry_radars)
        ? r.user_ohsorry_radars.find((rr: { play_style: number }) => rr.play_style === 1)
        : null;
      out.push({
        iidx_id: r.iidx_id,
        dj_name: r.dj_name ?? null,
        star: typeof r.star === 'number' ? r.star : null,
        ereter_star: typeof r.ereter_star === 'number' ? r.ereter_star : null,
        sp_rank: typeof r.sp_rank === 'number' ? r.sp_rank : null,
        dp_rank: typeof r.dp_rank === 'number' ? r.dp_rank : null,
        date: r.date ?? null,
        os_pattern_score: dpRow ? {
          NOTES: dpRow.notes, CHORD: dpRow.chord, PEAK: dpRow.peak,
          CHARGE: dpRow.charge, SCRATCH: dpRow.scratch, 'SOF-LAN': dpRow.soflan,
          PHRASE: dpRow.phrase, JACK: dpRow.jack, TRILL: dpRow.trill, RAND: dpRow.rand,
        } : {
          NOTES: null, CHORD: null, PEAK: null, CHARGE: null, SCRATCH: null,
          'SOF-LAN': null, PHRASE: null, JACK: null, TRILL: null, RAND: null,
        },
      });
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  _allUsersFsCache = { data: out, ts: now };
  return out;
}

// 본인 myScore + 전체 allUsers → feature 별 { rank, total, percentile }.
//   ohSorryWeb 의 computeOsPercentiles 와 같은 알고리즘 — analysisRender 가 percentile 행 + 막대그래프 percentile 평균 대비 ± 표시에 사용.
function computeOsPercentilesFromList(
  myScore: UserFeatureScore | null,
  allUsers: AllUserScoreRow[],
): Record<string, { rank: number; total: number; percentile: number | null }> | null {
  if (!myScore) return null;
  const out: Record<string, { rank: number; total: number; percentile: number | null }> = {};
  for (const f of OS_FEATS) {
    const myVal = myScore[f];
    if (typeof myVal !== 'number') { out[f] = { rank: 0, total: 0, percentile: null }; continue; }
    let rank = 1, total = 0;
    for (const u of allUsers) {
      const v = u.os_pattern_score?.[f];
      if (typeof v !== 'number') continue;
      total++;
      if (v > myVal) rank++;
    }
    out[f] = { rank, total, percentile: total > 0 ? (rank / total) * 100 : null };
  }
  return out;
}

// supabase user_ohsorry_radars 컬럼 upsert vec — weaknessLib.computePatternScoreVec 호출.
//   backfill-pattern-score.js (ohSorryRating) 및 ohSorry dbConn 과 동일 알고리즘을 calcWeakness 가 통합 제공.
//   diff 매핑 (NORMAL/HYPER/ANOTHER/LEGGENDARIA) 필요 — songChartsToWeaknessCharts 의 SLOT_TO_DIFF 그대로 활용.

// RPC 시그니처: migration_ohsorry_36feat.sql 의 37 인자 (text + 36 numeric).
//   기존 28 dim 뒤에 신규 8 dim(겹계단/계마/양손계단) append. 신규값은 gist calcWeakness+feature-scores 가 36키로 배포된 뒤 산출.
async function upsertFeatureScore(iidxId: string, vec: Record<string, number>): Promise<boolean> {
  const numOrNull = (v: number | undefined): number | null =>
    typeof v === 'number' && isFinite(v) ? v : null;
  // payload 직전 신규 8값 로그 (검증용 — window.__OHSORRY_DEBUG_FEAT 켜면 출력)
  if (typeof window !== 'undefined' && (window as any).__OHSORRY_DEBUG_FEAT) {
    console.log('[upsert 신규8]', {
      DOUBLE_STAIR_L: vec.DOUBLE_STAIR_L, DOUBLE_STAIR_R: vec.DOUBLE_STAIR_R,
      KEIMA_L: vec.KEIMA_L, KEIMA_R: vec.KEIMA_R,
      HSTAIR_ONEHAND: vec.HSTAIR_ONEHAND, HSTAIR_SYNC: vec.HSTAIR_SYNC,
      HSTAIR_SAMESHAPE: vec.HSTAIR_SAMESHAPE, HSTAIR_DIFFSHAPE: vec.HSTAIR_DIFFSHAPE,
    });
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_user_feature_score`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_iidx_id:    iidxId.replace(/-/g, ''),
        p_os_notes:   numOrNull(vec.NOTES),
        p_os_chord:   numOrNull(vec.CHORD),
        p_os_peak:    numOrNull(vec.PEAK),
        p_os_charge:  numOrNull(vec.CHARGE),
        p_os_scratch: numOrNull(vec.SCRATCH),
        p_os_soflan:  numOrNull(vec['SOF-LAN']),
        p_os_phrase:  numOrNull(vec.PHRASE),
        p_os_jack:    numOrNull(vec.JACK),
        p_os_trill:   numOrNull(vec.TRILL),
        p_os_rand:    numOrNull(vec.RAND),
        p_os_stair_up_l: numOrNull(vec.STAIR_UP_L),
        p_os_stair_up_r: numOrNull(vec.STAIR_UP_R),
        p_os_stair_dn_l: numOrNull(vec.STAIR_DN_L),
        p_os_stair_dn_r: numOrNull(vec.STAIR_DN_R),
        p_os_k1_l: numOrNull(vec.K1_L), p_os_k1_r: numOrNull(vec.K1_R),
        p_os_k2_l: numOrNull(vec.K2_L), p_os_k2_r: numOrNull(vec.K2_R),
        p_os_k3_l: numOrNull(vec.K3_L), p_os_k3_r: numOrNull(vec.K3_R),
        p_os_k4_l: numOrNull(vec.K4_L), p_os_k4_r: numOrNull(vec.K4_R),
        p_os_k5_l: numOrNull(vec.K5_L), p_os_k5_r: numOrNull(vec.K5_R),
        p_os_k6_l: numOrNull(vec.K6_L), p_os_k6_r: numOrNull(vec.K6_R),
        p_os_k7_l: numOrNull(vec.K7_L), p_os_k7_r: numOrNull(vec.K7_R),
        // 신규 8
        p_os_double_stair_l: numOrNull(vec.DOUBLE_STAIR_L), p_os_double_stair_r: numOrNull(vec.DOUBLE_STAIR_R),
        p_os_keima_l: numOrNull(vec.KEIMA_L), p_os_keima_r: numOrNull(vec.KEIMA_R),
        p_os_hstair_onehand: numOrNull(vec.HSTAIR_ONEHAND), p_os_hstair_sync: numOrNull(vec.HSTAIR_SYNC),
        p_os_hstair_sameshape: numOrNull(vec.HSTAIR_SAMESHAPE), p_os_hstair_diffshape: numOrNull(vec.HSTAIR_DIFFSHAPE),
      }),
    });
    return res.ok;
  } catch { return false; }
}

interface AnalysisProps {
  charts: SongChart[];
  ratingData: RatingData | null;
  zasaData: ZasaData | null;
  iidxId?: string;
  recomputeKey?: number;
  onPickChart?: (title: string, slot: string) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLib = any;
interface RenderController {
  setOpts: (opts: AnyLib) => void;
  setSelectedFeat: (k: string | null) => void;
}

export default function Analysis(props: AnalysisProps): JSX.Element {
  const { charts, ratingData, zasaData, iidxId, recomputeKey = 0, onPickChart } = props;
  const [libsReady, setLibsReady] = useState(false);
  const [userFeatureScore, setUserFeatureScore] = useState<UserFeatureScore | null>(null);
  const [percentiles, setPercentiles] = useState<Record<string, { rank: number; total: number; percentile: number | null }> | null>(null);
  // 인라인 랭킹표 (피처별 랭킹보기 토글) 용 — fetchAllUsersFeatureScores 결과 그대로.
  const [allUserScores, setAllUserScores] = useState<AllUserScoreRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const libsRef = useRef<{ weaknessLib?: any; normLib?: any; renderLib?: any; patternsMap?: any; rateRef?: any; featureScores?: any }>({});
  const panelRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<RenderController | null>(null);
  // 콜백 ref — attachClickHandlers 가 마운트 1회만 부착되므로, props 변경에도 최신 onPickChart 가 호출되도록 ref 통과.
  const handlerRef = useRef<{ onChartClick: (title: string, diff: string) => void }>({ onChartClick: () => {} });

  // 1. lib + json + render 모듈 fetch — 마운트 시 1회 + 10분마다 자동 갱신 (ohSorryAdmin seed:full 반영).
  useEffect(() => {
    let cancelled = false;
    let isFirst = true;
    const loadAll = async (): Promise<void> => {
      try {
        // 10분 polling 호출 (= force=true) 시 모듈 JS 도 다시 fetch + eval — gist 의 normTitle / weakness /
        //   analysisRender 갱신 반영. 첫 호출은 force=false (cache 활용 — 마운트 시 빠른 진입).
        const force = !isFirst;
        await loadGistModule(NORM_TITLE_URL, 'OhsorryNorm', force);
        await loadGistModule(CALC_WEAKNESS_URL, 'OhsorryWeakness', force);
        await loadGistModule(ANALYSIS_RENDER_URL, 'OhsorryAnalysisRender', force);
        const w = window as unknown as Record<string, unknown>;
        const [patternsMap, rateRef, featureScores] = await Promise.all([
          loadJson(PATTERNS_URL),
          loadJson(RATE_REF_URL),
          loadJson(FEATURE_SCORES_URL).catch((e) => {
            console.warn('[Analysis] feature-scores fetch 실패 (곡 점수 fallback):', e?.message);
            return null;
          }),
        ]);
        if (cancelled) return;
        libsRef.current = {
          weaknessLib: w.OhsorryWeakness,
          normLib: w.OhsorryNorm,
          renderLib: w.OhsorryAnalysisRender,
          patternsMap,
          rateRef,
          featureScores,
        };
        setLibsReady(true);
        isFirst = false;
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void loadAll();
    // 10분마다 재호출 — gist patterns / rate-ref / feature-scores 신곡 반영. 모듈 JS 도 force=true 로 재 eval.
    const interval = setInterval(() => void loadAll(), 10 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // 2. 본인 user_ohsorry_radars feature score fetch — iidxId 변경 시 + recomputeKey (App timer) 마다
  useEffect(() => {
    if (!iidxId) { setUserFeatureScore(null); return; }
    let cancelled = false;
    fetchUserFeatureScore(iidxId).then((p) => { if (!cancelled) setUserFeatureScore(p); });
    return () => { cancelled = true; };
  }, [iidxId, recomputeKey]);

  // 2.5. percentile 계산 — 처음 마운트 시 1회 fetch + 10분 interval 자동 refetch.
  //   목록 표시는 안 함 (목록 UI 없음). 분석탭 헤더 "X위 / Y명" 행 + 막대그래프 percentile 평균 대비 ± 만 갱신.
  //   fetchAllUsersFeatureScores 가 10분 cache 라 카드 전환마다 재fetch 하지 않음.
  useEffect(() => {
    if (!iidxId || !userFeatureScore) { setPercentiles(null); setAllUserScores(null); return; }
    let cancelled = false;
    const refresh = async () => {
      try {
        const all = await fetchAllUsersFeatureScores();
        if (cancelled) return;
        const pcts = computeOsPercentilesFromList(userFeatureScore, all);
        setPercentiles(pcts);
        setAllUserScores(all);
      } catch (e) {
        console.warn('[Analysis] percentiles 계산 실패:', (e as Error).message);
      }
    };
    refresh();
    const timer = setInterval(refresh, ALL_USERS_FS_TTL_MS);  // 10분마다 자동 갱신
    return () => { cancelled = true; clearInterval(timer); };
  }, [iidxId, userFeatureScore]);

  // 3. vec 계산
  const vecResult = useMemo(() => {
    if (!libsReady) return null;
    const { weaknessLib, normLib, patternsMap, rateRef } = libsRef.current;
    if (!weaknessLib || !normLib) return null;
    const allCharts = songChartsToWeaknessCharts(charts);
    if (allCharts.length === 0) return null;
    try {
      const vec = weaknessLib.calcUserWeakness({
        allCharts, patternsMap, normFn: normLib.norm,
        ratingMap: ratingData?.ratings || null,
        zasaMap: zasaData?.charts || null,
        rateRef,
      });
      if (!vec || !vec.__entries) return null;
      return { vec, allCharts };
    } catch (e) {
      console.warn('[Analysis] calcUserWeakness 실패:', e);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libsReady, charts, ratingData, zasaData, recomputeKey]);

  // 4. supabase upsert — weaknessLib.computePatternScoreVec (chart_score × score_rate top 30 가중합).
  //    backfill 알고리즘과 동일. 이전엔 vecResult.vec (calcWeakness 잔차, -1~1) 을 그대로 upsert → 형식 불일치 → 수정.
  const lastUpsertedRef = useRef<string | null>(null);
  useEffect(() => {
    if (IS_BROWSER_REMOTE || !iidxId || !vecResult) return;
    const libs = libsRef.current;
    if (!libs.weaknessLib || !libs.featureScores || !libs.patternsMap || !libs.normLib) return;
    // diff 키 (NORMAL/HYPER/ANOTHER/LEGGENDARIA) 로 변환된 charts 가 필요 — songChartsToWeaknessCharts 결과 활용 가능.
    const weaknessCharts = songChartsToWeaknessCharts(charts);
    const patternVec = libs.weaknessLib.computePatternScoreVec({
      charts: weaknessCharts,
      featureScores: libs.featureScores,
      patternsMap: libs.patternsMap,
      normFn: libs.normLib.norm,
    });
    if (!patternVec) return;
    const key = iidxId + ':' + (patternVec.NOTES || 0).toFixed(2) + ':' + recomputeKey;
    if (lastUpsertedRef.current === key) return;
    lastUpsertedRef.current = key;
    upsertFeatureScore(iidxId, patternVec).then((ok: boolean) => {
      if (ok) console.log('[Analysis] feature score upsert 성공 (NOTES=' + (patternVec.NOTES || 0).toFixed(1) + ')');
      else console.warn('[Analysis] feature score upsert 실패');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iidxId, vecResult, recomputeKey]);

  // noteCount lookup — title + diff → noteCount.
  const noteCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of charts) {
      if (c.noteCount > 0) {
        const diff = SLOT_TO_DIFF[c.slot];
        if (diff) m.set(c.title + '|' + diff, c.noteCount);
      }
    }
    return m;
  }, [charts]);

  // onPickChart 변경 시 handlerRef 갱신
  useEffect(() => {
    handlerRef.current.onChartClick = (title, diff) => {
      if (!onPickChart) return;
      const slot = DIFF_TO_SLOT[diff] || diff;
      onPickChart(title, slot);
    };
  }, [onPickChart]);

  // 5. attachClickHandlers (마운트 1회) + opts 변경 시 setOpts
  useEffect(() => {
    if (!libsReady || !vecResult || !panelRef.current) return;
    const libs = libsRef.current;
    const opts = {
      userVec: vecResult.vec,
      patternsMap: libs.patternsMap,
      ratingMap: ratingData?.ratings || null,
      zasaMap: zasaData?.charts || null,
      allCharts: vecResult.allCharts,
      baseStar: null,  // INFOhSorry 는 ★ 추정 X → analyzeFeature 가 알아서 동작 (zasa 필터 off)
      normFn: libs.normLib.norm,
      // analysisRender 의 opts 키 호환 (userPatternScore). 내부 변수명만 *FeatureScore.
      userPatternScore: userFeatureScore,
      // feature-scores _meta.maxScoreByFeat — 막대그래프 max% 환산용 (analysisRender v0.0.20+).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      maxScoreByFeat: (libs.featureScores as any)?._meta?.maxScoreByFeat,
      noteCountResolver: (_songId: string, _chartName: string, title: string, diff: string) => {
        return noteCountMap.get(title + '|' + diff) ?? null;
      },
      // INF 수록 필터 — TSV (INF only) 에 noteCount 있는 차트 = INF 수록.
      //   supabase songs.ac/legen 데이터 정확도와 무관하게 TSV 만으로 정확 판단.
      //   chartName 'DP_NOR'/'DP_HYP'/'DP_ANO'/'DP_LEG' → diff 매핑 후 noteCountMap lookup.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extraRecFilter: (c: any) => {
        const CHART2DIFF: Record<string, string> = {
          DP_NOR: 'NORMAL', DP_HYP: 'HYPER', DP_ANO: 'ANOTHER', DP_LEG: 'LEGGENDARIA',
        };
        const recDiff = CHART2DIFF[c.chartName as string] || c.diff || '';
        return noteCountMap.has(c.title + '|' + recDiff);
      },
      weaknessLib: libs.weaknessLib,
      featureScores: libs.featureScores,
      // 피처별 랭킹보기 — percentiles + allUserScores + myIidxId 셋 다 넘기면 analysisRender 가 "랭킹보기" 토글 노출.
      //   supabase iidx_id 는 하이픈 없는 형식이라 myIidxId 도 동일하게 정규화.
      percentiles,
      allUserScores,
      myIidxId: iidxId ? iidxId.replace(/-/g, '') : null,
    };
    if (!controllerRef.current) {
      controllerRef.current = libs.renderLib.attachClickHandlers(
        panelRef.current,
        opts,
        { onChartClick: (t: string, d: string) => handlerRef.current.onChartClick(t, d) },
      );
    } else {
      controllerRef.current.setOpts(opts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libsReady, vecResult, userFeatureScore, percentiles, allUserScores, ratingData, zasaData, noteCountMap, iidxId]);

  if (error) {
    return <div style={{ padding: 20, color: '#ff6b6b' }}>오류: {error}</div>;
  }
  if (!libsReady) {
    return <div style={{ padding: 20, color: '#888' }}>분석 lib 로딩 중...</div>;
  }
  if (!vecResult) {
    return (
      <div style={{ padding: 20, color: '#888' }}>
        {charts.length === 0 ? '차트 데이터 없음' : '분석 데이터 부족 (lv11+12 차트 30곡 이상 필요)'}
      </div>
    );
  }
  return <div ref={panelRef} style={{ padding: 16 }} />;
}
