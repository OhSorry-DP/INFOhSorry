// 차트 단위 표 — 한 row = 한 난이도 (= 한 차트)
//
// 컬럼: LAMP / LEVEL / 곡명 / NOTES / DJ Level / EX Score / MISS
// 헤더 클릭 → asc → desc → unsorted (default 정렬) cycle
import { useMemo, useState } from 'react';
import type { ChartSlot, SongChart, SongRow } from '../../shared/types';
import { DP_SLOTS, SP_SLOTS, extractCharts } from '../../shared/types';
import { lampNum } from '../../shared/match';
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

// DJ Level 랭킹 (높을수록 위)
const LETTER_RANK: Record<string, number> = {
  AAA: 7,
  AA: 6,
  A: 5,
  B: 4,
  C: 3,
  D: 2,
  E: 1,
  F: 0,
};

type SortKey = 'lamp' | 'level' | 'title' | 'notes' | 'letter' | 'ex' | 'miss';
type SortDir = 'asc' | 'desc';

const COLUMNS: { key: SortKey | null; label: string; numeric?: boolean }[] = [
  { key: 'lamp', label: 'LAMP' },
  { key: 'level', label: 'LEVEL' },
  { key: 'title', label: '곡명' },
  { key: 'notes', label: 'NOTES', numeric: true },
  { key: 'letter', label: 'DJ Level' },
  { key: 'ex', label: 'EX Score', numeric: true },
  { key: 'miss', label: 'MISS', numeric: true },
];

export default function ChartTable({ rows, style }: Props) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const charts = useMemo(
    () => extractCharts(rows, { slots: style === 'sp' ? SP_SLOTS : DP_SLOTS }),
    [rows, style],
  );

  const sortOrder: ChartSlot[] = style === 'sp' ? SP_SLOTS : DP_SLOTS;
  const slotIdx = useMemo(() => new Map(sortOrder.map((s, i) => [s, i] as const)), [sortOrder]);

  const sorted = useMemo(() => {
    const arr = [...charts];
    if (!sortKey) {
      // default: 곡명 → slot
      return arr.sort((a, b) => {
        const t = a.title.localeCompare(b.title);
        if (t !== 0) return t;
        return (slotIdx.get(a.slot) ?? 99) - (slotIdx.get(b.slot) ?? 99);
      });
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    return arr.sort((a, b) => {
      let v = 0;
      switch (sortKey) {
        case 'lamp':
          v = lampNum(a.lamp) - lampNum(b.lamp);
          break;
        case 'level':
          v = a.level - b.level;
          if (v === 0) v = (slotIdx.get(a.slot) ?? 99) - (slotIdx.get(b.slot) ?? 99);
          break;
        case 'title':
          v = a.title.localeCompare(b.title);
          break;
        case 'notes':
          v = a.noteCount - b.noteCount;
          break;
        case 'letter':
          v = (LETTER_RANK[a.letter] ?? -1) - (LETTER_RANK[b.letter] ?? -1);
          break;
        case 'ex':
          v = a.exScore - b.exScore;
          break;
        case 'miss':
          v = a.missCount - b.missCount;
          break;
      }
      if (v === 0) v = a.title.localeCompare(b.title);
      return v * dir;
    });
  }, [charts, sortKey, sortDir, slotIdx]);

  function clickSort(key: SortKey | null): void {
    if (key == null) return;
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else {
        setSortKey(null);
        setSortDir('asc');
      }
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  return (
    <div className="ct-table">
      <div className="ct-thead">
        {COLUMNS.map((col) => {
          const active = sortKey === col.key;
          const arrow = active ? (sortDir === 'asc' ? '▲' : '▼') : '';
          return (
            <div
              key={col.label}
              className={`ct-th${col.numeric ? ' num' : ''}${active ? ' active' : ''}`}
              onClick={() => clickSort(col.key)}
            >
              <span>{col.label}</span>
              {arrow && <span className="ct-arrow">{arrow}</span>}
            </div>
          );
        })}
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
  const locked = !c.unlocked;
  const played = c.lamp !== 'NP' && !locked;

  return (
    <div className={`ct-tr${locked ? ' locked' : ''}`}>
      <div
        className="ct-cell ct-lamp"
        title={locked ? '잠김' : ls.label}
        style={
          locked
            ? undefined
            : c.lamp === 'NP'
            ? undefined
            : { background: ls.color }
        }
      />

      <div className="ct-cell ct-level">
        <span style={{ color: slotColor, fontWeight: 700 }}>{c.level || '-'}</span>
      </div>
      <div
        className="ct-cell ct-title"
        title={c.title}
        // LEGGENDARIA 차트는 곡명도 연한 마젠타 색
        style={c.slot === 'SPL' || c.slot === 'DPL' ? { color: slotColor } : undefined}
      >
        {c.title}
      </div>
      <div className="ct-cell num">{c.noteCount > 0 ? c.noteCount.toLocaleString() : '-'}</div>
      <div className="ct-cell ct-letter">
        {played && c.letter ? (
          <span style={{ color: letterColor(c.letter), fontWeight: 700 }}>{c.letter}</span>
        ) : (
          <span className="ct-empty">-</span>
        )}
      </div>
      <div className="ct-cell num">{played && c.exScore > 0 ? c.exScore.toLocaleString() : '-'}</div>
      <div className="ct-cell num">
        {played && c.missCount >= 0 ? c.missCount.toLocaleString() : '-'}
      </div>
    </div>
  );
}
