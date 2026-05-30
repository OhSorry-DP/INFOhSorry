// RecommendByCore — ohSorry 본체 recommend.js 의 buildRecs / buildWeaknessRecs 결과를 INFOhSorry 에서 표시.
//
// 4 stage 카드:
//   - EASY 클리어 추천 (threshold=3, ec)
//   - HARD 클리어 추천 (threshold=5, hc)
//   - EX HARD 클리어 추천 (threshold=6, exh)
//   - 연습곡 (약점 기반, buildWeaknessRecs)
//
// 각 row: lamp 색박스 / LV+diff / 곡명 (클릭 → 클립보드) / 배치 배지 (bestLabel) / ★ 또는 목표 / 해시태그 줄.
// "배치 ON/OFF" 토글 — recommend.js 의 setLayoutMode 호출.
//
// 데이터 흐름:
//   1. lib fetch (mount 시 1회, module global cache)
//   2. ctx 생성 (rows/rating/zasa/ereter 변경 시 useMemo)
//   3. ctx.buildRecs / buildWeaknessRecs 호출 (baseStar / layoutMode 변경 시 useMemo)
//   4. RecRow 그대로 받아 표시
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SongRow, RatingData, ZasaData, EreterData } from '../../shared/types';
import { copyToClipboard } from './ChartTable';
import { loadRecLibs, createRecCtx, type RecRow, type RecCoreLibs } from './recommendCore';

// 채보 정체성 색 (PlayData 와 동일).
const DIFF_COLOR: Record<string, string> = {
  NORMAL: '#74c0fc', HYPER: '#efef51', ANOTHER: '#fba8c1', LEGGENDARIA: '#ce8ef9',
};
// lampNum → 약어 (.ct-lamp-XX 클래스 키).
const LAMP_NUM_TO_ABBR: Record<number, string> = {
  0: 'NP', 1: 'F', 2: 'AC', 3: 'EC', 4: 'NC', 5: 'HC', 6: 'EX', 7: 'FC',
};

interface Props {
  rows: SongRow[];
  ratingData: RatingData | null;
  zasaData: ZasaData | null;
  ereterData: EreterData | null;
  baseStar: number | null;          // INFOhSorry 의 본인 ★ (ohsorryRecBase)
}

export default function RecommendByCore({ rows, ratingData, zasaData, ereterData, baseStar }: Props): JSX.Element {
  const [libsReady, setLibsReady] = useState(false);
  const libsRef = useRef<RecCoreLibs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<'on' | 'off'>('on');

  // 1. lib fetch
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const libs = await loadRecLibs();
        if (cancelled) return;
        libsRef.current = libs;
        setLibsReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 2. ctx — rows / rating / zasa / ereter 변경 시 재계산.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = useMemo<any>(() => {
    if (!libsReady || !libsRef.current) return null;
    if (rows.length === 0) return null;
    try {
      return createRecCtx({
        libs: libsRef.current,
        rows, ratingData, zasaData, ereterData,
      });
    } catch (e) {
      console.warn('[RecommendByCore] ctx 생성 실패:', e);
      return null;
    }
  }, [libsReady, rows, ratingData, zasaData, ereterData]);

  // 3. 추천 결과 — baseStar / layoutMode 변경 시 재계산.
  const recs = useMemo(() => {
    if (!ctx) return null;
    ctx.setLayoutMode(layoutMode);
    const recLevelMode = 'all';
    const djMode: 'on' | 'off' = 'off';
    const ecBase = baseStar != null ? baseStar : 0.3;
    const ec = ctx.buildRecs(3, 'ec', ecBase, recLevelMode, djMode) as RecRow[];
    const hc = baseStar != null && baseStar >= 0.5
      ? (ctx.buildRecs(5, 'hc', baseStar, recLevelMode, djMode) as RecRow[]) : [];
    const exh = baseStar != null && baseStar >= 0.5
      ? (ctx.buildRecs(6, 'exh', baseStar, recLevelMode, djMode) as RecRow[]) : [];
    const weak = ctx.buildWeaknessRecs(baseStar ?? 11, {
      flipOn: true, handMode: 'both', mode: 'all', topN: 5, strength: 1,
    }) as RecRow[];
    return { ec, hc, exh, weak };
  }, [ctx, baseStar, layoutMode]);

  if (error) return <p className="wr-empty">오류: {error}</p>;
  if (!libsReady) return <p className="wr-empty">추천 lib 로딩 중...</p>;
  if (!ctx) return <p className="wr-empty">분석 데이터 부족</p>;
  if (!recs) return <p className="wr-empty">추천 계산 중...</p>;

  return (
    <div className="wr-wrap">
      <div className="wr-header">
        <h2 className="wr-title">오소리 추천</h2>
        <span className="wr-hint">
          {baseStar != null && <>본인 ★ <b>{baseStar.toFixed(2)}</b>{' · '}</>}
          recommend.js (gist) 호출 — ohSorry 본체와 동일 알고리즘
        </span>
        <button
          type="button"
          className={`__uprofile_pdtoggle __pd_layoutbtn${layoutMode === 'on' ? ' active' : ''}`}
          onClick={() => setLayoutMode((m) => (m === 'on' ? 'off' : 'on'))}
          title="배치 추천 토글 — ON 이면 8 배치 best, OFF 면 정규 N/N 강제"
        >
          배치 {layoutMode === 'on' ? 'ON' : 'OFF'}
        </button>
      </div>
      <StageCard title="EASY 클리어 추천" rows={recs.ec} />
      {recs.hc.length > 0 && <StageCard title="HARD 클리어 추천" rows={recs.hc} />}
      {recs.exh.length > 0 && <StageCard title="EX HARD 클리어 추천" rows={recs.exh} />}
      <StageCard title="연습곡 (약점 기반)" rows={recs.weak} />
    </div>
  );
}

function StageCard({ title, rows }: { title: string; rows: RecRow[] }): JSX.Element {
  return (
    <div className="wr-card">
      <div className="wr-card-header">
        <span className="wr-feat-name">{title}</span>
        <span className="wr-summary">{rows.length}곡</span>
      </div>
      {rows.length === 0 ? (
        <p className="wr-card-empty">추천 없음</p>
      ) : (
        <div className="wr-rec-list">
          {rows.map((r) => (
            <RecRowItem key={r.title + '|' + r.chart} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecRowItem({ r }: { r: RecRow }): JSX.Element {
  const slotColor = DIFF_COLOR[r.chart] || '#888';
  const lampAbbr = r.lampNum != null ? LAMP_NUM_TO_ABBR[r.lampNum] || 'NP' : 'NP';
  const isLeg = r.chart === 'LEGGENDARIA';
  const diffShort = r.chart === 'NORMAL' ? 'N' : r.chart === 'HYPER' ? 'H' : r.chart === 'ANOTHER' ? 'A' : 'L';
  const bestLabel = (r._matchByHand?.bestLabel as string) || '';
  const hashtagsLine = Array.isArray(r._hashtags) ? r._hashtags.join(' ') : '';
  const goalLine = r._currentExScore != null && r._targetExScore != null
    ? `${r._currentExScore} → ${r._targetExScore}${r._targetDjLevel ? ' (' + r._targetDjLevel + ')' : ''}`
    : '';
  // 표시할 ★ — 연습곡 (_category='weakness') 면 zasa★, 그 외 stage 면 diffValue (estEc/Hc/Exh).
  const isWeakness = r._category === 'weakness';
  const starLabel = isWeakness ? `☆${r.level.toFixed(1)}` : `★${r.diffValue.toFixed(2)}`;
  return (
    <div className="wr-rec-row">
      <span className={`wr-rec-lamp ct-lamp-${lampAbbr}`} title={lampAbbr} />
      <span className="wr-rec-lv" style={{ color: slotColor }}>
        {r.gameLevel ?? '-'}{diffShort}
      </span>
      <span
        className="wr-rec-title"
        title={`${r.title}\n(클릭하면 곡명 클립보드 복사)`}
        style={isLeg ? { color: slotColor } : undefined}
        onClick={() => { void copyToClipboard(r.title); }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void copyToClipboard(r.title);
          }
        }}
      >
        {isLeg ? '† ' : ''}{r.title}
      </span>
      {bestLabel && <span className="wr-rec-layout">{bestLabel}</span>}
      <span className="wr-rec-rate">{starLabel}</span>
      {(hashtagsLine || goalLine) && (
        <div className="wr-rec-tagrow">
          {hashtagsLine && <span>{hashtagsLine}</span>}
          {goalLine && <span className="wr-rec-goal">{goalLine}</span>}
        </div>
      )}
    </div>
  );
}
