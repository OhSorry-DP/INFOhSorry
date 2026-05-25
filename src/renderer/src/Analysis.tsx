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
const PATTERNS_URL = `${GIST_RAW}/patterns-all-slim.json`;
const RATE_REF_URL = `${GIST_RAW}/rate-reference-slim.json`;
const CALC_WEAKNESS_URL = `${GIST_RAW}/calcWeakness.js`;
const NORM_TITLE_URL = `${GIST_RAW}/normTitle.js`;
const ANALYSIS_RENDER_URL = `${GIST_RAW}/analysisRender.js`;

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

async function loadGistModule(url: string, globalKey: string): Promise<unknown> {
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

interface Percentile { rank: number | null; total: number; percentile: number | null; }
type PercentileMap = Record<string, Percentile>;

async function fetchPercentiles(iidxId: string): Promise<PercentileMap | null> {
  if (!iidxId) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_pattern_vec_percentiles`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_iidx_id: iidxId.replace(/-/g, '') }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function upsertPatternVec(iidxId: string, vec: Record<string, number>): Promise<boolean> {
  const numOrNull = (v: number | undefined): number | null =>
    typeof v === 'number' && isFinite(v) ? v : null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_user_pattern_vec`, {
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
  const [percentiles, setPercentiles] = useState<PercentileMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const libsRef = useRef<{ weaknessLib?: any; normLib?: any; renderLib?: any; patternsMap?: any; rateRef?: any }>({});
  const panelRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<RenderController | null>(null);
  // 콜백 ref — attachClickHandlers 가 마운트 1회만 부착되므로, props 변경에도 최신 onPickChart 가 호출되도록 ref 통과.
  const handlerRef = useRef<{ onChartClick: (title: string, diff: string) => void }>({ onChartClick: () => {} });

  // 1. lib + json + render 모듈 fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadGistModule(NORM_TITLE_URL, 'OhsorryNorm');
        await loadGistModule(CALC_WEAKNESS_URL, 'OhsorryWeakness');
        await loadGistModule(ANALYSIS_RENDER_URL, 'OhsorryAnalysisRender');
        const w = window as unknown as Record<string, unknown>;
        const [patternsMap, rateRef] = await Promise.all([
          loadJson(PATTERNS_URL),
          loadJson(RATE_REF_URL),
        ]);
        if (cancelled) return;
        libsRef.current = {
          weaknessLib: w.OhsorryWeakness,
          normLib: w.OhsorryNorm,
          renderLib: w.OhsorryAnalysisRender,
          patternsMap,
          rateRef,
        };
        setLibsReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 2. percentile fetch — iidxId 변경 시 + recomputeKey (App timer) 마다
  useEffect(() => {
    if (!iidxId) { setPercentiles(null); return; }
    let cancelled = false;
    fetchPercentiles(iidxId).then((p) => { if (!cancelled) setPercentiles(p); });
    return () => { cancelled = true; };
  }, [iidxId, recomputeKey]);

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

  // 4. supabase upsert
  const lastUpsertedRef = useRef<string | null>(null);
  useEffect(() => {
    if (IS_BROWSER_REMOTE || !iidxId || !vecResult) return;
    const key = iidxId + ':' + (vecResult.vec.NOTES || 0).toFixed(4) + ':' + recomputeKey;
    if (lastUpsertedRef.current === key) return;
    lastUpsertedRef.current = key;
    upsertPatternVec(iidxId, vecResult.vec).then((ok) => {
      if (ok) console.log('[Analysis] pattern vec upsert 성공');
      else console.warn('[Analysis] pattern vec upsert 실패');
    });
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
      percentiles,
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
  }, [libsReady, vecResult, percentiles, ratingData, zasaData, noteCountMap]);

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
