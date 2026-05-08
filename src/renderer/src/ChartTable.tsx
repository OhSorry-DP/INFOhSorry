// 차트 단위 표 — 한 row = 한 난이도 (= 한 차트)
//
// 컬럼 순서: LAMP / LEVEL (난이도 색상) / 곡명 / NOTES / DJ+EX+Rate / MISS
//
// SP 모드: SP_SLOTS (B/N/H/A/L) 의 모든 차트
// DP 모드: DP_SLOTS (N/H/A/L) 의 모든 차트
//
// rate (%) = exScore / (noteCount * 2) * 100  — max EX 대비 퍼센트
import { useMemo } from 'react';
import type { ChartSlot, SongChart, SongRow } from '../../shared/types';
import { DP_SLOTS, SP_SLOTS, extractCharts } from '../../shared/types';
import { lampStyle, letterColor } from './lampStyle';

interface Props {
  rows: SongRow[];
  style: 'sp' | 'dp';
}

const SLOT_COLOR: Record<ChartSlot, string> = {
  SPB: '#5cad4c',
  SPN: '#1971c2',
  SPH: '#dcaf45',
  SPA: '#dc3545',
  SPL: '#d678c8',
  DPN: '#1971c2',
  DPH: '#dcaf45',
  DPA: '#dc3545',
  DPL: '#d678c8',
};

const SLOT_SHORT: Record<ChartSlot, string> = {
  SPB: 'B',
  SPN: 'N',
  SPH: 'H',
  SPA: 'A',
  SPL: 'L',
  DPN: 'N',
  DPH: 'H',
  DPA: 'A',
  DPL: 'L',
};

export default function ChartTable({ rows, style }: Props) {
  // 곡 단위 → 차트 단위 평탄화. 모든 레벨 (level filter X).
  const charts = useMemo(
    () => extractCharts(rows, { slots: style === 'sp' ? SP_SLOTS : DP_SLOTS }),
    [rows, style],
  );

  // 정렬: 곡명 → slot 강함 순 (B→N→H→A→L)
  const sortOrder: ChartSlot[] = style === 'sp' ? SP_SLOTS : DP_SLOTS;
  const slotIdx = new Map(sortOrder.map((s, i) => [s, i] as const));
  const sorted = useMemo(
    () =>
      [...charts].sort((a, b) => {
        const t = a.title.localeCompare(b.title);
        if (t !== 0) return t;
        return (slotIdx.get(a.slot) ?? 99) - (slotIdx.get(b.slot) ?? 99);
      }),
    [charts, slotIdx],
  );

  return (
    <div className="ct-table">
      <div className="ct-thead">
        <div>LAMP</div>
        <div>LEVEL</div>
        <div>곡명</div>
        <div className="num">NOTES</div>
        <div>DJ · EX · RATE</div>
        <div className="num">MISS</div>
      </div>
      {sorted.map((c, i) => (
        <ChartRow key={`${c.title}|${c.slot}|${i}`} c={c} />
      ))}
    </div>
  );
}

function ChartRow({ c }: { c: SongChart }) {
  const ls = lampStyle(c.lamp);
  const slotColor = SLOT_COLOR[c.slot];
  const slotShort = SLOT_SHORT[c.slot];
  const locked = !c.unlocked;
  const played = c.lamp !== 'NP' && !locked;

  // rate = EX / (noteCount * 2) * 100
  const maxEx = c.noteCount * 2;
  const rate = played && maxEx > 0 ? (c.exScore / maxEx) * 100 : null;

  return (
    <div className={`ct-tr${locked ? ' locked' : ''}`}>
      <div
        className="ct-cell ct-lamp"
        style={played ? { color: ls.color, background: ls.bg } : undefined}
      >
        {locked ? '잠김' : ls.label}
      </div>
      <div className="ct-cell ct-level">
        <span style={{ color: slotColor, fontWeight: 700 }}>
          {slotShort} {c.level || '-'}
        </span>
      </div>
      <div className="ct-cell ct-title" title={c.title}>
        {c.title}
      </div>
      <div className="ct-cell num">{c.noteCount > 0 ? c.noteCount.toLocaleString() : '-'}</div>
      <div className="ct-cell ct-dj">
        {played ? (
          <>
            <span className="ct-letter" style={{ color: letterColor(c.letter) }}>
              {c.letter || '-'}
            </span>
            <span className="ct-ex">{c.exScore > 0 ? c.exScore.toLocaleString() : '-'}</span>
            <span className="ct-rate">{rate != null ? `${rate.toFixed(2)}%` : '-'}</span>
          </>
        ) : (
          <span className="ct-empty">-</span>
        )}
      </div>
      <div className="ct-cell num">
        {played && c.missCount >= 0 ? c.missCount.toLocaleString() : '-'}
      </div>
    </div>
  );
}
