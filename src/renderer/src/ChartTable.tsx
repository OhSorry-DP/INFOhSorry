// 곡 row + 각 차트 slot 셀로 구성된 표
//
// SP 모드: 5 슬롯 (B/N/H/A/L)
// DP 모드: 4 슬롯 (N/H/A/L)
import { useMemo } from 'react';
import type { ChartCell, ChartSlot, SongRow } from '../../shared/types';
import { SP_SLOTS, DP_SLOTS } from '../../shared/types';
import { lampStyle, letterColor } from './lampStyle';

interface Props {
  rows: SongRow[];
  style: 'sp' | 'dp';
}

const SLOT_LABELS: Record<ChartSlot, string> = {
  SPB: 'BEGINNER',
  SPN: 'NORMAL',
  SPH: 'HYPER',
  SPA: 'ANOTHER',
  SPL: 'LEGGENDARIA',
  DPN: 'NORMAL',
  DPH: 'HYPER',
  DPA: 'ANOTHER',
  DPL: 'LEGGENDARIA',
};

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

function ChartCellView({ cell }: { cell: ChartCell | undefined }) {
  if (!cell) {
    return <div className="cell empty">-</div>;
  }
  if (!cell.unlocked) {
    return <div className="cell locked">잠김</div>;
  }
  // unlocked 됐는데 점수 없음 (NP) → lamp 만 표시, 옅게
  const ls = lampStyle(cell.lamp);
  const hasPlayed = cell.lamp && cell.lamp !== 'NP';
  return (
    <div className="cell" style={{ background: ls.bg }}>
      <div className="lamp" style={{ color: ls.color }}>
        {ls.label}
      </div>
      {hasPlayed && (
        <>
          <div className="score">
            {cell.letter && (
              <span className="letter" style={{ color: letterColor(cell.letter) }}>
                {cell.letter}
              </span>
            )}
            {cell.exScore > 0 && <span className="ex">{cell.exScore.toLocaleString()}</span>}
          </div>
          {cell.noteCount > 0 && (
            <div className="miss">
              miss {cell.missCount} / {cell.noteCount}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ChartTable({ rows, style }: Props) {
  const slots = useMemo(() => (style === 'sp' ? SP_SLOTS : DP_SLOTS), [style]);

  // 곡 정렬: title 기준 (한글/영문/일문 혼재 가능, 단순 localeCompare)
  const sorted = useMemo(() => [...rows].sort((a, b) => a.title.localeCompare(b.title)), [rows]);

  return (
    <div className="chart-table">
      <div className="thead">
        <div className="th title-col">곡명</div>
        {slots.map((s) => (
          <div key={s} className="th" style={{ borderTop: `2px solid ${SLOT_COLOR[s]}` }}>
            {SLOT_LABELS[s]}
          </div>
        ))}
      </div>
      <div className="tbody">
        {sorted.map((song) => (
          <div key={song.title} className="tr">
            <div className="title-col">{song.title}</div>
            {slots.map((s) => (
              <ChartCellView key={s} cell={song.charts[s]} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
