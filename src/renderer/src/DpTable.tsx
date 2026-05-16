// DP ☆12 격자 표 — ereter ★ 레벨로 그룹화, 곡명만 표시, hover 시 상세 정보
//
// 레이아웃:
//   ┌─────────┬─────────────────────────────────┐
//   │ ★12.7   │ 곡A  곡B  곡C  ...                │
//   ├─────────┼─────────────────────────────────┤
//   │ ★12.6   │ ...                             │
//   ├─────────┼─────────────────────────────────┤
//   ...
//
// 각 곡 cell: 차트 slot 별 옅은 배경 색 (DPN/DPH/DPA/DPL)
//             LEGGENDARIA 는 † + 마젠타 글자
//             hover title 에 lamp / EX / rate / miss / notes 표시
import { useMemo, useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import type { ChartSlot, Lamp, RatingData, SongChart } from '../../shared/types';
import { lampNum, norm, slotToDiff } from '../../shared/match';
import { lampStyle, letterColor } from './lampStyle';

// 스택드 바 segment 표시 순서 (좋은 → 나쁜).
// P-FC 는 F-COMBO 에 통합 (별도 segment 없음, lampStack 집계 시 FC 로 합산).
const LAMP_BAR_ORDER: Lamp[] = ['FC', 'EX', 'HC', 'NC', 'EC', 'AC', 'F', 'NP'];

interface Props {
  lv12Charts: SongChart[];
  lv11Charts: SongChart[];
  ratingData?: RatingData | null;
  // 곡명 클릭 시 호출 — DP 탭 이동 + 검색 자동 입력용
  onPickChart?: (target: { title: string; slot: string; gameLevel?: number | null }) => void;
}

const SLOT_LABEL: Record<string, string> = {
  DPN: 'NORMAL',
  DPH: 'HYPER',
  DPA: 'ANOTHER',
  DPL: 'LEGGENDARIA',
};

const LAMP_LABEL: Record<string, string> = {
  NP: 'NO PLAY',
  F: 'FAILED',
  AC: 'ASSIST',
  EC: 'EASY',
  NC: 'CLEAR',
  HC: 'HARD',
  EX: 'EX-HARD',
  FC: 'FULL COMBO',
  PFC: 'PERFECT FC',
};

type SortBy = 'title' | 'lamp-desc' | 'lamp-asc' | 'djlv-desc' | 'djlv-asc';
type StarMode = 'star-0-3' | 'star-3-6' | 'star-6-10' | 'star-10-13' | 'star-14+';
type ViewMode = 12 | 11 | StarMode;
type StarVType = 'ec' | 'hc' | 'exh';

type DisplayChart = SongChart & {
  __vType?: StarVType;
  __origSlot?: ChartSlot;
};

const STAR_RANGES: Record<StarMode, { min: number; max: number; label: string }> = {
  'star-0-3': { min: 0, max: 3, label: '★0~3' },
  'star-3-6': { min: 3, max: 6, label: '★3~6' },
  'star-6-10': { min: 6, max: 10, label: '★6~10' },
  'star-10-13': { min: 10, max: 14, label: '★10~13' },
  'star-14+': { min: 14, max: Infinity, label: '★14+' },
};

const STAR_VTYPE_COLOR: Record<StarVType, string> = {
  ec: '#7bc16a',
  hc: '#dc3545',
  exh: '#dcaf45',
};

const DIFF_TO_SLOT: Record<string, ChartSlot> = {
  NORMAL: 'DPN',
  HYPER: 'DPH',
  ANOTHER: 'DPA',
  LEGGENDARIA: 'DPL',
  BEGINNER: 'DPN',
};

// DJ Level 정렬 순서 — 높을수록 좋음. 미플레이 / null 은 0 (가장 아래).
const DJLV_ORDER: Record<string, number> = {
  AAA: 8, AA: 7, A: 6, B: 5, C: 4, D: 3, E: 2, F: 1,
};
function djlvNum(letter: string | null | undefined): number {
  return letter ? DJLV_ORDER[letter] ?? 0 : 0;
}

function downgradeLampForStarMode(lamp: Lamp, vType: StarVType): { lamp: Lamp; lampNum: number } {
  const n0 = lampNum(lamp);
  let n: number;
  if (n0 >= 7) n = 7;       // FC, PFC → FC
  else if (n0 === 6) n = 6; // EX
  else if (n0 === 5) n = 5; // HC
  else if (n0 >= 3) n = 3;  // EC, NC → EC
  else if (n0 >= 1) n = 1;  // F, AC → F
  else n = 0;               // NP

  if (vType === 'hc' && n === 3) n = 1;
  if (vType === 'exh' && (n === 3 || n === 5)) n = 1;

  const map: Record<number, Lamp> = { 0: 'NP', 1: 'F', 3: 'EC', 5: 'HC', 6: 'EX', 7: 'FC' };
  return { lamp: map[n], lampNum: n };
}

export default function DpTable({ lv12Charts, lv11Charts, ratingData, onPickChart }: Props) {
  const [activeMode, setActiveMode] = useState<ViewMode>(12);
  const isStarMode = typeof activeMode === 'string';
  const [sortBy, setSortBy] = useState<SortBy>('title');
  const [capturing, setCapturing] = useState(false);
  // 캡처 결과 토스트 — 저장 path / 에러 / null (미표시)
  const [captureToast, setCaptureToast] = useState<
    { kind: 'success'; path: string } | { kind: 'error'; error: string } | null
  >(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const stackbarRef = useRef<HTMLDivElement>(null);
  const allLevelCharts = useMemo(() => [...lv12Charts, ...lv11Charts], [lv12Charts, lv11Charts]);

  const charts = useMemo<DisplayChart[]>(() => {
    if (!isStarMode) return activeMode === 12 ? lv12Charts : lv11Charts;
    if (!ratingData) return [];

    const chartIdx = new Map<string, SongChart>();
    for (const c of allLevelCharts) {
      chartIdx.set(norm(c.title) + '|' + slotToDiff(c.slot), c);
    }

    const range = STAR_RANGES[activeMode];
    const variants: Array<{ vType: StarVType; key: 'estEc' | 'estHc' | 'estExh' }> = [
      { vType: 'ec', key: 'estEc' },
      { vType: 'hc', key: 'estHc' },
      { vType: 'exh', key: 'estExh' },
    ];
    const out: DisplayChart[] = [];
    for (const rt of ratingData.ratings) {
      if (rt.gameLevel !== 11 && rt.gameLevel !== 12) continue;
      const matched = chartIdx.get(norm(rt.title) + '|' + rt.diff);
      if (!matched) continue;
      for (const v of variants) {
        const lv = rt[v.key];
        if (typeof lv !== 'number') continue;
        if (lv < range.min || lv >= range.max) continue;
        const bucket = Math.floor(lv * 10 + 1e-9) / 10;
        const dg = downgradeLampForStarMode(matched.lamp, v.vType);
        out.push({
          ...matched,
          title: rt.title,
          slot: matched.slot || DIFF_TO_SLOT[rt.diff],
          level: rt.gameLevel,
          lamp: dg.lamp,
          ereterLevel: bucket,
          __vType: v.vType,
          __origSlot: matched.slot,
        });
      }
    }
    return out;
  }, [activeMode, allLevelCharts, isStarMode, lv11Charts, lv12Charts, ratingData]);

  const lampBarOrder = useMemo<Lamp[]>(
    () => (isStarMode ? ['FC', 'EX', 'HC', 'EC', 'F', 'NP'] : LAMP_BAR_ORDER),
    [isStarMode],
  );

  async function captureGrid(): Promise<void> {
    if (!gridRef.current) return;
    setCapturing(true);
    // 화면 밖에 1200px 폭 임시 컨테이너 만들어서 [lamp-legend + grid + stackbar] 복제 → 캡처 → 제거
    // (창 크기와 무관하게 일정한 1200px 폭의 캡처 결과 보장)
    const bgColor =
      getComputedStyle(document.documentElement).getPropertyValue('--bg-page').trim() ||
      '#ffffff';
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      position: fixed;
      left: -10000px;
      top: 0;
      width: 1200px;
      padding: 16px;
      box-sizing: border-box;
      background: ${bgColor};
      z-index: -1;
      pointer-events: none;
    `;
    // 1. lamp 라벨 범례 (상단)
    if (legendRef.current) {
      const legendClone = legendRef.current.cloneNode(true) as HTMLElement;
      legendClone.style.width = '100%';
      legendClone.style.marginBottom = '12px';
      wrapper.appendChild(legendClone);
    }
    // 2. grid (중앙)
    const clone = gridRef.current.cloneNode(true) as HTMLElement;
    clone.style.width = '100%';
    wrapper.appendChild(clone);
    // 3. 스택드 바 (하단)
    if (stackbarRef.current) {
      const stackClone = stackbarRef.current.cloneNode(true) as HTMLElement;
      stackClone.style.width = '100%';
      stackClone.style.marginTop = '12px';
      // PC margin-left (난이도 컬럼 너비) 무시 — 캡처 시 grid 전체 폭에 align
      stackClone.style.marginLeft = '0';
      wrapper.appendChild(stackClone);
    }
    document.body.appendChild(wrapper);
    // 두 frame 대기 — 레이아웃 + paint 완료 보장
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(undefined))));
    try {
      const canvas = await html2canvas(wrapper, {
        backgroundColor: bgColor,
        // devicePixelRatio 무관하게 일정한 출력 (PC1 / PC2 모바일 모두 동일 결과)
        scale: 1,
        useCORS: true,
        logging: false,
        width: 1200,
        // 미디어쿼리를 1200px 기준 데스크톱 모드로 평가 — 모바일에서도 데스크톱 레이아웃 캡처
        windowWidth: 1200,
      });
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return;
      const buf = await blob.arrayBuffer();
      const ts = new Date()
        .toISOString()
        .replace(/[:T.]/g, '-')
        .replace('Z', '');
      const tag = isStarMode ? activeMode : `dp${activeMode}`;
      const r = await window.infohsorry.saveImage(buf, `${tag}-${ts}.png`);
      if (r.ok && r.path) {
        setCaptureToast({ kind: 'success', path: r.path });
      } else {
        setCaptureToast({ kind: 'error', error: r.error || '알 수 없음' });
      }
    } finally {
      document.body.removeChild(wrapper);
      setCapturing(false);
    }
  }

  // ereter/rating 매칭된 곡 — ★ 레벨로 그룹. 매칭 안 된 곡은 '미분류' 그룹 (가장 아래)
  // 그룹 정렬: 큰 ★ → 작은 ★ → 미분류 (가장 아래)
  // 그룹 내 정렬: 곡명 순 또는 램프 강한 순
  const groups = useMemo(() => {
    const UNCLASSIFIED = -1;
    const m = new Map<number, SongChart[]>();
    for (const c of charts) {
      const lv = c.ereterLevel ?? UNCLASSIFIED;
      if (!m.has(lv)) m.set(lv, []);
      m.get(lv)!.push(c);
    }
    const sorted = Array.from(m.entries()).sort((a, b) => {
      if (a[0] === UNCLASSIFIED) return 1;
      if (b[0] === UNCLASSIFIED) return -1;
      return b[0] - a[0];
    });
    for (const [, arr] of sorted) {
      if (sortBy === 'title') {
        arr.sort((a, b) => a.title.localeCompare(b.title));
      } else if (sortBy === 'lamp-desc' || sortBy === 'lamp-asc') {
        const isAsc = sortBy === 'lamp-asc';
        arr.sort((a, b) => {
          const ln = isAsc ? lampNum(a.lamp) - lampNum(b.lamp) : lampNum(b.lamp) - lampNum(a.lamp);
          if (ln !== 0) return ln;
          return a.title.localeCompare(b.title);
        });
      } else {
        // djlv-desc / djlv-asc
        const isAsc = sortBy === 'djlv-asc';
        arr.sort((a, b) => {
          const dn = isAsc ? djlvNum(a.letter) - djlvNum(b.letter) : djlvNum(b.letter) - djlvNum(a.letter);
          if (dn !== 0) return dn;
          return a.title.localeCompare(b.title);
        });
      }
    }
    return sorted;
  }, [charts, sortBy]);

  // 표 전체 lamp 분포 — 스택드 바용. P-FC 는 F-COMBO 에 합산.
  const lampStack = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of charts) {
      const key = c.lamp === 'PFC' ? 'FC' : c.lamp;
      counts[key] = (counts[key] || 0) + 1;
    }
    const total = charts.length;
    return lampBarOrder
      .map((lamp) => ({ lamp, count: counts[lamp] || 0 }))
      .filter((s) => s.count > 0)
      .map((s) => ({ ...s, pct: (s.count / total) * 100 }));
  }, [charts, lampBarOrder]);

  // 그룹별 lamp 분포 — 난이도 셀 왼쪽 세로 스택드 바용
  const groupLampStacks = useMemo(() => {
    const map = new Map<number, { lamp: Lamp; count: number; pct: number }[]>();
    for (const [level, list] of groups) {
      const counts: Record<string, number> = {};
      for (const c of list) {
        const key = c.lamp === 'PFC' ? 'FC' : c.lamp;
        counts[key] = (counts[key] || 0) + 1;
      }
      const total = list.length;
      const stack = lampBarOrder.map((lamp) => ({ lamp, count: counts[lamp] || 0 }))
        .filter((s) => s.count > 0)
        .map((s) => ({ ...s, pct: (s.count / total) * 100 }));
      map.set(level, stack);
    }
    return map;
  }, [groups, lampBarOrder]);

  const tabs: Array<{ mode: ViewMode; label: string }> = [
    { mode: 12, label: 'DP12' },
    { mode: 11, label: 'DP11' },
    { mode: 'star-0-3', label: '★0~3' },
    { mode: 'star-3-6', label: '★3~6' },
    { mode: 'star-6-10', label: '★6~10' },
    { mode: 'star-10-13', label: '★10~13' },
    { mode: 'star-14+', label: '★14+' },
  ];

  return (
    <div>
      <div className="dp-section-title">
        <div className="dp-level-tabs">
          {tabs.map((t) => (
            <button
              key={String(t.mode)}
              type="button"
              className={`dp-level-tab${activeMode === t.mode ? ' active' : ''}`}
              onClick={() => setActiveMode(t.mode)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {isStarMode && (
        <div className="dp-star-note">
          <strong>{STAR_RANGES[activeMode].label}</strong> 구간 · ohSorryRating 기준 EC/HC/EXH 별점과 현재 플레이 데이터를 매칭합니다.
        </div>
      )}
      {groups.length === 0 ? (
        <div className="dp-empty">서열표 {isStarMode ? STAR_RANGES[activeMode].label : activeMode} — 매칭된 곡이 없습니다.</div>
      ) : (
      <>
      <div className="dp-toolbar">
        <div className="dp-bar-group">
          {/* 색상 박스 범례 */}
          <div className="dp-lamp-legend" ref={legendRef}>
            {lampBarOrder.map((lamp) => {
              const ls = lampStyle(lamp);
              return (
                <div key={lamp} className="dp-lamp-legend-item">
                  <span className={`dp-lamp-legend-swatch lamp-box lamp-${lamp}`} />
                  <span>{ls.label}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="dp-sort">
          <button
            className={`dp-sort-btn${sortBy === 'title' ? ' active' : ''}`}
            onClick={() => setSortBy('title')}
          >
            곡명 순
          </button>
          <span className="dp-sort-sep">|</span>
          <button
            className={`dp-sort-btn${sortBy.startsWith('lamp') ? ' active' : ''}`}
            onClick={() =>
              setSortBy((prev) =>
                prev === 'lamp-desc' ? 'lamp-asc' : 'lamp-desc',
              )
            }
            title="한 번 더 누르면 정렬 방향 반전"
          >
            램프 순 {sortBy === 'lamp-asc' ? '↑' : sortBy === 'lamp-desc' ? '↓' : ''}
          </button>
          <span className="dp-sort-sep">|</span>
          <button
            className={`dp-sort-btn${sortBy.startsWith('djlv') ? ' active' : ''}`}
            onClick={() =>
              setSortBy((prev) =>
                prev === 'djlv-desc' ? 'djlv-asc' : 'djlv-desc',
              )
            }
            title="한 번 더 누르면 정렬 방향 반전"
          >
            DJ Level 순 {sortBy === 'djlv-asc' ? '↑' : sortBy === 'djlv-desc' ? '↓' : ''}
          </button>
          <button
            className="dp-capture-btn"
            onClick={captureGrid}
            disabled={capturing}
            title="격자 영역을 PNG 이미지로 저장"
          >
            {capturing ? '캡처 중...' : '캡처'}
          </button>
        </div>
      </div>
      <div className="dp-grid" ref={gridRef}>
          {groups.map(([level, list]) => {
            const stack = groupLampStacks.get(level) ?? [];
            return (
            <div key={level} className="dp-group">
              <div className="dp-level-stackbar" title={`그룹 lamp 분포 (${list.length}곡)`}>
                {stack.map(({ lamp, count, pct }) => (
                  <span
                    key={lamp}
                    className={`dp-level-stackbar-seg lamp-box lamp-${lamp}`}
                    style={{ flexBasis: `${pct}%` }}
                    title={`${LAMP_LABEL[lamp] ?? lamp}: ${count}곡 (${pct.toFixed(1)}%)`}
                  />
                ))}
              </div>
              <div className="dp-level">
                {level === -1 ? '미분류' : `${isStarMode ? '★' : ''}${level.toFixed(1)}`}
                <span className="dp-level-count">{list.length}곡</span>
              </div>
              <div className="dp-songs">
                {list.map((c, i) => (
                  <SongCell key={`${c.title}|${c.slot}|${i}`} c={c} onPickChart={onPickChart} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {/* 스택드 바 — 서열표 제일 하단 */}
      {lampStack.length > 0 && (
        <div className="dp-stackbar" ref={stackbarRef}>
          {lampStack.map(({ lamp, count, pct }) => {
            return (
              <div
                key={lamp}
                className={`dp-stackbar-seg lamp-box lamp-${lamp}`}
                style={{ flexBasis: `${pct}%` }}
              >
                {count}
              </div>
            );
          })}
        </div>
      )}
      {captureToast && (
        <div className="capture-toast" role="status" aria-live="polite">
          <div className="capture-toast-msg">
            {captureToast.kind === 'success' ? '캡처 저장됨' : `캡처 실패: ${captureToast.error}`}
          </div>
          {captureToast.kind === 'success' && (
            <div className="capture-toast-path">{captureToast.path}</div>
          )}
          <div className="capture-toast-btns">
            {captureToast.kind === 'success' && (
              <button
                type="button"
                className="capture-toast-btn"
                onClick={() => {
                  void window.infohsorry.shell.showInFolder(captureToast.path);
                  setCaptureToast(null);
                }}
              >
                폴더 열기
              </button>
            )}
            <button
              type="button"
              className="capture-toast-btn capture-toast-btn-primary"
              onClick={() => setCaptureToast(null)}
            >
              확인
            </button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

function SongCell({
  c,
  onPickChart,
}: {
  c: DisplayChart;
  onPickChart?: (target: { title: string; slot: string; gameLevel?: number | null }) => void;
}) {
  const isLegg = c.slot === 'DPL';
  const played = c.lamp !== 'NP' && c.unlocked;
  const rate = played && c.noteCount > 0 ? (c.exScore / (c.noteCount * 2)) * 100 : null;
  const lampLabel = LAMP_LABEL[c.lamp] ?? c.lamp;
  const slotLabel = SLOT_LABEL[c.slot as ChartSlot] ?? c.slot;

  // hover tooltip — native title (한 줄씩)
  const tooltip = [
    `${c.title}`,
    `${slotLabel} · ${lampLabel}`,
    !c.unlocked
      ? '잠김'
      : played
      ? `EX ${c.exScore.toLocaleString()} (${rate?.toFixed(2)}%)\n${
          c.letter || '-'
        } · MISS ${c.missCount} / NOTES ${c.noteCount}`
      : `NOTES ${c.noteCount}`,
  ].join('\n');

  const handlePick = onPickChart
    ? (): void => onPickChart({ title: c.title, slot: c.slot, gameLevel: c.level })
    : undefined;

  return (
    <div
      className={`dp-song slot-${c.slot} lamp-${c.lamp}${c.__vType ? ` star-vtype-${c.__vType}` : ''}${handlePick ? ' dp-song-clickable' : ''}`}
      title={tooltip}
      onClick={handlePick}
      role={handlePick ? 'button' : undefined}
      tabIndex={handlePick ? 0 : undefined}
      onKeyDown={handlePick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePick(); } } : undefined}
    >
      <span className={`lamp-box lamp-${c.lamp}`} />
      <span className="dp-song-text">
        {c.__vType && (
          <span
            className="dp-song-prefix"
            style={{ color: STAR_VTYPE_COLOR[c.__vType] }}
          >
            {c.__vType.toUpperCase()}
          </span>
        )}
        {(isLegg ? '† ' : '') + c.title}
      </span>
      {/* NP / letter 없는 곡도 영역만 유지 (글자는 비움) — 곡명 폭 일관성 */}
      <span
        className="dp-song-djlv"
        style={c.lamp !== 'NP' && c.letter ? { color: letterColor(c.letter) } : undefined}
      >
        {c.lamp === 'NP' ? '' : c.letter ?? ''}
      </span>
    </div>
  );
}
