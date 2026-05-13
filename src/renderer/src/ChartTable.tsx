// 차트 단위 표 — 한 row = 한 난이도 (= 한 차트)
//
// 컬럼: LAMP / LEVEL / 곡명 / NOTES / DJ Level / EX Score / MISS
// 헤더 클릭 → asc → desc → unsorted (default 정렬) cycle
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChartSlot, SongChart, SongRow } from '../../shared/types';
import { DP_SLOTS, SP_SLOTS, extractCharts } from '../../shared/types';
import { lampNum } from '../../shared/match';
import { lampStyle } from './lampStyle';

interface Props {
  rows: SongRow[];
  style: 'sp' | 'dp';
  // 외부에서 특정 곡 검색 요청 — title 자동 입력 + gameLevel 있으면 필터 자동 적용
  scrollTarget?: { title: string; slot: string; gameLevel?: number | null } | null;
  // 적용 완료 콜백 (target 해제용)
  onScrollDone?: () => void;
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

// 필터 버튼 — Reflux enum 값 + EAMUSE 공식 표기
const ALL_LAMPS: { value: string; label: string }[] = [
  { value: 'NP', label: 'NO PLAY' },
  { value: 'F', label: 'FAILED' },
  { value: 'AC', label: 'ASSIST' },
  { value: 'EC', label: 'EASY' },
  { value: 'NC', label: 'CLEAR' },
  { value: 'HC', label: 'HARD' },
  { value: 'EX', label: 'EX HARD' },
  { value: 'FC', label: 'FULL COMBO' },
];
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

export default function ChartTable({ rows, style, scrollTarget, onScrollDone }: Props) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // 필터 state
  const [search, setSearch] = useState('');
  const [activeLevels, setActiveLevels] = useState<Set<number>>(new Set());
  const [activeLamps, setActiveLamps] = useState<Set<string>>(new Set());
  const [hideLocked, setHideLocked] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  // 필터 영역도 sticky → thead 의 top 을 필터 높이만큼 내림
  const filtersRef = useRef<HTMLDivElement>(null);
  const [filtersHeight, setFiltersHeight] = useState(0);
  useEffect(() => {
    const el = filtersRef.current;
    if (!el) return;
    const update = (): void => setFiltersHeight(el.getBoundingClientRect().height);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 외부 scrollTarget (추천곡 클릭 등) → search 박스에 곡 제목 자동 입력 + 다른 필터 초기화.
  // 스크롤은 사용자가 검색 결과 자체로 확인.
  const onScrollDoneRef = useRef(onScrollDone);
  useEffect(() => { onScrollDoneRef.current = onScrollDone; }, [onScrollDone]);
  useEffect(() => {
    if (!scrollTarget) return;
    setSearch(scrollTarget.title);
    setActiveLevels(typeof scrollTarget.gameLevel === 'number' ? new Set([scrollTarget.gameLevel]) : new Set());
    setActiveLamps(new Set());
    setHideLocked(false);
    onScrollDoneRef.current?.();
  }, [scrollTarget]);

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
      // tiebreak (sortDir 영향 X):
      //   - lamp 정렬: 같은 lamp → rate 높은 게 위
      //   - level 정렬: 같은 level → lamp 강한 게 위 → 그 다음 rate 높은 게 위
      if (sortKey === 'level') {
        const ld = lampNum(b.lamp) - lampNum(a.lamp);
        if (ld !== 0) return ld;
        const rd = rateOf(b) - rateOf(a);
        if (rd !== 0) return rd;
      } else if (sortKey === 'lamp') {
        const rd = rateOf(b) - rateOf(a);
        if (rd !== 0) return rd;
      }
      return a.title.localeCompare(b.title);
    });
  }, [charts, sortKey, sortDir, slotIdx]);

  // key 별 기본 정렬 방향 — miss 만 오름차순 우선, 나머지는 내림차순 우선
  function defaultDirFor(key: SortKey): SortDir {
    return key === 'miss' ? 'asc' : 'desc';
  }

  function clickSort(key: SortKey | null): void {
    if (key == null) return;
    const def = defaultDirFor(key);
    // 첫 클릭 → 기본 방향 / 같은 컬럼 두 번째 → 반대 방향 / 세 번째 → unsorted
    if (sortKey === key) {
      if (sortDir === def) setSortDir(def === 'desc' ? 'asc' : 'desc');
      else {
        setSortKey(null);
        setSortDir('desc');
      }
    } else {
      setSortKey(key);
      setSortDir(def);
    }
  }

  // 모바일 정렬 (CSS 가 데스크탑에서 숨김 처리)
  const mobileSortKeys: { key: SortKey; label: string }[] = [
    { key: 'lamp', label: 'LAMP' },
    { key: 'level', label: 'LEVEL' },
    { key: 'miss', label: 'MISS' },
  ];

  return (
    <div className="ct-wrap">
      <div className="ct-filters" ref={filtersRef}>
        <div className="ct-filter-row">
          <input
            type="text"
            className="ct-search"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className="ct-filter-toggle"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Expand filters' : 'Collapse filters'}
          >
            {collapsed ? 'Filter ▼' : 'Filter ▲'}
          </button>
          <span className="ct-filter-count">
            {charts.length} / {allCharts.length}
          </span>
        </div>
        {!collapsed && (
          <>
            <div className="ct-filter-row">
              <span className="ct-filter-label">LAMP</span>
              {ALL_LAMPS.map(({ value, label }) => (
                <button
                  key={value}
                  className={`ct-filter-btn${activeLamps.has(value) ? ' active' : ''}`}
                  onClick={() => toggleLamp(value)}
                >
                  {label}
                </button>
              ))}
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
              <label className="ct-checkbox ct-hide-locked">
                <input
                  type="checkbox"
                  checked={hideLocked}
                  onChange={(e) => setHideLocked(e.target.checked)}
                />
                Hide Locked
              </label>
              {hasFilter && (
                <button
                  className="ct-filter-clear ct-filter-clear-desktop"
                  onClick={clearFilters}
                >
                  Reset
                </button>
              )}
            </div>
          </>
        )}
        <div className="ct-mobile-sort-row">
          {hasFilter && (
            <button
              className="ct-filter-clear ct-filter-clear-mobile"
              onClick={clearFilters}
            >
              Reset
            </button>
          )}
          {mobileSortKeys.map((s, i) => {
            const active = sortKey === s.key;
            const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
            return (
              <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center' }}>
                {i > 0 && <span className="ct-mobile-sort-sep">|</span>}
                <button
                  className={`ct-mobile-sort-btn${active ? ' active' : ''}`}
                  onClick={() => clickSort(s.key)}
                >
                  {s.label}
                  {arrow}
                </button>
              </span>
            );
          })}
        </div>
      </div>
      <div
        className="ct-table"
        style={{ ['--filters-h' as string]: `${filtersHeight}px` }}
      >
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
    <div className={`ct-tr${locked ? ' locked' : ''}${played ? ' played' : ''}`}>
      <div
        className={`ct-cell ct-lamp${locked ? '' : ` ct-lamp-${c.lamp}`}`}
        title={locked ? '잠김' : ls.label}
      />

      <div className="ct-cell ct-level">
        <span style={{ color: slotColor, fontWeight: 700 }}>{c.level || '-'}</span>
      </div>
      <div
        className="ct-cell ct-title ct-title-clickable"
        title={`${c.title}\n(클릭하면 곡명 클립보드 복사)`}
        // LEGGENDARIA 차트는 곡명 앞에 † + 마젠타 색
        style={c.slot === 'SPL' || c.slot === 'DPL' ? { color: slotColor } : undefined}
        onClick={() => {
          navigator.clipboard.writeText(c.title).then(
            () => console.log(`[clipboard] '${c.title}' 복사됨`),
            (e) => console.error('[clipboard] 복사 실패:', e),
          );
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navigator.clipboard.writeText(c.title).catch(() => {});
          }
        }}
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
      <div className="ct-cell num">
        <span className="ct-mobile-label">SCORE</span>
        <span className="ct-mobile-value">
          {played && c.exScore > 0 ? c.exScore.toLocaleString() : '-'}
        </span>
      </div>
      <div className="ct-cell num">
        <span className="ct-mobile-label">MISS</span>
        <span className="ct-mobile-value">
          {played && c.missCount >= 0 ? c.missCount.toLocaleString() : '-'}
        </span>
      </div>
    </div>
  );
}
