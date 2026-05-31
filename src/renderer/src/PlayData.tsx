// PlayData 탭 — 오소리웹 populatePlayData 의 UI 포팅.
//
// 데이터 source:
//   - row 의 lamp/exScore/djLevel/missCount/noteCount: TSV (rows: SongRow[])
//   - 곡 마스터 / 시리즈 / 미플레이 곡 메타: supabase songs (read-only) + textage-meta + series-name (gist)
//
// 구조:
//   - 시리즈 폴더 accordion (series_no desc, null 그룹 맨 끝)
//   - 각 폴더 안 4채보 row (NORMAL/HYPER/ANOTHER/LEGGENDARIA, LEG 는 songs.legen & INF 비트 있는 곡만)
//   - 상단 필터: 검색 (곡명) / diff cycle / sort cycle
//   - 폴더 summary: lamp 색박스 (현재 diff 매치 row 들 중 가장 낮은 lamp) / 시리즈명 / 플레이N/전체M
//   - row 클릭 → DP 탭 으로 점프 + 해당 곡 검색 (INFOhSorry scrollTarget 패턴)
//
// CSS — ohSorryWeb styles.css 의 .__uprofile_pd* / .__pd_* 이식 (index.css).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChartSlot, SongRow, ZasaData, RatingData } from '../../shared/types';
import { norm } from '../../shared/match';
import {
  getSongsById,
  ensureTextageMeta,
  fetchSeriesNames,
  type SongEntry,
  type TextageMeta,
} from './supabaseSync';
import { lampStyle } from './lampStyle';
import { copyToClipboard } from './ChartTable';

// DJ Level letter 색 — ChartTable 의 LETTER_COLOR 와 동일 (inline style 적용).
//   CSS [data-letter] 셀렉터도 같이 동작 (다크 테마 override) — ChartTable 와 같은 디자인 시스템 reuse.
const LETTER_COLOR: Record<string, string> = {
  AAA: '#dcaf45',
  AA: '#dcaf45',
  A: '#dcaf45',
  B: '#5cb8ea',
  C: '#52a447',
};

// ─── 정체성 상수 (오소리웹 PD_DIFFS / DIFF_COLOR / RATE_CUTS 와 동일) ─────────────
// 4채보 정의 — order/color/textage key.
const PD_DIFFS = [
  { key: 'NORMAL',      tkey: 'DN', color: '#1971c2' },
  { key: 'HYPER',       tkey: 'DH', color: '#dcaf45' },
  { key: 'ANOTHER',     tkey: 'DA', color: '#dc3545' },
  { key: 'LEGGENDARIA', tkey: 'DX', color: '#d678c8' },
] as const;
type DiffDef = (typeof PD_DIFFS)[number];

// diff → slot key — style 별 분기. DP: DPN/DPH/DPA/DPL, SP: SPN/SPH/SPA/SPL.
//   PD_DIFFS 의 BEGINNER 제외 정책 (오소리웹과 동일) 유지 → SPB 도 표시 안 함.
const DP_DIFF_TO_SLOT: Record<string, ChartSlot> = {
  NORMAL: 'DPN', HYPER: 'DPH', ANOTHER: 'DPA', LEGGENDARIA: 'DPL',
};
const SP_DIFF_TO_SLOT: Record<string, ChartSlot> = {
  NORMAL: 'SPN', HYPER: 'SPH', ANOTHER: 'SPA', LEGGENDARIA: 'SPL',
};
function diffToSlot(style: 'sp' | 'dp', diff: string): ChartSlot | undefined {
  return style === 'sp' ? SP_DIFF_TO_SLOT[diff] : DP_DIFF_TO_SLOT[diff];
}

// 풀네임 lamp → 약어 (.__pd_lamp-XX 클래스 키).
const LAMP_FULL_TO_ABBR: Record<string, string> = {
  'NO PLAY': 'NP', 'FAILED': 'F', 'ASSIST': 'AC', 'EASY': 'EC',
  'CLEAR': 'NC', 'HARD': 'HC', 'EX HARD': 'EX', 'FULL COMBO': 'FC',
};
const ABBR_TO_FULL: Record<string, string> = {
  NP: 'NO PLAY', F: 'FAILED', AC: 'ASSIST', EC: 'EASY', NC: 'CLEAR',
  HC: 'HARD', EX: 'EX HARD', FC: 'FULL COMBO', PFC: 'FULL COMBO',
};
function lampAbbr(lampStr: string | null | undefined): string {
  if (!lampStr) return 'NP';
  if (LAMP_FULL_TO_ABBR[lampStr]) return LAMP_FULL_TO_ABBR[lampStr];
  return lampStr;  // 이미 약어
}

// lamp 텍스트 색 (.__pd_lamptext 안 인라인). 약어/풀네임 둘 다 받음.
const LAMP_TEXT_COLOR: Record<string, string> = {
  'NO PLAY': '#6c757d', NP: '#6c757d',
  'FAILED': '#dc3545', F: '#dc3545',
  'ASSIST': '#9966cc', AC: '#9966cc',
  'EASY': '#7bc16a', EC: '#7bc16a',
  'CLEAR': '#5cb8ea', NC: '#5cb8ea',
  'HARD': '#e9ecef', HC: '#e9ecef',
  'EX HARD': '#dcaf45', EX: '#dcaf45',
  'FULL COMBO': '#74c0fc', FC: '#74c0fc',
  'PERFECT FC': '#74c0fc', PFC: '#74c0fc',
};
function lampTextColor(lampStr: string | null | undefined): string {
  if (!lampStr) return '#6c757d';
  return LAMP_TEXT_COLOR[lampStr] || '#6c757d';
}

// DJ Level 글자 색 (PD_LETTER_COLOR).
const PD_LETTER_COLOR: Record<string, string> = {
  AAA: '#dcaf45', AA: '#dcaf45', A: '#52a447', B: '#5cb8ea',
  C: '#52a447',
};
function pdLetterColor(letter: string | null | undefined): string {
  if (!letter) return '';
  return PD_LETTER_COLOR[letter] || '';
}

// RATE 바 cut — A(6/9) / AA(7/9) / AAA(8/9) 위치.
const RATE_CUTS = [
  { name: 'A', pct: 6 / 9 },
  { name: 'AA', pct: 7 / 9 },
  { name: 'AAA', pct: 8 / 9 },
];

// 다음 DJ Level 컷까지 부족분 — exScore 가 컷 중간 지점 이상이면 "{다음}-{diff}", 미만이면 "{현재}+{diff}".
const DJ_CUT_NUM: Record<string, number> = { F: 0, E: 2, D: 3, C: 4, B: 5, A: 6, AA: 7, AAA: 8 };
const DJ_NEXT: Record<string, string> = { F: 'E', E: 'D', D: 'C', C: 'B', B: 'A', A: 'AA', AA: 'AAA', AAA: 'MAX' };
function nextGradeDiff(djLevel: string | null, exScore: number, noteCount: number | null): string {
  if (!djLevel || typeof exScore !== 'number' || !noteCount || noteCount <= 0) return '';
  const next = DJ_NEXT[djLevel];
  if (!next) return '';
  const max = noteCount * 2;
  const curMin = djLevel === 'F' ? 0 : Math.ceil((max * DJ_CUT_NUM[djLevel]) / 9);
  const nextMin = next === 'MAX' ? max : Math.ceil((max * DJ_CUT_NUM[next]) / 9);
  if (exScore < curMin) return '';
  const midpoint = (curMin + nextMin) / 2;
  if (exScore >= midpoint) {
    const diff = nextMin - exScore;
    if (diff < 0) return '';
    return next + '-' + diff;
  }
  const diff = exScore - curMin;
  if (diff < 0) return '';
  return djLevel + '+' + diff;
}

// EX score → DJ Level (클라이언트 계산).
function djLevelFromScore(exScore: number, noteCount: number | null): string | null {
  if (!exScore || exScore <= 0) return null;
  if (!noteCount || noteCount <= 0) return null;
  const ratio = exScore / (noteCount * 2);
  if (ratio >= 8 / 9) return 'AAA';
  if (ratio >= 7 / 9) return 'AA';
  if (ratio >= 6 / 9) return 'A';
  if (ratio >= 5 / 9) return 'B';
  if (ratio >= 4 / 9) return 'C';
  if (ratio >= 3 / 9) return 'D';
  if (ratio >= 2 / 9) return 'E';
  return 'F';
}

// lamp 약어 priority — 폴더 summary 색박스 (현재 diff 매치 row 들 중 가장 낮은 lamp 색).
const LAMP_KEY_NUM: Record<string, number> = { NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 8 };
const LAMP_NUM_KEY = ['NP', 'F', 'AC', 'EC', 'NC', 'HC', 'EX', 'FC', 'PFC'];

// ─── 한 row 의 derive 데이터 ────────────────────────────────────────────
interface RowData {
  song: SongEntry;
  diff: DiffDef;
  // TSV 매칭 결과 (없으면 미플레이)
  played: boolean;
  lampAbbrStr: string;       // "HC" / "NP" 등 — .ct-lamp-XX 클래스 key
  lampFull: string;          // "HARD" / "NO PLAY" 등 — 텍스트 색 lookup
  exScore: number;
  missCount: number;         // -1 또는 0 미만 → '-' 표시
  djLevel: string | null;
  // 메타 (textage-meta 또는 TSV)
  gameLevel: number | null;
  noteCount: number | null;
  zasaLevel: number | null;  // zasa★ (예: 11.7) — 곡명 앞 / level cell 두 번째 줄 표시
  // LEG 곡이 INF 시리즈에 미수록인지 (legen & 2 === 0). LEG 필터 시 ANOTHER 를 fallback 으로 보여주는 표시.
  noLegSong: boolean;
  // 배치 추천 (calcWeakness chartStrengthMatch8Way 의 bestLabel). 배치 ON 토글 + lib 준비 시에만 채워짐.
  //   '' = 정규 배치 (mirror/flip 안 됨), 'M/-' / 'F' / 'F M/M' 등 = 추천 배치 라벨.
  layoutLabel: string;
}

// TSV row 의 cell 한 개를 받아 화면 표시용 RowData 로 변환.
function buildRowData(
  song: SongEntry,
  diffDef: DiffDef,
  tsvCell: { lamp: string; exScore: number; letter: string; noteCount: number; level: number; missCount: number } | null,
  textageSongs: TextageMeta['songs'] | null,
  zasaIndex: Map<string, number>,
  layoutMap: Map<string, string> | null,
  noLegSong: boolean,
): RowData {
  const meta = textageSongs && song.textage_song_id ? textageSongs[song.textage_song_id] : null;
  // gameLevel / noteCount 우선순위: TSV (실측) > textage-meta (정적).
  const gameLevel = tsvCell && typeof tsvCell.level === 'number' && tsvCell.level > 0
    ? tsvCell.level
    : (meta && meta.levels && typeof meta.levels[diffDef.tkey] === 'number' && meta.levels[diffDef.tkey] > 0
        ? meta.levels[diffDef.tkey] : null);
  const noteCount = tsvCell && typeof tsvCell.noteCount === 'number' && tsvCell.noteCount > 0
    ? tsvCell.noteCount
    : (meta && meta.notes && typeof meta.notes[diffDef.tkey] === 'number' && meta.notes[diffDef.tkey] > 0
        ? meta.notes[diffDef.tkey] : null);
  const lampAbbrStr = tsvCell?.lamp || 'NP';
  const exScore = tsvCell && typeof tsvCell.exScore === 'number' ? tsvCell.exScore : 0;
  const played = exScore > 0;
  const lampFull = ABBR_TO_FULL[lampAbbrStr] || lampAbbrStr;
  // djLevel — INFOhSorry letter 가 있으면 그대로, 없으면 ex/note 계산.
  const djLevel = (tsvCell && tsvCell.letter) || djLevelFromScore(exScore, noteCount);
  const missCount = tsvCell && typeof tsvCell.missCount === 'number' ? tsvCell.missCount : -1;
  // zasa★ — norm(title)+'|'+diffStr 인덱스 lookup. 없으면 null (곡명 앞 빈 자리 유지).
  const zasaRaw = zasaIndex.get(norm(song.title) + '|' + diffDef.key);
  const zasaLevel = typeof zasaRaw === 'number' ? zasaRaw : null;
  // 배치 추천 라벨 lookup — layoutMap (null = 토글 OFF / lib 미준비) 이면 빈 문자열.
  const layoutLabel = layoutMap?.get(norm(song.title) + '|' + diffDef.key) ?? '';
  return {
    song,
    diff: diffDef,
    played,
    lampAbbrStr,
    lampFull,
    exScore,
    missCount,
    djLevel,
    gameLevel,
    noteCount,
    zasaLevel,
    noLegSong,
    layoutLabel,
  };
}

// 한 곡의 4채보 (LEG 는 songs.legen & 2 인 곡만) → RowData 배열.
function songRowsData(
  song: SongEntry,
  tsvIdx: Map<string, NonNullable<SongRow['charts'][ChartSlot]>>,
  textageSongs: TextageMeta['songs'] | null,
  zasaIndex: Map<string, number>,
  layoutMap: Map<string, string> | null,
  style: 'sp' | 'dp',
): RowData[] {
  const userMask = 2;  // INFOhSorry 는 항상 INF
  const showLeg = typeof song.legen === 'number' && (song.legen & userMask) !== 0;
  const noLegSong = !showLeg;
  const out: RowData[] = [];
  for (const d of PD_DIFFS) {
    if (d.key === 'LEGGENDARIA' && !showLeg) continue;
    const slot = diffToSlot(style, d.key);
    if (!slot) continue;
    const cell = tsvIdx.get(norm(song.title) + '|' + slot) || null;
    out.push(buildRowData(song, d, cell, textageSongs, zasaIndex, layoutMap, noLegSong));
  }
  return out;
}

// ─── 필터 / 정렬 cycle ────────────────────────────────────────────────
const DIFF_CYCLE = [
  { key: 'NORMAL' as const, label: 'NORMAL', color: '#1971c2' },
  { key: 'HYPER' as const, label: 'HYPER', color: '#dcaf45' },
  { key: 'ANOTHER' as const, label: 'ANOTHER', color: '#dc3545' },
  { key: 'LEGGENDARIA' as const, label: 'LEGGENDARIA', color: '#d678c8' },
];
const SORT_CYCLE = [
  { key: 'title' as const, label: 'Title' },
  { key: 'level' as const, label: 'Level' },
  { key: 'lamp' as const, label: 'Lamp' },
  { key: 'rate' as const, label: 'Rate' },
];

// 현재 diff filter 에 해당하는 row 인지 (LEG 필터 시 LEG 미수록 곡은 ANOTHER row 를 fallback 으로).
function matchesDiffFilter(r: RowData, curDiff: typeof DIFF_CYCLE[number]['key']): boolean {
  if (curDiff === 'LEGGENDARIA') {
    if (r.diff.key === 'LEGGENDARIA') return true;
    return r.diff.key === 'ANOTHER' && r.noLegSong;
  }
  return r.diff.key === curDiff;
}

// row 정렬 — sortKey 에 따라 desc. row 묶음은 같은 폴더 안.
function compareRows(a: RowData, b: RowData, sortKey: 'title' | 'level' | 'lamp' | 'rate'): number {
  if (sortKey === 'title') return b.song.title.localeCompare(a.song.title);  // Z→A
  if (sortKey === 'level') {
    const la = a.gameLevel ?? -1;
    const lb = b.gameLevel ?? -1;
    if (la !== lb) return lb - la;
    return a.song.title.localeCompare(b.song.title);
  }
  if (sortKey === 'lamp') {
    const la = LAMP_KEY_NUM[a.lampAbbrStr] ?? 0;
    const lb = LAMP_KEY_NUM[b.lampAbbrStr] ?? 0;
    if (la !== lb) return lb - la;
    return a.song.title.localeCompare(b.song.title);
  }
  // rate
  const ra = a.played && a.noteCount ? a.exScore / (a.noteCount * 2) : -1;
  const rb = b.played && b.noteCount ? b.exScore / (b.noteCount * 2) : -1;
  if (ra !== rb) return rb - ra;
  return a.song.title.localeCompare(b.song.title);
}

// ─── 행 컴포넌트 — ChartTable 의 ct-tr 디자인과 동일 (8 cell grid: lamp / LV / 곡명 / NOTES / LAMP텍스트 / RATE / SCORE / MISS) ─────
// row 자체는 클릭 동작 없음. 곡명만 클릭 → 클립보드 복사 (ChartTable 의 ct-title-clickable 와 동일).
function PlayDataRow({ r }: { r: RowData }): JSX.Element {
  const slotColor = r.diff.color;
  const lampKey = r.lampAbbrStr;
  const isLeg = r.diff.key === 'LEGGENDARIA';
  const ls = lampStyle(r.lampAbbrStr as 'NP' | 'F' | 'AC' | 'EC' | 'NC' | 'HC' | 'EX' | 'FC' | 'PFC');
  const played = r.played;
  const gameLevelLabel = r.gameLevel != null ? String(r.gameLevel) : '-';

  // RATE 바
  let rateBar: JSX.Element;
  if (played && r.noteCount && r.noteCount > 0) {
    const rate = r.exScore / (r.noteCount * 2);
    const pct = Math.max(0, Math.min(1, rate)) * 100;
    const letter = r.djLevel || '-';
    rateBar = (
      <>
        <div className="rate-bg" />
        <div className="rate-fill" style={{ width: `${pct.toFixed(2)}%` }} />
        {RATE_CUTS.map((cut) => (
          <div
            key={cut.name}
            className="rate-cut"
            style={{ left: `${(cut.pct * 100).toFixed(2)}%` }}
            title={`${cut.name} 커트라인 (${(cut.pct * 100).toFixed(2)}%)`}
          />
        ))}
        <span className="rate-text">
          <span
            className="rate-letter"
            data-letter={r.djLevel || ''}
            style={r.djLevel ? { color: LETTER_COLOR[r.djLevel] } : undefined}
          >
            {letter}
          </span>
          <span className="rate-pct">({(rate * 100).toFixed(2)}%)</span>
        </span>
      </>
    );
  } else {
    rateBar = <span className="ct-empty rate-empty">-</span>;
  }

  // zasa★ 라벨 — 있으면 "11.7" 형식, 없으면 빈 문자열. PC: 곡명 앞 span / 모바일: level cell 두번째 줄.
  const zasaLabel = typeof r.zasaLevel === 'number' ? r.zasaLevel.toFixed(1) : '';

  return (
    <div className={`ct-tr${played ? ' played' : ''}`}>
      <div
        className={`ct-cell ct-lamp ct-lamp-${lampKey}`}
        title={ls.label}
      />
      <div className="ct-cell ct-level">
        {/* PC: __pd_level_game 만 보임 (큰 글자). 모바일 (@media): __pd_level_zasa 추가 표시 (작은, 두번째 줄). */}
        <span className="__pd_level_game" style={{ color: slotColor, fontWeight: 700 }}>
          {gameLevelLabel}
        </span>
        <span className="__pd_level_zasa">{zasaLabel}</span>
      </div>
      <div
        className="ct-cell ct-title ct-title-clickable"
        title={`${r.song.title}\n(클릭하면 곡명 클립보드 복사)`}
        style={isLeg ? { color: slotColor } : undefined}
        onClick={() => { void copyToClipboard(r.song.title); }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void copyToClipboard(r.song.title);
          }
        }}
      >
        {/* PC: 곡명 앞 zasa 표기 (예: "11.7 곡명"). 모바일에서는 숨김 (level cell 로 이동). */}
        <span className="__pd_zasa">{zasaLabel}</span>
        {(isLeg ? '† ' : '') + r.song.title}
      </div>
      <div className="ct-cell num">
        {r.layoutLabel && (
          <span className="__pd_layout_badge">{r.layoutLabel || 'N'}</span>
        )}
        {r.noteCount && r.noteCount > 0 ? r.noteCount.toLocaleString() : '-'}
      </div>
      <div className="ct-cell ct-lamp-text">
        {!played ? (
          <span className="ct-empty">NO PLAY</span>
        ) : (
          <span style={{ color: ls.color, fontWeight: 700 }}>{ls.label}</span>
        )}
      </div>
      <div className="ct-cell ct-rate-bar">{rateBar}</div>
      <div className="ct-cell num">
        <span className="ct-mobile-label">SCORE</span>
        <span className="ct-mobile-value">{played && r.exScore > 0 ? r.exScore.toLocaleString() : '-'}</span>
      </div>
      <div className="ct-cell num">
        <span className="ct-mobile-label">MISS</span>
        <span className="ct-mobile-value">{played && r.missCount >= 0 ? r.missCount.toLocaleString() : '-'}</span>
      </div>
    </div>
  );
}

// ─── 시리즈 폴더 컴포넌트 ──────────────────────────────────────────────
interface FolderGroup {
  no: number | null;
  label: string;
  rows: RowData[];           // 그 시리즈의 모든 row (4채보 × 곡 수)
}

function SeriesFolder({
  group,
  curDiff,
  sortKey,
}: {
  group: FolderGroup;
  curDiff: typeof DIFF_CYCLE[number]['key'];
  sortKey: 'title' | 'level' | 'lamp' | 'rate';
}): JSX.Element {
  // 현재 diff filter + 정렬 (검색어는 filter 가 아니라 navigator 라 row 에 적용 X).
  const visibleRows = useMemo(() => {
    const arr = group.rows.filter((r) => matchesDiffFilter(r, curDiff));
    arr.sort((a, b) => compareRows(a, b, sortKey));
    return arr;
  }, [group.rows, curDiff, sortKey]);

  // summary lamp 색박스 — 현재 diff 매치 row 들 중 가장 낮은 lamp.
  //   played 필터와 무관 (미플레이 있으면 폴더는 NP — "이 시리즈 다 안 끝났음" 시각화).
  const summaryLampKey = useMemo(() => {
    let minNum: number | null = null;
    for (const r of group.rows) {
      if (!matchesDiffFilter(r, curDiff)) continue;
      const n = LAMP_KEY_NUM[r.lampAbbrStr] ?? 0;
      if (minNum == null || n < minNum) minNum = n;
    }
    return minNum != null ? LAMP_NUM_KEY[minNum] : 'NP';
  }, [group.rows, curDiff]);

  const playedCount = visibleRows.filter((r) => r.played).length;
  const totalCount = visibleRows.length;

  // 폴더 open 시 scroll — sticky filter 바로 아래에 폴더 summary 가 오도록.
  //   exclusive accordion 의 자동 close 가 layout 변동을 일으키므로 double rAF 후 측정.
  //   이미 viewport (filter 영역 아래) 안에 있으면 scroll skip.
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const handleToggle = (): void => {
    const el = detailsRef.current;
    if (!el || !el.open) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const scrollContainer = el.closest('.content') as HTMLElement | null;
      if (!scrollContainer) return;
      const filterEl = scrollContainer.querySelector('.__uprofile_pdfilter') as HTMLElement | null;
      const stickyOffset = filterEl ? filterEl.getBoundingClientRect().height : 0;
      const tr = el.getBoundingClientRect();
      const cr = scrollContainer.getBoundingClientRect();
      // 이미 sticky filter 아래 + 컨테이너 안에 있으면 skip
      if (tr.top >= cr.top + stickyOffset && tr.top <= cr.bottom - 60) return;
      const y = scrollContainer.scrollTop + (tr.top - cr.top) - stickyOffset;
      scrollContainer.scrollTo({ top: y, behavior: 'auto' });
    }));
  };

  if (totalCount === 0) return <></>;

  return (
    // name 속성 — HTML 의 exclusive accordion. 같은 name 의 details 중 하나만 open.
    // 다른 폴더 열면 현재 폴더 자동 close (오소리웹의 toggle 이벤트 핸들러와 동일 효과).
    // data-no — 검색 드롭다운 클릭 시 panel.querySelector('[data-no="..."]') lookup 키.
    <details
      ref={detailsRef}
      className="__uprofile_pdfolder"
      name="playdata-folders"
      data-no={group.no == null ? '' : String(group.no)}
      onToggle={handleToggle}
    >
      <summary className="__uprofile_pdsummary">
        <span className={`__pd_summarylamp __pd_lamp-${summaryLampKey}`} />
        <span className="__uprofile_pdlabel">{group.label}</span>
        <span className="__uprofile_pdcount">
          <b>{playedCount}</b> / {totalCount}
        </span>
      </summary>
      <div className="ct-table __pd_chart_table">
        <div className="ct-tbody">
          {visibleRows.map((r) => (
            <PlayDataRow key={r.song.song_id + '|' + r.diff.key} r={r} />
          ))}
        </div>
      </div>
    </details>
  );
}

// ─── calcWeakness gist lib 로드 (Analysis 와 같은 module global cache 활용) ─────
// 탭이 별도라 Analysis 와 PlayData 가 동시에 마운트 안 되지만, window.OhsorryWeakness 가
// 한 번 eval 되면 글로벌 cache → 두 컴포넌트 다 재사용 (force=false).
const GIST_RAW = 'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw';
const CALC_WEAKNESS_URL = `${GIST_RAW}/calcWeakness.js`;
const NORM_TITLE_URL = `${GIST_RAW}/normTitle.js`;
const PATTERNS_URL = `${GIST_RAW}/patterns-all-slim.json`;
const RATE_REF_URL = `${GIST_RAW}/rate-reference-slim.json`;

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

// calcWeakness lib 타입 — Analysis.tsx 와 동일하게 any.
//   Analysis 에 정의된 인터페이스가 export 안 됐고 calcWeakness 내부도 거대해서 외부 타입 안 매김.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WeaknessLib = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NormLib = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PatternsMap = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UserVec = any;

// SongChart → calcWeakness chart 형식 (Analysis 와 동일).
const SLOT_TO_DIFF_KEY: Record<string, string> = {
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};
const LAMP_TO_NUM: Record<string, number> = {
  NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7,
};
const DIFF_TO_CN: Record<string, string> = {
  NORMAL: 'DP_NOR', HYPER: 'DP_HYP', ANOTHER: 'DP_ANO', LEGGENDARIA: 'DP_LEG',
};
// calcWeakness 는 DP 패턴만 분석 (patterns-all-slim 의 chart key 가 DP_NOR/DP_HYP/DP_ANO/DP_LEG).
//   SP 데이터를 vec 계산 input 으로 넣으면 안 됨. 항상 DP slot 만 추출.
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

// slot (SPN/DPN 등) → diff filter key. 외부(서열표)에서 곡 클릭 시 diff 토글 맞추는 용도.
const SLOT_TO_DIFF_FILTER: Record<string, string> = {
  SPN: 'NORMAL', SPH: 'HYPER', SPA: 'ANOTHER', SPL: 'LEGGENDARIA',
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};

// ─── 컴포넌트 본체 ──────────────────────────────────────────────────────
interface Props {
  rows: SongRow[];
  zasaData: ZasaData | null;
  ratingData: RatingData | null;
  // 외부(SP 서열표 등)에서 곡 클릭 시 — 토글/diff 맞추고 검색창에 곡명 입력.
  pickTarget?: { title: string; slot: string } | null;
  onPickConsumed?: () => void;
}

export default function PlayData({ rows, zasaData, ratingData, pickTarget, onPickConsumed }: Props): JSX.Element {
  const [songsById, setSongsById] = useState<Map<number, SongEntry> | null>(null);
  const [textageSongs, setTextageSongs] = useState<TextageMeta['songs'] | null>(null);
  const [seriesNames, setSeriesNames] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  // 배치 추천 — calcWeakness lib + patterns + rateRef. 배치 ON 토글 시 layoutMap 생성.
  //   lib 자체는 마운트 시 background fetch (Analysis 와 같은 module global cache). vec 도 자동 계산.
  //   계산 무거우니 layoutMap 은 layoutMode true 일 때만 수행.
  const [libsReady, setLibsReady] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const libsRef = useRef<{ weakness?: WeaknessLib; norm?: NormLib; patterns?: PatternsMap; rateRef?: any }>({});
  const [layoutMode, setLayoutMode] = useState(false);

  // 필터 state
  const [style, setStyle] = useState<'sp' | 'dp'>('dp');  // 기본 DP. 토글 시 SP slot 사용.
  const [diffIdx, setDiffIdx] = useState(2);  // 기본 ANOTHER
  const [sortIdx, setSortIdx] = useState(0);  // 기본 Title
  const [searchQ, setSearchQ] = useState('');
  // 검색 드롭다운 표시 여부. focus / input 시 true, 외부 클릭 / Esc / 아이템 선택 시 false.
  const [showDrop, setShowDrop] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  // 마운트 시: songs 마스터 + textage-meta + series-name 병렬 fetch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [songs, meta, names] = await Promise.all([
          getSongsById(),
          ensureTextageMeta().catch(() => null),
          fetchSeriesNames().catch(() => ({} as Record<string, string>)),
        ]);
        if (cancelled) return;
        setSongsById(songs);
        setTextageSongs(meta?.songs ?? null);
        setSeriesNames(names);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message || '곡 마스터 fetch 실패');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // calcWeakness lib + patterns + rateRef 백그라운드 fetch — 마운트 시 1회.
  //   module global cache (window.OhsorryWeakness / OhsorryNorm) 활용 — Analysis 와 공유.
  //   실패해도 graceful (배치 ON 토글 시 안 됨, 다른 기능엔 영향 없음).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [weakness, normLib, patterns, rateRef] = await Promise.all([
          loadGistModule(CALC_WEAKNESS_URL, 'OhsorryWeakness'),
          loadGistModule(NORM_TITLE_URL, 'OhsorryNorm'),
          loadJson<PatternsMap>(PATTERNS_URL),
          loadJson(RATE_REF_URL),
        ]);
        if (cancelled) return;
        libsRef.current = { weakness, norm: normLib, patterns, rateRef };
        setLibsReady(true);
      } catch (e) {
        console.warn('[PlayData] calcWeakness lib 로드 실패 (배치 추천 비활성):', (e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // user vec — TSV charts + rating + zasa + patterns 입력. layoutMode 무관 미리 계산 (cache).
  //   계산 무겁지만 rows / rating / zasa / libs 변동 시에만 재실행 (useMemo).
  const userVec = useMemo<UserVec | null>(() => {
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
      console.warn('[PlayData] calcUserWeakness 실패:', (e as Error).message);
      return null;
    }
  }, [libsReady, rows, ratingData, zasaData]);

  // patternsMap 의 title norm → song id 인덱스 (chartStrengthMatch8Way 호출 시 sp.c[cn] lookup).
  //   patterns 변동 없으면 1회 빌드.
  const titleToPatternId = useMemo(() => {
    const map: Record<string, string> = {};
    if (!libsReady || !libsRef.current.patterns || !libsRef.current.norm) return map;
    const patterns = libsRef.current.patterns;
    const normFn = libsRef.current.norm.norm;
    for (const id of Object.keys(patterns)) {
      const t = patterns[id]?.t;
      if (!t) continue;
      const k = normFn(t);
      if (k && !map[k]) map[k] = id;
    }
    return map;
  }, [libsReady]);

  // 배치 ON 토글 + vec 준비 시 layoutMap 생성 — 모든 곡 × 4채보 chartStrengthMatch8Way 호출.
  //   OFF 면 null 반환 (RowData.layoutLabel 도 '').
  //   매번 호출은 무겁지만 useMemo 라 vec / layoutMode 변동 시에만 재계산.
  const layoutMap = useMemo<Map<string, string> | null>(() => {
    // SP 모드에선 layoutMap 비활성 — calcWeakness patterns 가 DP 전용 (DP_NOR/HYP/ANO/LEG).
    if (style === 'sp') return null;
    if (!layoutMode || !userVec || !libsReady || !songsById) return null;
    const libs = libsRef.current;
    if (!libs.weakness || !libs.norm || !libs.patterns) return null;
    const out = new Map<string, string>();
    const userMask = 2;
    const normFn = libs.norm.norm;
    let computed = 0;
    for (const [, meta] of songsById) {
      if (!meta.title) continue;
      if (typeof meta.ac !== 'number' || (meta.ac & userMask) === 0) continue;
      const sid = titleToPatternId[normFn(meta.title)];
      if (!sid) continue;
      const sp = libs.patterns[sid];
      if (!sp?.c) continue;
      const showLeg = typeof meta.legen === 'number' && (meta.legen & userMask) !== 0;
      for (const d of PD_DIFFS) {
        if (d.key === 'LEGGENDARIA' && !showLeg) continue;
        const cn = DIFF_TO_CN[d.key];
        if (!cn || !sp.c[cn]) continue;
        try {
          const r = libs.weakness.chartStrengthMatch8Way(sp.c[cn], userVec);
          const label = r?.bestLabel;
          if (typeof label === 'string') {
            out.set(normFn(meta.title) + '|' + d.key, label);
            computed++;
          }
        } catch {
          /* 한 차트 실패는 graceful skip */
        }
      }
    }
    console.log(`[PlayData] layoutMap 계산 완료 — ${computed}개 차트`);
    return out;
  }, [layoutMode, userVec, libsReady, songsById, titleToPatternId, style]);

  // zasa-data → (norm(title) + '|' + diffStr) → zasa★ level. 곡명 앞 zasa 표기에 사용.
  const zasaIndex = useMemo(() => {
    const m = new Map<string, number>();
    if (!zasaData?.charts) return m;
    for (const z of zasaData.charts) {
      if (!z || !z.title || !z.diff) continue;
      if (typeof z.level !== 'number') continue;
      m.set(norm(z.title) + '|' + z.diff, z.level);
    }
    return m;
  }, [zasaData]);

  // TSV → (norm(title) + '|' + slot) → cell 인덱스. PlayDataRow 매칭에 사용.
  //   style 별 DP/SP slot 만 인덱싱 (다른 style 의 cell 은 RowData 에 쓰이지 않으므로 skip).
  const tsvIdx = useMemo(() => {
    const m = new Map<string, NonNullable<SongRow['charts'][ChartSlot]>>();
    const slots = (style === 'sp'
      ? ['SPN', 'SPH', 'SPA', 'SPL']
      : ['DPN', 'DPH', 'DPA', 'DPL']
    ) as ChartSlot[];
    for (const r of rows) {
      const titleKey = norm(r.title);
      for (const slot of slots) {
        const cell = r.charts[slot];
        if (!cell) continue;
        m.set(titleKey + '|' + slot, cell);
      }
    }
    return m;
  }, [rows, style]);

  // songs 마스터를 series_no 별로 그룹화. INF 비트 (ac & 2) 없는 곡은 skip.
  //   곡 정렬: song_id asc. 폴더 순서: series_no desc, null 그룹 맨 끝.
  const groups = useMemo<FolderGroup[]>(() => {
    if (!songsById) return [];
    const userMask = 2;
    const buckets = new Map<string, { no: number | null; songs: SongEntry[] }>();
    for (const [, meta] of songsById) {
      if (!meta.title) continue;
      if (typeof meta.ac !== 'number' || (meta.ac & userMask) === 0) continue;
      const noKey = meta.series_no == null ? 'null' : String(meta.series_no);
      let b = buckets.get(noKey);
      if (!b) { b = { no: meta.series_no ?? null, songs: [] }; buckets.set(noKey, b); }
      b.songs.push(meta);
    }
    for (const b of buckets.values()) b.songs.sort((a, b2) => a.song_id - b2.song_id);
    const ordered: FolderGroup[] = Array.from(buckets.keys())
      .filter((k) => k !== 'null')
      .map((k) => parseInt(k, 10))
      .sort((a, b) => b - a)
      .map((no) => buckets.get(String(no))!)
      .map((b) => ({
        no: b.no,
        label: b.no == null ? '?' : (seriesNames[String(b.no)] || String(b.no)),
        rows: b.songs.flatMap((s) => songRowsData(s, tsvIdx, textageSongs, zasaIndex, layoutMap, style)),
      }));
    if (buckets.has('null')) {
      const b = buckets.get('null')!;
      ordered.push({
        no: null, label: '?',
        rows: b.songs.flatMap((s) => songRowsData(s, tsvIdx, textageSongs, zasaIndex, layoutMap, style)),
      });
    }
    return ordered;
  }, [songsById, textageSongs, seriesNames, tsvIdx, zasaIndex, layoutMap, style]);

  // 검색 인덱스 — groups 의 모든 곡 (title 단위 dedup, no 별로 묶음). 입력 시 includes 매칭.
  const searchIndex = useMemo(() => {
    const out: { title: string; no: number | null }[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
      for (const r of g.rows) {
        const key = (g.no == null ? 'n' : String(g.no)) + '|' + r.song.title;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ title: r.song.title, no: g.no });
      }
    }
    return out;
  }, [groups]);

  // 검색 매칭 결과 — 최대 50개 표시 (오소리웹은 무제한이지만 너무 길면 dropdown 이 폭발).
  //   norm() 정규화 후 includes — 공백/특수문자/전각 차이 무시 (서열표 등 외부 곡명도 매칭).
  //   raw lowercase 부분일치도 fallback 으로 허용 (사용자가 일부 기호 그대로 입력하는 경우).
  const matchedSongs = useMemo(() => {
    const raw = searchQ.trim().toLowerCase();
    if (!raw) return [];
    const nq = norm(searchQ);
    const out: { title: string; no: number | null }[] = [];
    for (const s of searchIndex) {
      const matched = (nq && norm(s.title).includes(nq)) || s.title.toLowerCase().includes(raw);
      if (matched) {
        out.push(s);
        if (out.length >= 50) break;
      }
    }
    return out;
  }, [searchQ, searchIndex]);

  // 외부 클릭 시 drop 닫기 (오소리웹과 동일 패턴).
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const wrap = searchWrapRef.current;
      if (!wrap) return;
      if (!wrap.contains(e.target as Node)) setShowDrop(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // 외부(SP 서열표 등)에서 곡 클릭 — 토글(SP/DP) + diff 를 해당 곡에 맞추고 검색창에 곡명 입력.
  //   검색창 입력 → 드롭다운 표시 → 사용자가 항목 클릭 시 onPickSearch 로 점프 (기존 검색 UX).
  useEffect(() => {
    if (!pickTarget) return;
    const slot = pickTarget.slot || '';
    if (slot.startsWith('SP')) setStyle('sp');
    else if (slot.startsWith('DP')) setStyle('dp');
    const diffKey = SLOT_TO_DIFF_FILTER[slot];
    if (diffKey) {
      const idx = DIFF_CYCLE.findIndex((d) => d.key === diffKey);
      if (idx >= 0) setDiffIdx(idx);
    }
    setSearchQ(pickTarget.title);
    setShowDrop(true);
    onPickConsumed?.();
    // onPickConsumed 는 매 렌더 새 함수일 수 있어 deps 제외 — pickTarget 변동 시에만 적용.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickTarget]);

  // 드롭다운 아이템 클릭 — 폴더 open + 200ms 후 해당 row 로 scroll + highlight.
  //   폴더 open=true 가 다른 폴더 자동 close (exclusive accordion), SeriesFolder 의 onToggle 이
  //   먼저 폴더 위치로 scroll (auto, instant). 그 후 setTimeout 으로 row 위치로 smooth scroll.
  const onPickSearch = (title: string, no: number | null): void => {
    setShowDrop(false);
    setSearchQ('');
    searchInputRef.current?.blur();
    const panel = panelRef.current;
    if (!panel) return;
    const noAttr = no == null ? '' : String(no);
    const folder = panel.querySelector(
      `details.__uprofile_pdfolder[data-no="${noAttr}"]`,
    ) as HTMLDetailsElement | null;
    if (!folder) return;
    folder.open = true;
    setTimeout(() => {
      // 폴더 안 ct-tr 의 ct-title 의 title 속성 (= 곡명) 으로 매칭.
      const rows = Array.from(folder.querySelectorAll('.ct-tr')) as HTMLElement[];
      let target: HTMLElement | null = null;
      for (const r of rows) {
        const titleCell = r.querySelector('.ct-title') as HTMLElement | null;
        if (!titleCell) continue;
        const actual = (titleCell.getAttribute('title') || '').split('\n')[0];
        if (actual === title) { target = r; break; }
      }
      if (!target) return;
      target.classList.add('__pd_highlight');
      setTimeout(() => target?.classList.remove('__pd_highlight'), 2500);
      // ct-tr 은 display: contents 라 자체 rect 없음 — 첫 cell 의 rect 사용.
      const firstCell = target.querySelector('.ct-cell') as HTMLElement | null;
      const scrollEl = firstCell || target;
      const container = panel.closest('.content') as HTMLElement | null;
      const filterEl = panel.querySelector('.__uprofile_pdfilter') as HTMLElement | null;
      if (!container || !filterEl) {
        scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const stickyOffset = filterEl.getBoundingClientRect().height;
      const tr = scrollEl.getBoundingClientRect();
      const cr = container.getBoundingClientRect();
      const y = container.scrollTop + (tr.top - cr.top) - stickyOffset - 8;
      container.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }, 200);
  };

  if (loadError) {
    return <p className="__uprofile_tabempty">곡 마스터 fetch 실패: {loadError}</p>;
  }
  if (!songsById) {
    return <p className="__uprofile_tabempty">불러오는 중...</p>;
  }

  const curDiff = DIFF_CYCLE[diffIdx];
  const curSort = SORT_CYCLE[sortIdx];

  return (
    <div ref={panelRef}>
      {/* 상단 필터 */}
      <div className="__uprofile_pdfilter">
        {/* SP/DP 토글 — 검색창 왼쪽. 기본 DP. SP 모드에선 배치 라벨 자동 비활성.
            data-style 으로 색 분기 (SP=하늘색, DP=빨강) — 배경 X, 글자색/테두리만. */}
        <button
          type="button"
          className="__uprofile_pdtoggle __pd_styletoggle"
          data-style={style}
          onClick={() => setStyle((s) => (s === 'dp' ? 'sp' : 'dp'))}
          title="SP / DP 토글"
        >
          {style.toUpperCase()}
        </button>
        <div className="__pd_search_wrap" ref={searchWrapRef}>
          <input
            ref={searchInputRef}
            type="text"
            className="__pd_searchbox"
            placeholder="곡명 검색"
            value={searchQ}
            onChange={(e) => { setSearchQ(e.target.value); setShowDrop(true); }}
            onFocus={() => { if (searchQ.trim()) setShowDrop(true); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchQ('');
                setShowDrop(false);
                searchInputRef.current?.blur();
              }
            }}
          />
          {showDrop && searchQ.trim() && (
            <div className="__pd_search_drop">
              {matchedSongs.length === 0 ? (
                <div className="__pd_search_empty">결과 없음</div>
              ) : (
                matchedSongs.map((s) => (
                  <div
                    key={(s.no == null ? 'n' : s.no) + '|' + s.title}
                    className="__pd_search_item"
                    onClick={() => onPickSearch(s.title, s.no)}
                    role="button"
                    tabIndex={0}
                  >
                    {s.title}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className="__uprofile_pdtoggle active __pd_difffilter"
          style={{ borderColor: curDiff.color, color: curDiff.color }}
          onClick={() => setDiffIdx((i) => (i + 1) % DIFF_CYCLE.length)}
        >
          {curDiff.label}
        </button>
        <button
          type="button"
          className="__uprofile_pdtoggle active __pd_sortbtn"
          onClick={() => setSortIdx((i) => (i + 1) % SORT_CYCLE.length)}
        >
          {curSort.label}
        </button>
        <button
          type="button"
          className={`__uprofile_pdtoggle __pd_layoutbtn${layoutMode ? ' active' : ''}`}
          disabled={!libsReady}
          title={
            !libsReady
              ? 'calcWeakness lib 로딩 중'
              : layoutMode
                ? '배치 라벨 끄기'
                : '배치 라벨 켜기 (전체 차트 chartStrengthMatch8Way 호출 — 1~2초)'
          }
          onClick={() => setLayoutMode((v) => !v)}
        >
          배치 {layoutMode ? 'ON' : 'OFF'}
        </button>
      </div>
      {/* 시리즈 폴더 목록 */}
      <div className="__uprofile_pdfolders">
        {groups.map((g) => (
          <SeriesFolder
            key={g.no == null ? 'null' : String(g.no)}
            group={g}
            curDiff={curDiff.key}
            sortKey={curSort.key}
          />
        ))}
      </div>
    </div>
  );
}
