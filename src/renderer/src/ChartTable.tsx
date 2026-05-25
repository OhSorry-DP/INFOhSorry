// 차트 단위 표 — 한 row = 한 난이도 (= 한 차트)
//
// 컬럼: LAMP / LEVEL / 곡명 / NOTES / DJ Level / EX Score / MISS
// 헤더 클릭 → asc → desc → unsorted (default 정렬) cycle
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChartSlot, SongChart, SongRow } from '../../shared/types';
import { DP_SLOTS, SP_SLOTS, extractCharts } from '../../shared/types';
import { lampNum } from '../../shared/match';
import { lampStyle } from './lampStyle';

// 클립보드 복사 헬퍼 — navigator.clipboard 우선, 실패 시 execCommand fallback.
// PC2 (LAN IP / http://) 등 non-secure context 에서도 동작.
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      console.log(`[clipboard] '${text}' 복사됨 (clipboard API)`);
      return true;
    } catch (e) {
      console.warn('[clipboard] clipboard API 실패, fallback 시도:', (e as Error).message);
    }
  }
  // fallback: 임시 textarea + execCommand
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
    if (ok) console.log(`[clipboard] '${text}' 복사됨 (execCommand fallback)`);
    else console.warn('[clipboard] execCommand 도 실패');
  } catch (e) {
    console.error('[clipboard] execCommand 에러:', (e as Error).message);
  }
  document.body.removeChild(ta);
  return ok;
}

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

  // 페이징 — 전체 row 한 번에 렌더하면 DOM 폭발해서 렉. 검색/필터는 페이징 전 단계에 적용되므로
  // 검색어 입력하면 전체 row 에서 검색 + 그 결과만 페이징됨 (페이지 무관 검색).
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState<number>(1);

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

  // 검색/필터/정렬/페이지사이즈 변경 시 1페이지로 리셋.
  useEffect(() => { setPage(1); }, [search, activeLevels, activeLamps, hideLocked, sortKey, sortDir, pageSize, style]);

  // 페이징 적용 — sorted 의 일부만 렌더.
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const paged = useMemo(
    () => sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sorted, safePage, pageSize],
  );

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
        {paged.map((c, i) => (
          <ChartRow key={`${c.title}|${c.slot}|${(safePage - 1) * pageSize + i}`} c={c} />
        ))}
      </div>
      <Pager
        page={safePage}
        totalPages={totalPages}
        pageSize={pageSize}
        totalRows={sorted.length}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
      </div>
    </div>
  );
}

interface PagerProps {
  page: number;
  totalPages: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (s: number) => void;
}
function Pager({ page, totalPages, pageSize, totalRows, onPageChange, onPageSizeChange }: PagerProps): JSX.Element {
  if (totalRows === 0) return <></>;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalRows);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 12, padding: '8px 12px', borderTop: '1px solid #2a2d34',
      background: '#1a1c20', color: '#adb5bd', fontSize: 13, flexWrap: 'wrap',
    }}>
      <div>
        <span style={{ marginRight: 6 }}>페이지당</span>
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(parseInt(e.target.value, 10))}
          style={{ background: '#23262b', color: '#e9ecef', border: '1px solid #3a3d44', borderRadius: 4, padding: '2px 6px' }}
        >
          {[30, 50, 100].map((n) => <option key={n} value={n}>{n}곡</option>)}
        </select>
        <span style={{ marginLeft: 12, color: '#868e96' }}>{totalRows}곡 중 {start}~{end}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={() => onPageChange(1)} disabled={page <= 1}
          style={pagerBtn(page <= 1)}>«</button>
        <button onClick={() => onPageChange(page - 1)} disabled={page <= 1}
          style={pagerBtn(page <= 1)}>‹</button>
        <span style={{ minWidth: 80, textAlign: 'center', color: '#e9ecef', fontWeight: 600 }}>
          {page} / {totalPages}
        </span>
        <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}
          style={pagerBtn(page >= totalPages)}>›</button>
        <button onClick={() => onPageChange(totalPages)} disabled={page >= totalPages}
          style={pagerBtn(page >= totalPages)}>»</button>
      </div>
    </div>
  );
}
function pagerBtn(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? '#1f2125' : '#23262b',
    color: disabled ? '#4d5358' : '#e9ecef',
    border: '1px solid #3a3d44', borderRadius: 4,
    padding: '4px 10px', cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit', fontSize: 13,
  };
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
        onClick={() => { void copyToClipboard(c.title); }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void copyToClipboard(c.title);
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
