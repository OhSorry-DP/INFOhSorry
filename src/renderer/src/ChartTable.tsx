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

const ALL_LAMPS: string[] = ['NP', 'F', 'AC', 'EC', 'NC', 'HC', 'EX', 'FC', 'PFC'];
const ALL_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// id 는 React key 용 (lamp 컬럼이 두 군데라 unique 식별 필요)
const COLUMNS: { id: string; key: SortKey | null; label: string; numeric?: boolean }[] = [
  { id: 'lamp-color', key: 'lamp', label: '' },
  { id: 'level', key: 'level', label: 'LV' },
  { id: 'title', key: 'title', label: '곡명' },
  { id: 'notes', key: 'notes', label: 'NOTES', numeric: true },
  { id: 'lamp-text', key: 'lamp', label: 'LAMP' },
  { id: 'rate', key: 'rate', label: 'RATE' },
  { id: 'ex', key: 'ex', label: 'SCORE', numeric: true },
  { id: 'miss', key: 'miss', label: 'MISS', numeric: true },
];

// DJ Level 커트라인 (EX score / max EX 비율) — 막대 위 세로줄 위치
const RATE_CUTS = [
  { name: 'A', pct: 6 / 9 },
  { name: 'AA', pct: 7 / 9 },
  { name: 'AAA', pct: 8 / 9 },
];

// rate 텍스트의 letter 색상
const LETTER_COLOR: Record<string, string> = {
  AAA: '#dcaf45',
  AA: '#dcaf45',
  A: '#dcaf45',
  B: '#5cb8ea',
  C: '#52a447',
  // D / E / F: default (검정)
};

export default function ChartTable({ rows, style }: Props) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // 필터 state
  const [search, setSearch] = useState('');
  const [activeLevels, setActiveLevels] = useState<Set<number>>(new Set());
  const [activeLamps, setActiveLamps] = useState<Set<string>>(new Set());
  const [hideLocked, setHideLocked] = useState(false);

  const allCharts = useMemo(
    () => extractCharts(rows, { slots: style === 'sp' ? SP_SLOTS : DP_SLOTS }),
    [rows, style],
  );

  const charts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allCharts.filter((c) => {
      if (hideLocked && !c.unlocked) return false;
      if (q && !c.title.toLowerCase().includes(q)) return false;
      if (activeLevels.size > 0 && !activeLevels.has(c.level)) return false;
      if (activeLamps.size > 0 && !activeLamps.has(c.lamp)) return false;
      return true;
    });
  }, [allCharts, search, activeLevels, activeLamps, hideLocked]);

  const toggleLevel = (lv: number): void => {
    const s = new Set(activeLevels);
    if (s.has(lv)) s.delete(lv);
    else s.add(lv);
    setActiveLevels(s);
  };
  const toggleLamp = (lamp: string): void => {
    const s = new Set(activeLamps);
    if (s.has(lamp)) s.delete(lamp);
    else s.add(lamp);
    setActiveLamps(s);
  };
  const clearFilters = (): void => {
    setSearch('');
    setActiveLevels(new Set());
    setActiveLamps(new Set());
    setHideLocked(false);
  };
  const hasFilter =
    search.length > 0 || activeLevels.size > 0 || activeLamps.size > 0 || hideLocked;

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
    const rateOf = (c: SongChart): number =>
      c.noteCount > 0 ? c.exScore / (c.noteCount * 2) : 0;
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
        case 'rate':
          v = rateOf(a) - rateOf(b);
          break;
        case 'ex':
          v = a.exScore - b.exScore;
          break;
        case 'miss':
          v = a.missCount - b.missCount;
          break;
      }
      if (v !== 0) return v * dir;
      // tiebreak: lamp 정렬일 때 같은 lamp 안에서는 rate 높은 게 위 (sortDir 영향 X)
      if (sortKey === 'lamp') {
        const rd = rateOf(b) - rateOf(a);
        if (rd !== 0) return rd;
      }
      return a.title.localeCompare(b.title);
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
      // LAMP 는 강한 lamp 먼저 (FC > EX > ... > NP) 가 자연스러움 → 첫 클릭 desc
      // 그 외 (LV/곡명/NOTES/RATE/EX/MISS) 는 asc 가 자연
      setSortDir(key === 'lamp' ? 'desc' : 'asc');
    }
  }

  return (
    <div className="ct-wrap">
      <div className="ct-filters">
        <div className="ct-filter-row">
          <input
            type="text"
            className="ct-search"
            placeholder="곡명 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="ct-checkbox">
            <input
              type="checkbox"
              checked={hideLocked}
              onChange={(e) => setHideLocked(e.target.checked)}
            />
            잠긴 차트 숨기기
          </label>
          <span className="ct-filter-count">
            {charts.length} / {allCharts.length}
          </span>
          {hasFilter && (
            <button className="ct-filter-clear" onClick={clearFilters}>
              필터 초기화
            </button>
          )}
        </div>
        <div className="ct-filter-row">
          <span className="ct-filter-label">LV</span>
          {ALL_LEVELS.map((lv) => (
            <button
              key={lv}
              className={`ct-filter-btn${activeLevels.has(lv) ? ' active' : ''}`}
              onClick={() => toggleLevel(lv)}
            >
              {lv}
            </button>
          ))}
        </div>
        <div className="ct-filter-row">
          <span className="ct-filter-label">LAMP</span>
          {ALL_LAMPS.map((lamp) => (
            <button
              key={lamp}
              className={`ct-filter-btn${activeLamps.has(lamp) ? ' active' : ''}`}
              onClick={() => toggleLamp(lamp)}
            >
              {lamp}
            </button>
          ))}
        </div>
      </div>
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
                  <span
                    className="rate-letter"
                    data-letter={c.letter || ''}
                    style={c.letter ? { color: LETTER_COLOR[c.letter] } : undefined}
                  >
                    {c.letter || '-'}
                  </span>
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
