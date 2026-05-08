// 차트 단위 표 — 한 row = 한 난이도 (= 한 차트)
//
// 컬럼: LAMP / LEVEL / 곡명 / NOTES / DJ Level / EX Score / MISS
// 헤더 클릭 → asc → desc → unsorted (default 정렬) cycle
import { useMemo, useState } from 'react';
import type { ChartSlot, SongChart, SongRow } from '../../shared/types';
import { DP_SLOTS, SP_SLOTS, extractCharts } from '../../shared/types';
import { lampNum } from '../../shared/match';
import { lampStyle } from './lampStyle';

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

type SortKey = 'lamp' | 'level' | 'title' | 'notes' | 'rate' | 'ex' | 'miss';
type SortDir = 'asc' | 'desc';

// id 는 React key 용 (lamp 컬럼이 두 군데라 unique 식별 필요)
const COLUMNS: { id: string; key: SortKey | null; label: string; numeric?: boolean }[] = [
  { id: 'lamp-color', key: 'lamp', label: '' },
  { id: 'level', key: 'level', label: 'Lv' },
  { id: 'title', key: 'title', label: '곡명' },
  { id: 'notes', key: 'notes', label: 'NOTES', numeric: true },
  { id: 'lamp-text', key: 'lamp', label: 'LAMP' },
  { id: 'rate', key: 'rate', label: 'RATE' },
  { id: 'ex', key: 'ex', label: 'EX Score', numeric: true },
  { id: 'miss', key: 'miss', label: 'MISS', numeric: true },
];

// DJ Level 커트라인 (EX score / max EX 비율) — 막대 위 세로줄 위치
const RATE_CUTS = [
  { name: 'A', pct: 6 / 9 },
  { name: 'AA', pct: 7 / 9 },
  { name: 'AAA', pct: 8 / 9 },
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
        case 'rate': {
          const ra = a.noteCount > 0 ? a.exScore / (a.noteCount * 2) : 0;
          const rb = b.noteCount > 0 ? b.exScore / (b.noteCount * 2) : 0;
          v = ra - rb;
          break;
        }
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
              key={col.id}
              className={`ct-th${col.numeric ? ' num' : ''}${active ? ' active' : ''}`}
              onClick={() => clickSort(col.key)}
            >
              <span>{col.label}</span>
              {arrow && <span className="ct-arrow">{arrow}</span>}
            </div>
          );
        })}
      </div>
      <div className="ct-tbody">
        {sorted.map((c, i) => (
          <ChartRow key={`${c.title}|${c.slot}|${i}`} c={c} />
        ))}
      </div>
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
        className={`ct-cell ct-lamp${locked ? '' : ` ct-lamp-${c.lamp}`}`}
        title={locked ? '잠김' : ls.label}
      />

      <div className="ct-cell ct-level">
        <span style={{ color: slotColor, fontWeight: 700 }}>{c.level || '-'}</span>
      </div>
      <div
        className="ct-cell ct-title"
        title={c.title}
        // LEGGENDARIA 차트는 곡명 앞에 † + 마젠타 색
        style={c.slot === 'SPL' || c.slot === 'DPL' ? { color: slotColor } : undefined}
      >
        {(c.slot === 'SPL' || c.slot === 'DPL' ? '† ' : '') + c.title}
      </div>
      <div className="ct-cell num">{c.noteCount > 0 ? c.noteCount.toLocaleString() : '-'}</div>
      <div className="ct-cell ct-lamp-text">
        {locked ? (
          <span className="ct-empty">잠김</span>
        ) : (
          <span style={{ color: ls.color, fontWeight: 700 }}>{ls.label}</span>
        )}
      </div>
      <div className="ct-cell ct-rate-bar">
        {played && c.noteCount > 0 ? (
          (() => {
            const rate = c.exScore / (c.noteCount * 2);
            const pct = Math.max(0, Math.min(1, rate)) * 100;
            return (
              <>
                <div className="rate-bg" />
                <div className="rate-fill" style={{ width: `${pct}%` }} />
                {RATE_CUTS.map((cut) => (
                  <div
                    key={cut.name}
                    className="rate-cut"
                    style={{ left: `${cut.pct * 100}%` }}
                    title={`${cut.name} 커트라인 (${(cut.pct * 100).toFixed(2)}%)`}
                  />
                ))}
                <span className="rate-text">
                  <span className="rate-letter">{c.letter || '-'}</span>
                  <span className="rate-pct">({(rate * 100).toFixed(2)}%)</span>
                </span>
              </>
            );
          })()
        ) : (
          <span className="ct-empty rate-empty">-</span>
        )}
      </div>
      <div className="ct-cell num">{played && c.exScore > 0 ? c.exScore.toLocaleString() : '-'}</div>
      <div className="ct-cell num">
        {played && c.missCount >= 0 ? c.missCount.toLocaleString() : '-'}
      </div>
    </div>
  );
}
