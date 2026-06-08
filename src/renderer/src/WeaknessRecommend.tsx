// WeaknessRecommend 탭 — 오소리웹/오소리코어의 약점 기반 추천 포팅.
//
// 흐름 (calcOhsorryCore 의 추천 풀 생성 로직 그대로):
//   1. calcWeakness lib + patterns + rateRef gist fetch (PlayData 와 같은 module global cache 활용)
//   2. user vec 계산 (calcUserWeakness)
//   3. 10 feature (NOTES, CHORD, PEAK, CHARGE, SCRATCH, SOF-LAN, PHRASE, JACK, TRILL, RAND) 각각 analyzeFeature 호출
//   4. value asc (약점 → 강점 순) 정렬 → 카드
//   5. 각 추천곡에 chartStrengthMatch8Way 의 bestLabel 부착 (배치 추천)
//
// 데이터 source:
//   rows (TSV) + ratingData (ohSorryRating) + zasaData (zasa-data) + baseStar (본인 ★).
//   baseStar 없으면 모든 차트 후보 (오소리코어 default).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SongRow, RatingData, ZasaData, ChartSlot } from '../../shared/types';
import { copyToClipboard } from './ChartTable';

// ─── gist URL (Analysis / PlayData 와 동일) ────────────────────────────
const GIST_RAW = 'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw';
const CALC_WEAKNESS_URL = `${GIST_RAW}/calcWeakness.js`;
const NORM_TITLE_URL = `${GIST_RAW}/normTitle.js`;
// 평소 11·12 만 fetch (7MB→1.8MB). 약점 추천은 고렙 기준이라 1112 로 충분.
const PATTERNS_URL = `${GIST_RAW}/patterns-dp-1112.json`;
const RATE_REF_URL = `${GIST_RAW}/rate-reference-slim.json`;

const OS_FEATS = [
  'NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH',
  'SOF-LAN', 'PHRASE', 'JACK', 'TRILL', 'RAND',
] as const;
// chartName (calcWeakness 내부 키) → 사용자 표시 diff 문자열.
const CHART_TO_DIFF: Record<string, string> = {
  DP_NOR: 'NORMAL', DP_HYP: 'HYPER', DP_ANO: 'ANOTHER', DP_LEG: 'LEGGENDARIA',
};
// 채보 정체성 색 (PlayData 와 동일).
const DIFF_COLOR: Record<string, string> = {
  NORMAL: '#74c0fc', HYPER: '#efef51', ANOTHER: '#fba8c1', LEGGENDARIA: '#ce8ef9',
};
// lampNum → 약어 (.ct-lamp-XX 클래스 키).
const LAMP_NUM_TO_ABBR: Record<number, string> = {
  0: 'NP', 1: 'F', 2: 'AC', 3: 'EC', 4: 'NC', 5: 'HC', 6: 'EX', 7: 'FC',
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLib = any;

// SongRow → calcWeakness charts (DP slot 만, noteCount > 0 인 차트).
const SLOT_TO_DIFF_KEY: Record<string, string> = {
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};
const LAMP_TO_NUM: Record<string, number> = {
  NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7,
};
function rowsToWeaknessCharts(rows: SongRow[]): {
  title: string; diff: string; exScore: number; noteCount: number;
  scorePercent: number; lampNum: number;
}[] {
  const out: { title: string; diff: string; exScore: number; noteCount: number; scorePercent: number; lampNum: number }[] = [];
  for (const r of rows) {
    for (const slot of ['DPN', 'DPH', 'DPA', 'DPL'] as ChartSlot[]) {
      const c = r.charts[slot];
      if (!c) continue;
      const diff = SLOT_TO_DIFF_KEY[slot];
      if (!diff) continue;
      if (!c.noteCount || c.noteCount <= 0) continue;
      out.push({
        title: r.title, diff,
        exScore: c.exScore || 0,
        noteCount: c.noteCount,
        scorePercent: ((c.exScore || 0) / (c.noteCount * 2)) * 100,
        lampNum: LAMP_TO_NUM[c.lamp] ?? 0,
      });
    }
  }
  return out;
}

// analyzeFeature 결과 — calcWeakness 가 반환하는 형식.
interface RecChart {
  songId: string;
  chartName: string;
  title: string;
  lv: number;
  pt: number;
  rate: number | null;        // 본인 점수 percentage (없으면 미플레이 = null)
  lampNum: number | null;
  djLevel: string | null;
  isNp: boolean;
  bucketMean: number | null;
  // 본 컴포넌트에서 추가: chartStrengthMatch8Way bestLabel
  bestLabel?: string;
}
interface FeatureResult {
  feat: string;
  value: number;              // -1~1 (음수 = 약점)
  isStrength: boolean;
  summary: { strongAvg: number; allAvg: number; gap: number; n: number };
  recommends: RecChart[];
}

interface Props {
  rows: SongRow[];
  ratingData: RatingData | null;
  zasaData: ZasaData | null;
  // 본인 실력 ★ — analyzeFeature 의 baseStar ± rangeN 범위 비교에 사용. null 이면 범위 skip (모든 차트 후보).
  baseStar: number | null;
}

export default function WeaknessRecommend({ rows, ratingData, zasaData, baseStar }: Props): JSX.Element {
  const [libsReady, setLibsReady] = useState(false);
  const libsRef = useRef<{ weakness?: AnyLib; norm?: AnyLib; patterns?: AnyLib; rateRef?: AnyLib }>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [weakness, normLib, patterns, rateRef] = await Promise.all([
          loadGistModule(CALC_WEAKNESS_URL, 'OhsorryWeakness'),
          loadGistModule(NORM_TITLE_URL, 'OhsorryNorm'),
          loadJson(PATTERNS_URL),
          loadJson(RATE_REF_URL),
        ]);
        if (cancelled) return;
        libsRef.current = { weakness, norm: normLib, patterns, rateRef };
        setLibsReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // user vec 계산 — TSV charts + rating + zasa + patterns. rows/rating/zasa 변경 시 재계산.
  const userVec = useMemo<AnyLib | null>(() => {
    if (!libsReady) return null;
    const libs = libsRef.current;
    if (!libs.weakness || !libs.norm || !libs.patterns) return null;
    const wCharts = rowsToWeaknessCharts(rows);
    if (wCharts.length === 0) return null;
    try {
      const v = libs.weakness.calcUserWeakness({
        allCharts: wCharts,
        patternsMap: libs.patterns,
        normFn: libs.norm.norm,
        ratingMap: ratingData?.ratings || null,
        zasaMap: zasaData?.charts || null,
        rateRef: libs.rateRef,
      });
      if (!v || !v.__entries) return null;
      return v;
    } catch (e) {
      console.warn('[WeaknessRecommend] calcUserWeakness 실패:', (e as Error).message);
      return null;
    }
  }, [libsReady, rows, ratingData, zasaData]);

  // 10 feature 분석 결과 — value asc (약점 → 강점). 각 추천곡에 bestLabel 부착.
  const featureResults = useMemo<FeatureResult[]>(() => {
    if (!libsReady || !userVec) return [];
    const libs = libsRef.current;
    if (!libs.weakness || !libs.patterns || !libs.norm) return [];
    const wCharts = rowsToWeaknessCharts(rows);
    const ratingMap = ratingData?.ratings || null;
    const zasaMap = zasaData?.charts || null;
    const results: FeatureResult[] = [];
    for (const feat of OS_FEATS) {
      try {
        const r = libs.weakness.analyzeFeature({
          feat, allCharts: wCharts,
          patternsMap: libs.patterns,
          normFn: libs.norm.norm,
          userVec, ratingMap, zasaMap,
          rateRef: libs.rateRef,
          baseStar,
          rangeN: 1,
          topN: 10,
        }) as FeatureResult | null;
        if (!r) continue;
        // 각 추천곡에 chartStrengthMatch8Way 호출 → bestLabel 부착.
        for (const rec of r.recommends) {
          const sp = libs.patterns[rec.songId];
          if (!sp?.c?.[rec.chartName]) continue;
          try {
            const m = libs.weakness.chartStrengthMatch8Way(sp.c[rec.chartName], userVec);
            rec.bestLabel = (m?.bestLabel as string) || '';
          } catch { /* graceful skip */ }
        }
        results.push(r);
      } catch (e) {
        console.warn(`[WeaknessRecommend] analyzeFeature ${feat} 실패:`, (e as Error).message);
      }
    }
    // 약점 → 강점 순 (value asc — 가장 약한 거 먼저).
    results.sort((a, b) => a.value - b.value);
    return results;
  }, [libsReady, userVec, rows, ratingData, zasaData, baseStar]);

  if (error) return <p className="wr-empty">오류: {error}</p>;
  if (!libsReady) return <p className="wr-empty">추천 lib 로딩 중...</p>;
  if (!userVec) {
    return <p className="wr-empty">분석 데이터 부족 (lv11+12 차트 약 30곡 이상 필요)</p>;
  }

  return (
    <div className="wr-wrap">
      <h2 className="wr-title">약점 기반 추천</h2>
      <p className="wr-hint">
        오소리코어의 약점 분석. feature 별 가장 약한 순서로 표시. 각 row 의 핑크 배지는 추천 배치 (chartStrengthMatch8Way bestLabel).
        {baseStar != null && (
          <>{' '}본인 ★ <b>{baseStar.toFixed(2)}</b> ± 1 범위 곡만.</>
        )}
      </p>
      {featureResults.map((r) => (
        <FeatureCard key={r.feat} r={r} />
      ))}
    </div>
  );
}

// ─── feature 카드 ────────────────────────────────────────────────────
function FeatureCard({ r }: { r: FeatureResult }): JSX.Element {
  const valueLabel = `${r.value >= 0 ? '+' : ''}${r.value.toFixed(2)}`;
  return (
    <div className={`wr-card${r.isStrength ? ' wr-strength' : ' wr-weak'}`}>
      <div className="wr-card-header">
        <span className="wr-feat-name">{r.feat}</span>
        <span className={`wr-feat-value ${r.isStrength ? 'wr-strength-val' : 'wr-weak-val'}`}>
          {valueLabel}
        </span>
        <span className="wr-summary">
          잘 친 곡 {r.summary.strongAvg}% · 전체 {r.summary.allAvg}% · gap {r.summary.gap >= 0 ? '+' : ''}{r.summary.gap}%
          {' · '}n={r.summary.n}
        </span>
      </div>
      {r.recommends.length === 0 ? (
        <p className="wr-card-empty">추천 곡 없음 (★ 범위 / pt 조건 미충족)</p>
      ) : (
        <div className="wr-rec-list">
          {r.recommends.slice(0, 5).map((rec) => (
            <RecRow key={rec.songId + '|' + rec.chartName} rec={rec} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecRow({ rec }: { rec: RecChart }): JSX.Element {
  const diff = CHART_TO_DIFF[rec.chartName] || rec.chartName;
  const slotColor = DIFF_COLOR[diff] || '#888';
  const lampAbbr = rec.lampNum != null ? LAMP_NUM_TO_ABBR[rec.lampNum] || 'NP' : 'NP';
  const rateLabel = rec.rate != null ? `${rec.rate.toFixed(1)}%` : '미플레이';
  const isLeg = diff === 'LEGGENDARIA';
  const diffShort = diff === 'NORMAL' ? 'N' : diff === 'HYPER' ? 'H' : diff === 'ANOTHER' ? 'A' : 'L';
  return (
    <div className="wr-rec-row">
      <span className={`wr-rec-lamp ct-lamp-${lampAbbr}`} title={lampAbbr} />
      <span className="wr-rec-lv" style={{ color: slotColor }}>
        {rec.lv ?? '-'}{diffShort}
      </span>
      <span
        className="wr-rec-title"
        title={`${rec.title}\n(클릭하면 곡명 클립보드 복사)`}
        style={isLeg ? { color: slotColor } : undefined}
        onClick={() => { void copyToClipboard(rec.title); }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void copyToClipboard(rec.title);
          }
        }}
      >
        {isLeg ? '† ' : ''}{rec.title}
      </span>
      {rec.bestLabel && (
        <span className="wr-rec-layout">{rec.bestLabel}</span>
      )}
      <span className="wr-rec-rate">{rateLabel}</span>
    </div>
  );
}
