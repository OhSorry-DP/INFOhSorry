// Analysis 탭 — ohSorryWeb 분석탭 (vRel 정렬 + percentile + 기여곡/추천곡) 의 INFOhSorry 포팅.
//
// 데이터 흐름:
//   1. mount 시 gist fetch (patterns-all-slim.json + rate-reference-slim.json + calcWeakness.js)
//   2. props.charts (SongChart[]) → calcWeakness 의 chart 형식 (title/diff/exScore/noteCount/lampNum)
//   3. calcUserWeakness({ allCharts, patternsMap, normFn, ratingMap, zasaMap, rateRef }) → vec
//   4. supabase RPC fetch_pattern_vec_percentiles 호출 (iidxId 있을 때)
//   5. UI: 막대그래프 (vec - userMean mix) + feature 클릭 시 헤더/percentile/기여곡/추천곡 표시
//
// onPickChart prop — 곡 클릭 시 DP 탭으로 이동 + 스크롤 (App 의 기존 패턴 재사용)
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SongChart, RatingData, ZasaData } from '../../shared/types';
import { IS_BROWSER_REMOTE } from './api';

// 자체 timer 없음 — App 의 단일 timer (STAR_REFRESH_INTERVAL_MS) 가 vecRecomputeKey 증가로 트리거.

const GIST_RAW = 'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw';
const PATTERNS_URL = `${GIST_RAW}/patterns-all-slim.json`;
const RATE_REF_URL = `${GIST_RAW}/rate-reference-slim.json`;
const CALC_WEAKNESS_URL = `${GIST_RAW}/calcWeakness.js`;
const NORM_TITLE_URL = `${GIST_RAW}/normTitle.js`;

const SUPABASE_URL = 'https://cvxpeecxiawddmrzbdvn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2eHBlZWN4aWF3ZGRtcnpiZHZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5ODMxMzQsImV4cCI6MjA5NDU1OTEzNH0.lWnnSsSIFFLs7NsJq5yI6fe9HPiT9yQ3Pj-8sgfGuxI';

const SLOT_TO_DIFF: Record<string, string> = {
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};
const LAMP_TO_NUM: Record<string, number> = {
  NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7,
};

const FEATS = [
  { k: 'NOTES',   ko: '노트수',     desc: '곡의 전체 노트 양과 밀도' },
  { k: 'CHORD',   ko: '동시치기',   desc: '2개 이상 노트를 동시에 누르는 패턴의 빈도·복잡도' },
  { k: 'PHRASE',  ko: '계단',       desc: '인접 키가 순차로 흐르는 패턴 (1→2→3→4 형식)' },
  { k: 'PEAK',    ko: '순간 밀도',  desc: '곡 중 노트가 가장 빽빽하게 쏟아지는 구간의 nps' },
  { k: 'RAND',    ko: '산발',       desc: '키 위치가 지그재그로 자주 바뀌는 분산 패턴' },
  { k: 'JACK',    ko: '축연타',     desc: '같은 키를 짧은 간격으로 반복해서 누르는 패턴' },
  { k: 'TRILL',   ko: '트릴',       desc: '두 키를 빠르게 번갈아 누르는 패턴' },
  { k: 'CHARGE',  ko: '롱노트',     desc: '차지 노트(CN)/헬차지/백스핀 스크래치 비중과 처리 난이도' },
  { k: 'SCRATCH', ko: '스크래치',   desc: '턴테이블을 돌려야 하는 패턴의 빈도와 난이도' },
  { k: 'SOF-LAN', ko: '변속',       desc: 'BPM 변화 횟수' },
];

const DJ_CUTOFFS = [2/9, 3/9, 4/9, 5/9, 6/9, 7/9, 8/9, 0.93, 0.95, 0.96, 0.97, 0.98, 0.99, 1.0];

// gist 모듈 fetch + eval (UMD wrapper 라 window 에 등록)
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

// SongChart[] (INFOhSorry) → calcWeakness 의 chart 형식
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

// supabase user_radars 의 os_* 컬럼에 vec upsert
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
  recomputeKey?: number;  // App 의 단일 timer 가 증가시킴 — 변경 시 vec 재계산 + upsert
  onPickChart?: (title: string, slot: string) => void;
}

interface ByChartData { pt: Record<string, number>; rSum: number; n: number;
  rAvg: number; title: string; diff: string; lv: number; rate: number; lampNum: number; }
interface VecResult {
  vec: Record<string, number>;
  byChartData: Record<string, ByChartData>;
  sumPtPerFeat: Record<string, number>;
  matched: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WeaknessLib = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NormLib = { norm: (s: string) => string } | any;

export default function Analysis(props: AnalysisProps): JSX.Element {
  const { charts, ratingData, zasaData, iidxId, recomputeKey = 0, onPickChart } = props;
  const [weaknessLib, setWeaknessLib] = useState<WeaknessLib | null>(null);
  const [normLib, setNormLib] = useState<NormLib | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [patternsMap, setPatternsMap] = useState<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [rateRef, setRateRef] = useState<any>(null);
  const [percentiles, setPercentiles] = useState<PercentileMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFeat, setSelectedFeat] = useState<string | null>(null);

  // 1. gist 데이터 + lib mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadGistModule(NORM_TITLE_URL, 'OhsorryNorm');
        const w = window as unknown as Record<string, unknown>;
        await loadGistModule(CALC_WEAKNESS_URL, 'OhsorryWeakness');
        const [p, r] = await Promise.all([
          loadJson(PATTERNS_URL),
          loadJson(RATE_REF_URL),
        ]);
        if (cancelled) return;
        setWeaknessLib(w.OhsorryWeakness);
        setNormLib(w.OhsorryNorm);
        setPatternsMap(p);
        setRateRef(r);
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
  const vecResult = useMemo<VecResult | null>(() => {
    if (!weaknessLib || !normLib || !patternsMap || !rateRef) return null;
    const allCharts = songChartsToWeaknessCharts(charts);
    if (allCharts.length === 0) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ratingMap: any = ratingData?.ratings || null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zasaMap: any = zasaData?.charts || null;
    let vec;
    try {
      vec = weaknessLib.calcUserWeakness({
        allCharts, patternsMap, normFn: normLib.norm,
        ratingMap, zasaMap, rateRef,
      });
    } catch (e) {
      console.warn('[Analysis] calcUserWeakness 실패:', e);
      return null;
    }
    if (!vec || !vec.__entries) return null;
    // byChartData 빌드 (ohSorryWeb populatePattern 와 동일)
    const byChartData: Record<string, ByChartData> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const e of vec.__entries as any[]) {
      if (!byChartData[e.chartId]) {
        byChartData[e.chartId] = {
          pt: e.pt, rSum: 0, n: 0, rAvg: 0,
          title: e.title, diff: e.diff, lv: e.lv, rate: e.rate, lampNum: e.lampNum,
        };
      }
      byChartData[e.chartId].rSum += e.residual;
      byChartData[e.chartId].n += 1;
    }
    for (const cid in byChartData) byChartData[cid].rAvg = byChartData[cid].rSum / byChartData[cid].n;
    const sumPtPerFeat: Record<string, number> = {};
    for (const f of FEATS) {
      let s = 0;
      for (const cid in byChartData) s += (byChartData[cid].pt[f.k] || 0);
      sumPtPerFeat[f.k] = s;
    }
    return { vec, byChartData, sumPtPerFeat, matched: vec.__meta?.matched || 0 };
  }, [weaknessLib, normLib, patternsMap, rateRef, charts, ratingData, zasaData, recomputeKey]);

  // vec 계산 직후 supabase upsert — 처음 + 매 recomputeKey 변경 시 (3분 주기). IS_BROWSER_REMOTE 면 skip.
  const lastUpsertedRef = useRef<string | null>(null);
  useEffect(() => {
    if (IS_BROWSER_REMOTE || !iidxId || !vecResult) return;
    // 같은 vec 중복 upsert 방지 — key = iidxId + vec NOTES (가벼운 fingerprint)
    const key = iidxId + ':' + (vecResult.vec.NOTES || 0).toFixed(4) + ':' + recomputeKey;
    if (lastUpsertedRef.current === key) return;
    lastUpsertedRef.current = key;
    upsertPatternVec(iidxId, vecResult.vec).then((ok) => {
      if (ok) console.log('[Analysis] pattern vec upsert 성공');
      else console.warn('[Analysis] pattern vec upsert 실패');
    });
  }, [iidxId, vecResult, recomputeKey]);

  if (error) {
    return <div style={{ padding: 20, color: '#ff6b6b' }}>오류: {error}</div>;
  }
  if (!vecResult) {
    return (
      <div style={{ padding: 20, color: '#888' }}>
        {!weaknessLib ? '분석 lib 로딩 중...' : !patternsMap ? 'patterns 로딩 중...' :
         charts.length === 0 ? '차트 데이터 없음' : '분석 데이터 부족 (lv11+12 차트 30곡 이상 필요)'}
      </div>
    );
  }

  const { vec, byChartData, sumPtPerFeat } = vecResult;
  // SongChart (TSV) 의 noteCount lookup — 기여곡/추천곡 row 의 EX SCORE 표시용
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
  const valsRaw = FEATS.map((f) => vec[f.k] || 0);
  const userMean = valsRaw.reduce((s, v) => s + v, 0) / valsRaw.length;
  const vals = valsRaw.map((v) => v - userMean);
  const maxAbs = Math.max(...vals.map(Math.abs), 1);

  function chartContribToVRel(cid: string, fk: string): number {
    const bc = byChartData[cid];
    if (!bc) return 0;
    let myContrib = 0, meanContrib = 0;
    for (const f of FEATS) {
      const sp = sumPtPerFeat[f.k];
      if (sp > 0) {
        const cf = (bc.rAvg * (bc.pt[f.k] || 0)) / sp;
        meanContrib += cf;
        if (f.k === fk) myContrib = cf;
      }
    }
    meanContrib /= FEATS.length;
    return myContrib - meanContrib;
  }

  const selectedIdx = selectedFeat ? FEATS.findIndex((f) => f.k === selectedFeat) : -1;

  return (
    <div style={{ padding: '16px 20px', color: '#e9ecef' }}>
      <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 6 }}>
        현재 실력 평균 대비 강점+ / 약점−
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#888', marginBottom: 2 }}>
        <span>← 지력</span><span>개인차 →</span>
      </div>
      {/* 막대그래프 */}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 2, height: 140, padding: '4px 0' }}>
        {FEATS.map((f, i) => {
          const v = vals[i];
          const pct = (Math.abs(v) / maxAbs) * 50;
          const isPos = v >= 0;
          const color = isPos ? '#28a745' : '#dc3545';
          const sign = isPos ? '+' : '';
          const divider = i === 4 ? { borderRight: '1px dashed #ccc', marginRight: 4, paddingRight: 4 } : {};
          const isSelected = selectedFeat === f.k;
          return (
            <div
              key={f.k}
              onClick={() => setSelectedFeat(f.k)}
              title={`${f.k} (${f.ko})\n${f.desc}`}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                position: 'relative', cursor: 'pointer',
                background: isSelected ? 'rgba(127,127,127,0.15)' : 'transparent',
                ...divider,
              }}
            >
              <div style={{ height: 16, fontSize: 12, fontWeight: 600, color }}>
                {sign}{v.toFixed(1)}
              </div>
              <div style={{ position: 'relative', flex: 1, width: '100%', minHeight: 100 }}>
                <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: '#ccc' }} />
                <div
                  style={{
                    position: 'absolute', left: '20%', right: '20%', background: color,
                    borderRadius: 2,
                    [isPos ? 'bottom' : 'top']: '50%',
                    height: `${pct}%`,
                  }}
                />
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: '#666', fontWeight: 500, whiteSpace: 'nowrap' }}>
                {f.k}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>매칭 {vecResult.matched}곡</div>

      {/* 상세 (feature 선택 시) */}
      {selectedFeat ? (
        <FeatureDetail
          feat={FEATS[selectedIdx]}
          vec={vec}
          userMean={userMean}
          byChartData={byChartData}
          sumPtPerFeat={sumPtPerFeat}
          chartContribToVRel={chartContribToVRel}
          percentiles={percentiles}
          onPickChart={onPickChart}
          noteCountMap={noteCountMap}
        />
      ) : (
        <div style={{ marginTop: 10, padding: 10, fontSize: 13, opacity: 0.7, textAlign: 'center' }}>
          분석 항목을 선택하세요 (위 막대 클릭)
        </div>
      )}
    </div>
  );
}

// ===== 상세 컴포넌트 (선택된 feature 의 헤더 + percentile + 기여곡 + 추천곡) =====

interface FeatureDetailProps {
  feat: { k: string; ko: string; desc: string };
  vec: Record<string, number>;
  userMean: number;
  byChartData: Record<string, ByChartData>;
  sumPtPerFeat: Record<string, number>;
  chartContribToVRel: (cid: string, fk: string) => number;
  percentiles: PercentileMap | null;
  onPickChart?: (title: string, slot: string) => void;
}

const DIFF_SHORT: Record<string, string> = { NORMAL: 'N', HYPER: 'H', ANOTHER: 'A', LEGGENDARIA: 'L' };
const DIFF_TO_SLOT: Record<string, string> = { NORMAL: 'DPN', HYPER: 'DPH', ANOTHER: 'DPA', LEGGENDARIA: 'DPL' };

function FeatureDetail(props: FeatureDetailProps & { noteCountMap: Map<string, number> }): JSX.Element {
  const { feat, vec, userMean, byChartData, sumPtPerFeat, chartContribToVRel, percentiles, onPickChart, noteCountMap } = props;
  const k = feat.k;
  const vAbs = vec[k] || 0;
  const vRel = vAbs - userMean;
  const isPos = vRel >= 0;
  const absScore = vAbs + 80;

  // 전체 차트 vRel 정렬 → 기여곡 top 5
  const allChartsVRel = Object.keys(byChartData).map((cid) => {
    const bc = byChartData[cid];
    const parts = cid.split('|');
    return {
      chartId: cid, songId: parts[0], chartName: parts[1],
      title: bc.title, diff: bc.diff, lv: bc.lv,
      pt: bc.pt[k] || 0,
      rate: bc.rate, lampNum: bc.lampNum, residual: bc.rAvg,
      vRel: chartContribToVRel(cid, k),
    };
  });
  const topContributors = allChartsVRel.slice().sort(isPos
    ? (a, b) => b.vRel - a.vRel
    : (a, b) => a.vRel - b.vRel
  ).slice(0, 5);

  // 추천곡 — 기여곡 외 차트 중에서 vRel 회복량 desc top 5
  //   계산: targetRate (rate < bucketMean 이면 bucketMean, 아니면 next cutoff) 도달 시 vRel 증가량
  const contribIds = new Set(topContributors.map((c) => c.chartId));
  const sumPtAll = sumPtPerFeat[k] || 0;
  const F = 10;
  const vRelRatio = (F - 1) / F;
  function nextCut(rate: number): number | null {
    const r = rate / 100;
    for (const cut of DJ_CUTOFFS) if (r < cut) return cut * 100;
    return null;
  }
  type Rec = { chartId: string; songId: string; chartName: string; title: string;
    diff: string; lv: number; rate: number; lampNum: number;
    bucketMean: number; bestTarget: number | null; bestGain: number; };
  const recCandidates: Rec[] = [];
  for (const c of allChartsVRel) {
    if (contribIds.has(c.chartId)) continue;
    const bucketMean = c.rate - c.residual;
    const curRate = c.rate;
    // best target 찾기 (받을기여 >= 0.005 나올 때까지 cutoff 단계 올림)
    let startRate = curRate < bucketMean ? bucketMean : (nextCut(curRate) ?? 100);
    let bestTarget: number | null = null;
    let bestGain = 0;
    let t = startRate;
    for (let i = 0; i < 20; i++) {
      const g = sumPtAll > 0 ? ((t - curRate) * c.pt * vRelRatio) / sumPtAll : 0;
      if (g >= 0.005) { bestTarget = t; bestGain = g; break; }
      if (t >= 100) break;
      const nx = nextCut(t);
      if (!nx || nx <= t) break;
      t = nx;
    }
    if (bestTarget != null) {
      recCandidates.push({
        chartId: c.chartId, songId: c.songId, chartName: c.chartName, title: c.title,
        diff: c.diff, lv: c.lv, rate: c.rate, lampNum: c.lampNum,
        bucketMean, bestTarget, bestGain,
      });
    }
  }
  recCandidates.sort((a, b) => b.bestGain - a.bestGain);
  const recommends = recCandidates.slice(0, 5);

  const pct = percentiles && percentiles[k];

  function handlePick(title: string, diff: string): void {
    if (!onPickChart) return;
    onPickChart(title, DIFF_TO_SLOT[diff] || 'DPA');
  }

  return (
    <div style={{ marginTop: 10, padding: 10, fontSize: 13 }}>
      <div style={{ fontSize: 15, marginBottom: 4 }}>
        <b style={{ fontSize: 17 }}>{feat.k}</b>{' '}
        <span style={{ color: '#aaa', fontWeight: 400 }}>{absScore.toFixed(1)}pt</span>
      </div>
      <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 8 }}>{feat.desc}</div>

      {pct && typeof pct.rank === 'number' && pct.total > 0 ? (
        <div style={{ fontSize: 13, marginBottom: 8, opacity: 0.85 }}>
          <b>{pct.rank}위 / {pct.total}명</b>
          {typeof pct.percentile === 'number' ? <>{' · '}상위 <b>{pct.percentile.toFixed(1)}%</b></> : null}
        </div>
      ) : (
        <div style={{ fontSize: 13, marginBottom: 8, opacity: 0.6 }}>랭킹 데이터 없음</div>
      )}

      {/* 기여곡 Top 5 */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        {isPos ? '강점 기여 Top 5' : '약점 기여 Top 5'}
      </div>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 6, padding: '2px 0', borderBottom: '1px solid rgba(127,127,127,0.3)', opacity: 0.6, fontSize: 11, fontWeight: 600 }}>
          <span style={{ width: 26, flexShrink: 0 }}>lv</span>
          <span style={{ width: 16, flexShrink: 0 }}>diff</span>
          <span style={{ flex: 1, minWidth: 0 }}>곡명</span>
          {!isPos && <span style={{ width: 140, textAlign: 'right', flexShrink: 0 }}>현재 → 목표 EXSCORE</span>}
          <span style={{ width: 64, textAlign: 'right', flexShrink: 0 }}>{isPos ? '득점' : '감점'}</span>
        </div>
        {topContributors.map((c) => {
          const dl = DIFF_SHORT[c.diff] || '?';
          const contribStr = (c.vRel >= 0 ? '+' : '') + c.vRel.toFixed(2) + 'pt';
          const contribColor = c.vRel >= 0 ? '#28a745' : '#dc3545';
          // 약점 feature 의 "현재 → 목표 EXSCORE"
          let targetNode: JSX.Element | null = null;
          if (!isPos) {
            const bucketMean = c.rate - c.residual;
            const nc = noteCountMap.get(c.title + '|' + c.diff);
            if (c.residual < 0 && nc) {
              const maxEx = nc * 2;
              const targetEx = Math.round(bucketMean * maxEx / 100);
              const currentEx = Math.round(c.rate * maxEx / 100);
              const diff = targetEx - currentEx;
              targetNode = <span style={{ width: 140, textAlign: 'right', flexShrink: 0, color: '#28a745', fontSize: 13 }}>
                {currentEx} → {targetEx} <span style={{ color: '#a08585', fontSize: 11 }}>-{diff}</span>
              </span>;
            } else if (c.residual >= 0) {
              targetNode = <span style={{ width: 140, textAlign: 'right', flexShrink: 0, color: '#888', fontSize: 11 }}>
                다른 곡 시도
              </span>;
            } else {
              targetNode = <span style={{ width: 140, textAlign: 'right', flexShrink: 0 }}></span>;
            }
          }
          return (
            <div
              key={c.chartId}
              onClick={() => handlePick(c.title, c.diff)}
              className="analysis-row"
              style={{ display: 'flex', gap: 6, padding: '2px 0', borderBottom: '1px solid rgba(127,127,127,0.15)' }}
            >
              <span style={{ opacity: 0.5, width: 26, flexShrink: 0 }}>lv{c.lv}</span>
              <span style={{ opacity: 0.7, width: 16, flexShrink: 0 }}>{dl}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
              {targetNode}
              <span style={{ width: 64, textAlign: 'right', flexShrink: 0, color: contribColor }}>{contribStr}</span>
            </div>
          );
        })}
      </div>

      {/* 추천곡 Top 5 */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        추천곡 Top 5 ({feat.ko} 강한 곡)
      </div>
      {recommends.length === 0 ? (
        <div style={{ fontSize: 13, opacity: 0.6 }}>추천 곡 없음</div>
      ) : (
        <div style={{ fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 6, padding: '2px 0', borderBottom: '1px solid rgba(127,127,127,0.3)', opacity: 0.6, fontSize: 11, fontWeight: 600 }}>
            <span style={{ width: 26, flexShrink: 0 }}>lv</span>
            <span style={{ width: 16, flexShrink: 0 }}>diff</span>
            <span style={{ flex: 1, minWidth: 0 }}>곡명</span>
            <span style={{ width: 140, textAlign: 'right', flexShrink: 0 }}>현재 → 목표 EXSCORE</span>
            <span style={{ width: 60, textAlign: 'right', flexShrink: 0 }}>득점</span>
          </div>
          {recommends.map((c) => {
            const dl = DIFF_SHORT[c.diff] || '?';
            const nc = noteCountMap.get(c.title + '|' + c.diff);
            let targetCell: JSX.Element;
            if (nc && c.bestTarget != null) {
              const maxEx = nc * 2;
              const targetEx = Math.ceil(maxEx * c.bestTarget / 100);
              const currentEx = Math.round(c.rate * maxEx / 100);
              const diff = targetEx - currentEx;
              const targetColor = c.rate < c.bucketMean ? '#dc3545' : '#28a745';
              targetCell = <span style={{ width: 140, textAlign: 'right', flexShrink: 0, color: targetColor, fontSize: 13 }}>
                {currentEx} → {targetEx} <span style={{ color: '#a08585', fontSize: 11 }}>-{diff}</span>
              </span>;
            } else {
              targetCell = <span style={{ width: 140, textAlign: 'right', flexShrink: 0, color: '#28a745', fontSize: 11 }}>
                {c.rate.toFixed(1)}% → {c.bestTarget?.toFixed(1)}%
              </span>;
            }
            return (
              <div
                key={c.chartId}
                onClick={() => handlePick(c.title, c.diff)}
                className="analysis-row"
                style={{ display: 'flex', gap: 6, padding: '2px 0', borderBottom: '1px solid rgba(127,127,127,0.15)' }}
              >
                <span style={{ opacity: 0.5, width: 26, flexShrink: 0 }}>lv{c.lv}</span>
                <span style={{ opacity: 0.7, width: 16, flexShrink: 0 }}>{dl}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                {targetCell}
                <span style={{ width: 60, textAlign: 'right', flexShrink: 0, color: '#28a745' }}>+{c.bestGain.toFixed(2)}pt</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
