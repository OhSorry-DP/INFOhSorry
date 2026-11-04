// Recent 탭 — 업로드 날짜별 곡 변동 (오소리웹 populateRecent UI 포팅).
//
// 두 가지 source mix:
//   - "오늘 (라이브)" : TSV 의 현재 row vs supabase 마지막 row (make_grid_data dedup) diff.
//     supabase 마지막 업로드 이후 lamp/ex/djLevel 변동 있는 차트만. 신규 / 오프라인 (latest 미로드) 면
//     PREV 없이 TSV row 전체 나열.
//   - "이전 날짜" : make_recent_dates / make_recent_data RPC — 오소리웹과 같은 prev → now 표기.
//
// 디자인: 오소리웹 ohSorryWeb/styles.css 의 .__pd_rec* / .__pd_lamp-* / .__uprofile_rc* CSS 그대로 사용
// (index.css 에 복사). 헤더 < 날짜 > N곡, 6 컬럼 grid (lamp / LV / 곡명 / LAMP변동 / DJ변동 / SCORE변동).
//
// 행 클릭 → DP 탭으로 이동 + 해당 곡 검색 (App.tsx 의 scrollTarget 패턴).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChartSlot, SongRow } from '../../shared/types';
import { DP_SLOTS } from '../../shared/types';
import { norm } from '../../shared/match';
import {
  fetchRecentDates,
  fetchRecentCharts,
  fetchUserLatestCharts,
  loadDbrMap,
  ensureTextageMeta,
  buildUploadPlays,
  type RecentChartRow,
  type LatestChartEntry,
} from './supabaseSync';
import { isPlayErrorRow, type PlayCsvRow, type PlayDetail, type SideDetail } from '../../shared/uploadSnapshot';
import { LAMP_NUM_TO_ABBR } from './lampStyle';
import { lampStyle } from './lampStyle';

function playLampLabel(value: unknown): string {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return '—';
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 0 || number > 7) return '—';
  const abbr = LAMP_NUM_TO_ABBR[number];
  return abbr ? lampStyle(abbr as import('../../shared/types').Lamp).label : '—';
}

function playMissLabel(value: unknown): string {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return '—';
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 0 ? String(number) : '—';
}

// diff (NORMAL/HYPER/ANOTHER/LEGGENDARIA) → slot 색 (오소리웹 DIFF_COLOR 동일).
const DIFF_COLOR: Record<string, string> = {
  NORMAL: '#74c0fc', HYPER: '#efef51', ANOTHER: '#fba8c1', LEGGENDARIA: '#ce8ef9', BEGINNER: '#868e96',
};

// 풀네임 lamp → 약어 (HARD → HC). LAMP 색 cell 의 클래스 키 (__pd_lamp-HC) 와 동일.
const LAMP_FULL_TO_ABBR: Record<string, string> = {
  'NO PLAY': 'NP', 'FAILED': 'F', 'ASSIST': 'AC', 'EASY': 'EC',
  'CLEAR': 'NC', 'HARD': 'HC', 'EX HARD': 'EX', 'FULL COMBO': 'FC',
};
function lampAbbr(lampStr: string | null | undefined): string {
  if (lampStr == null) return '-';
  return LAMP_FULL_TO_ABBR[lampStr] || lampStr;
}

// 약어 / 풀네임 어느 쪽이 와도 lamp 텍스트 색 매핑 (오소리웹 LAMP_TEXT_COLOR).
const LAMP_TEXT_COLOR: Record<string, string> = {
  'NO PLAY': '#6c757d', 'NP': '#6c757d',
  'FAILED': '#dc3545', 'F': '#dc3545',
  'ASSIST': '#9966cc', 'AC': '#9966cc',
  'EASY': '#7bc16a', 'EC': '#7bc16a',
  'CLEAR': '#5cb8ea', 'NC': '#5cb8ea',
  'HARD': '#e9ecef', 'HC': '#e9ecef',
  'EX HARD': '#dcaf45', 'EX': '#dcaf45',
  'FULL COMBO': '#74c0fc', 'FC': '#74c0fc',
  'PERFECT FC': '#74c0fc', 'PFC': '#74c0fc',
};
function lampTextColor(lampStr: string | null | undefined): string {
  if (!lampStr) return '#6c757d';
  return LAMP_TEXT_COLOR[lampStr] || '#6c757d';
}

// DJ Level 글자 색 (오소리웹 DJ_LETTER_COLOR).
const DJ_LETTER_COLOR: Record<string, string> = {
  AAA: '#dcaf45', AA: '#dcaf45', A: '#52a447', B: '#74c0fc',
  C: '#888', D: '#888', E: '#ff6b6b', F: '#ff6b6b',
};
function djLetterColor(letter: string | null | undefined): string {
  if (!letter) return '#6c757d';
  return DJ_LETTER_COLOR[letter] || '#6c757d';
}

// 다음 DJ Level 컷까지 부족분 — exScore 가 컷 중간 지점 이상이면 "{다음}-{diff}", 미만이면 "{현재}+{diff}".
// AAA 면 다음 = MAX. 데이터 부족 → 빈 문자열. (오소리웹 nextGradeDiff 와 동일 로직.)
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

// EX score → DJ Level (클라이언트 계산, 오소리웹 djLevelFromScore 와 동일).
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

// ChartSlot (DPN/DPH/DPA/DPL) → diff 문자열 (NORMAL/HYPER/ANOTHER/LEGGENDARIA).
const SLOT_TO_DIFF: Record<string, string> = {
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};

// TSV row → RecentChartRow 변환 (당일 박스에서 사용).
//   prev 가 있으면 supabase latest entry 의 lamp/ex/dj 로 세팅.
function rowToRecent(
  title: string,
  slot: ChartSlot,
  cell: { lamp: string; exScore: number; letter: string; noteCount: number; level: number },
  prev: LatestChartEntry | null,
): RecentChartRow {
  const diffStr = SLOT_TO_DIFF[slot] || 'ANOTHER';
  const lampAbbrStr = cell.lamp || 'NP';
  // INFOhSorry 의 lamp 는 이미 약어 (NP/F/AC/EC/NC/HC/EX/FC/PFC). 풀네임 변환 — 표시 통일.
  const ABBR_TO_FULL: Record<string, string> = {
    NP: 'NO PLAY', F: 'FAILED', AC: 'ASSIST', EC: 'EASY', NC: 'CLEAR',
    HC: 'HARD', EX: 'EX HARD', FC: 'FULL COMBO', PFC: 'FULL COMBO',
  };
  const lampFull = ABBR_TO_FULL[lampAbbrStr] || lampAbbrStr;
  const exScore = typeof cell.exScore === 'number' ? cell.exScore : 0;
  const noteCount = typeof cell.noteCount === 'number' && cell.noteCount > 0 ? cell.noteCount : null;
  const gameLevel = typeof cell.level === 'number' ? cell.level : null;
  // INFOhSorry 의 letter (DJ Level) 가 비어 있을 수 있음 — fallback 으로 ex/note 계산.
  const djLevel = cell.letter || djLevelFromScore(exScore, noteCount);
  return {
    title,
    diff: diffStr,
    lamp: lampFull,
    lampAbbr: lampAbbrStr,
    exScore,
    prevLamp: prev?.lamp ?? null,
    prevLampAbbr: prev?.lampAbbr ?? null,
    prevExScore: prev?.exScore ?? null,
    prevPlayedVersion: prev?.playedVersion ?? null,
    playedVersion: 0,  // INFOhSorry 는 항상 INF
    djLevel,
    prevDjLevel: prev?.djLevel ?? null,
    gameLevel: gameLevel ?? prev?.gameLevel ?? null,
    noteCount: noteCount ?? prev?.noteCount ?? null,
    textageSongId: null,  // 당일 라이브(TSV)는 DP 전용 — DBR 매칭 불필요
    date: null,
  };
}

// "당일" 박스의 곡 목록 계산 — TSV DP row 중 supabase latest 와 diff 있는 차트.
//   latestIdx 가 null (오프라인 / 미로드) 이면 모든 차트 (lampNum > 0) 나열, PREV 없음.
function computeTodayCharts(
  rows: SongRow[],
  latestIdx: Map<string, LatestChartEntry> | null,
): RecentChartRow[] {
  const out: RecentChartRow[] = [];
  for (const r of rows) {
    for (const slot of DP_SLOTS) {
      const cell = r.charts[slot];
      if (!cell || !cell.unlocked) continue;
      const lampAbbrStr = cell.lamp || 'NP';
      const exScore = typeof cell.exScore === 'number' ? cell.exScore : 0;
      // 미플레이는 항상 skip
      if (lampAbbrStr === 'NP' && exScore <= 0) continue;
      const diffStr = SLOT_TO_DIFF[slot] || 'ANOTHER';
      const key = norm(r.title) + '|' + diffStr;
      const prev = latestIdx ? latestIdx.get(key) || null : null;
      if (latestIdx && prev) {
        // 변동 비교 — lamp / ex / djLevel 중 하나라도 다르면 표시.
        const lampSame = prev.lampAbbr === lampAbbrStr;
        const exSame = prev.exScore === exScore;
        const djSame = (prev.djLevel || '') === (cell.letter || '');
        if (lampSame && exSame && djSame) continue;
      }
      out.push(rowToRecent(r.title, slot, cell, prev));
    }
  }
  return out;
}

// 행 정렬 — gameLevel desc → exScore desc → title (안정성).
function sortRows(charts: RecentChartRow[]): RecentChartRow[] {
  return [...charts].sort((a, b) => {
    const la = typeof a.gameLevel === 'number' ? a.gameLevel : -Infinity;
    const lb = typeof b.gameLevel === 'number' ? b.gameLevel : -Infinity;
    if (la !== lb) return lb - la;
    const ea = a.exScore || 0;
    const eb = b.exScore || 0;
    if (ea !== eb) return eb - ea;
    return a.title.localeCompare(b.title);
  });
}

// DBR 모드 정렬 — DBR 난이도(dbrLevel) desc → date desc (오소리웹 동일).
function sortDbrRows(charts: RecentChartRow[], dbrMap: Map<string, number> | null): RecentChartRow[] {
  const lvOf = (c: RecentChartRow): number => {
    const dl = dbrMap?.get((c.textageSongId || '') + '|' + c.diff);
    return typeof dl === 'number' ? dl : -Infinity;
  };
  return [...charts].sort((a, b) => {
    const la = lvOf(a);
    const lb = lvOf(b);
    if (la !== lb) return lb - la;
    return (b.date || '').localeCompare(a.date || '');
  });
}

interface Props {
  rows: SongRow[];
  iidxId: string | null;
  onPickChart: (target: { title: string; slot: ChartSlot; gameLevel: number | null }) => void;
}

// 시스템 시간 기준 오늘 KST 날짜 (YYYY-MM-DD).
//   Intl.DateTimeFormat 으로 Asia/Seoul timezone 강제 변환 — 사용자 PC 가 KST 가 아니더라도
//   supabase 의 date_kst (서버 측 KST 변환) 와 일관된 비교 가능.
//   en-CA locale 이 YYYY-MM-DD 형식 반환.
function getTodayKst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function subscribeRecentPlays(iidxId: string, update: (rows: PlayCsvRow[], error: string | null) => void): () => void {
  const upload = window.infohsorry.upload;
  const readPlayCsv = upload.readPlayCsv;
  if (!readPlayCsv) {
    update([], 'Play history is unavailable');
    return () => {};
  }
  let active = true;
  let request = 0;
  const refresh = async () => {
    const current = ++request;
    try {
      const result = await readPlayCsv(iidxId);
      if (!active || current !== request) return;
      update(buildUploadPlays(result).slice(-100), result.ok ? null : 'Could not read play history');
    } catch (error) {
      if (!active || current !== request) return;
      update([], (error as Error).message || 'Could not read play history');
    }
  };
  void refresh();
  const unsubscribe = upload.onPlayAppend?.((event) => {
    if (event.iidxId.replace(/-/g, '').trim() === iidxId) void refresh();
  });
  return () => {
    active = false;
    request++;
    unsubscribe?.();
  };
}

function recentPlayTime(timestamp: string | null | undefined): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  const month = part('month'); const day = part('day'); const hour = part('hour'); const minute = part('minute');
  return month && day && hour && minute ? `${month}-${day} ${hour}:${minute}` : '—';
}

function detailSideHidden(side: SideDetail | null | undefined): boolean {
  if (!side || !Array.isArray(side.lanes) || side.lanes.length !== 8 || side.lanes.some((lane) => !Array.isArray(lane) || lane.length !== 6 || lane.some((value) => typeof value !== 'number' || value !== 0))) return false;
  return side.fs === null || (side.fs != null && [side.fs.fast_great, side.fs.fast_good, side.fs.slow_great, side.fs.slow_good].every((value) => typeof value === 'number' && value === 0));
}

function playChartLevel(play: PlayCsvRow, rows: SongRow[], textage: Awaited<ReturnType<typeof ensureTextageMeta>>): number | null {
  const diff = play.difficulty?.replace(/^(SP|DP)/, '');
  const mode = play.difficulty?.startsWith('DP') ? 'DP' : 'SP';
  const slot = diff ? `${mode}${diff}` as ChartSlot : null;
  const title = norm(play.title || '');
  if (!slot || !title) return null;
  const matches = rows.filter((row) => norm(row.title) === title);
  if (matches.length === 1) {
    const level = matches[0].charts[slot]?.level;
    if (typeof level === 'number' && Number.isFinite(level)) return level;
  }
  if (matches.length > 1) return null;
  const key: Record<string, string> = mode === 'DP'
    ? { N: 'DN', H: 'DH', A: 'DA', L: 'DX' }
    : { N: 'SN', H: 'SH', A: 'SA', L: 'SX' };
  const metaKey = key[diff || ''];
  if (!metaKey || !textage?.songs) return null;
  const songs = Object.values(textage.songs).filter((song) => norm(song.title || '') === title);
  const levels = songs.map((song) => song.levels?.[metaKey]).filter((level): level is number => typeof level === 'number' && Number.isFinite(level));
  return levels.length === 1 ? levels[0] : null;
}

function playOptionInfo(play: PlayCsvRow): string {
  const parse = (raw: string | undefined): number[] | null => {
    if (!raw || !/^\s*\d+(?:\s+\d+)*\s*$/.test(raw)) return null;
    return raw.trim().split(/\s+/).map(Number);
  };
  const p1 = parse(play.settings_p1_11);
  const p2 = parse(play.settings_p2_11);
  const battle = play.battle_flag === '1';
  const dp = play.difficulty?.startsWith('DP');
  const label = (n: number | undefined) => Number.isInteger(n) && n! >= 0 && n! <= 6 ? ['OFF', 'RAN', 'R-RAN', 'S-RAN', 'MIR', 'SYNCHRONIZE RANDOM', 'SYMMETRY RANDOM'][n!] : '—';
  const items: string[] = [];
  if (battle) items.push('BATTLE');
  if (p1?.[3] === 1) items.push('FLIP');
  if (battle || dp) items.push(`${label(p1?.[0])} / ${label(p1?.[5])}`);
  else items.push(`${label(p1?.[0])} / ${label(p2?.[0])}`);
  return items.join(', ');
}

type RecentPlayListState = { accountId: string; rows: PlayCsvRow[]; signature: string; openKeys: Set<string> };

function recentPlayRows(rows: PlayCsvRow[], normalizedId: string): { play: PlayCsvRow; rowKey: string }[] {
  const occurrences = new Map<string, number>();
  return rows.map((play) => {
    const rowText = JSON.stringify(play);
    const occurrence = occurrences.get(rowText) ?? 0;
    occurrences.set(rowText, occurrence + 1);
    return { play, rowKey: JSON.stringify([normalizedId, rowText, occurrence]) };
  });
}

function initialRecentOpenKeys(rows: PlayCsvRow[], normalizedId: string): Set<string> {
  const keyedRows = recentPlayRows(rows, normalizedId);
  const latest = keyedRows[keyedRows.length - 1];
  return latest && !isPlayErrorRow(latest.play) ? new Set([latest.rowKey]) : new Set();
}

function playOptionDisplay(play: PlayCsvRow): string {
  if (play.battle_flag === '1' || play.difficulty?.startsWith('DP')) return playOptionInfo(play);
  const side = playSideActivity(play);
  if (side !== 'P1' && side !== 'P2') return playOptionInfo(play);
  const raw = side === 'P1' ? play.settings_p1_11 : play.settings_p2_11;
  if (!raw || !/^\s*\d+(?:\s+\d+)*\s*$/.test(raw)) return '—';
  const value = Number(raw.trim().split(/\s+/)[0]);
  return Number.isInteger(value) && value >= 0 && value <= 6
    ? ['OFF', 'RANDOM', 'R-RANDOM', 'S-RANDOM', 'MIRROR', 'SYNCHRONIZE RANDOM', 'SYMMETRY RANDOM'][value]
    : '—';
}

function playSideActivity(play: PlayCsvRow): 'P1' | 'P2' | 'BOTH' | null {
  if (play.battle_flag === '1' || play.difficulty?.startsWith('DP')) return 'BOTH';
  const parts = play.judge_16?.trim().split(/\s+/) ?? [];
  if (parts.length !== 16 || parts.some((value) => !/^\d+$/.test(value))) return null;
  const sums = [parts.slice(0, 5), parts.slice(5, 10)].map((side) => side.reduce((sum, value) => sum + Number(value), 0));
  return sums[0] > 0 && sums[1] === 0 ? 'P1' : sums[1] > 0 && sums[0] === 0 ? 'P2' : null;
}

function displayLaneOrder(raw: string | undefined, side: 'P1' | 'P2', play: PlayCsvRow): string {
  const activity = playSideActivity(play);
  if (!raw || activity == null || (activity !== 'BOTH' && activity !== side)) return '—';
  const order = raw.trim().split('').map(Number);
  if (!/^\d{7}$/.test(raw.trim()) || [...order].sort((a, b) => a - b).join('') !== '0123456') return '—';
  const settings = (side === 'P1' ? play.settings_p1_11 : play.settings_p2_11);
  const parsed = settings && /^\s*\d+(?:\s+\d+)*\s*$/.test(settings) ? settings.trim().split(/\s+/).map(Number) : null;
  const option = play.battle_flag === '1' || play.difficulty?.startsWith('DP') ? parsed?.[side === 'P1' ? 0 : 5] : parsed?.[0];
  if (option === 3) return '—';
  return order.map((value) => value + 1).join('');
}

function laneCounterIndex(key: number | 'scratch'): number {
  return key === 'scratch' ? 7 : Number.isInteger(key) && key >= 1 && key <= 7 ? key - 1 : -1;
}

function laneEvaluation(side: SideDetail | null | undefined): { notes: number; ex: number; rank: string; rate: string } | null {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!side?.lanes_ok || !Array.isArray(side.lanes) || side.lanes.length !== 8 || side.lanes.some((lane) => !Array.isArray(lane) || lane.length !== 6 || lane.some((value) => !valid(value)))) return null;
  const sums = [0, 0, 0, 0, 0];
  for (const lane of side.lanes) for (let i = 0; i < 5; i++) sums[i] += lane[i];
  const notes = sums.reduce((a, b) => a + b, 0);
  if (notes === 0) return { notes, ex: 0, rank: '—', rate: '—' };
  const ex = sums[0] * 2 + sums[1];
  const ratio = ex / (notes * 2);
  const rank = ex === 0 ? 'F' : ratio >= 8 / 9 ? 'AAA' : ratio >= 7 / 9 ? 'AA' : ratio >= 6 / 9 ? 'A' : ratio >= 5 / 9 ? 'B' : ratio >= 4 / 9 ? 'C' : ratio >= 3 / 9 ? 'D' : ratio >= 2 / 9 ? 'E' : 'F';
  return { notes, ex, rank, rate: `${(ratio * 100).toFixed(2)}%` };
}

function laneKeyEvaluation(side: SideDetail | null | undefined, index: number): { notes: number; ex: number; rank: string; rate: string } | null {
  const lane = side?.lanes?.[index];
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!side?.lanes_ok || !Array.isArray(lane) || lane.length !== 6 || lane.some((value) => !valid(value))) return null;
  const notes = lane.slice(0, 5).reduce((sum, value) => sum + value, 0);
  if (notes === 0) return { notes, ex: 0, rank: '—', rate: '—' };
  const ex = lane[0] * 2 + lane[1];
  const rank = ex === 0 ? 'F' : djLevelFromScore(ex, notes) || '—';
  return { notes, ex, rank, rate: `${(ex / (notes * 2) * 100).toFixed(2)}%` };
}

function PlayLaneController({ side, player, activity, accountKey }: { side: SideDetail | null | undefined; player: 'P1' | 'P2'; activity: 'P1' | 'P2' | 'BOTH' | null; accountKey?: string | null }): JSX.Element {
  const [openKey, setOpenKey] = useState<number | 'scratch' | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useMemo(() => ({ current: null as HTMLButtonElement | null }), []);
  useEffect(() => {
    if (openKey == null) return;
    const close = () => setOpenKey(null);
    const outside = (event: PointerEvent) => { const target = event.target as Element | null; if (target && !target.closest('.__uprofile_play_controller') && !target.closest('.__uprofile_play_keydetail')) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpenKey(null); trigger.current?.focus(); } };
    document.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [openKey, trigger]);
  useEffect(() => { setOpenKey(null); }, [accountKey]);
  const inactive = activity != null && activity !== 'BOTH' && activity !== player;
  const key = (number: number | 'scratch', className: string, label: string) => {
    const index = laneCounterIndex(number);
    const id = `play-key-detail-${player}-${number}`;
    const open = (button: HTMLButtonElement) => { trigger.current = button; const r = button.getBoundingClientRect(); const height = Math.min(360, window.innerHeight - 16); const top = r.bottom + height > window.innerHeight - 8 ? Math.max(8, r.top - height) : r.bottom; setPosition({ top, left: Math.max(8, Math.min(r.left, window.innerWidth - 320)) }); setOpenKey(number); };
    const evaluation = index >= 0 ? laneKeyEvaluation(side, index) : null;
    const rankClass = number === 'scratch' ? '__uprofile_play_rank_scratch' : Number(number) % 2 === 0 ? '__uprofile_play_rank_black' : '__uprofile_play_rank_white';
    const tileClass = number === 'scratch' ? '' : `__uprofile_play_pattern_tile ${Number(number) % 2 === 1 ? '__uprofile_play_pattern_tile_white' : '__uprofile_play_pattern_tile_black'}`;
    return <div className={`__uprofile_play_unit ${className}`} key={String(number)} data-key={number === 'scratch' ? undefined : number}>
      <button type="button" className={inactive ? '__uprofile_play_inactive' : undefined} aria-label={`${player === 'P1' ? '1P' : '2P'} ${label === 'SCRATCH' ? '스크래치' : `건반 ${label}`}`} aria-expanded={openKey === number} aria-describedby={openKey === number ? id : undefined} onMouseEnter={(event) => open(event.currentTarget)} onFocus={(event) => open(event.currentTarget)} onClick={(event) => { if (openKey === number) setOpenKey(null); else open(event.currentTarget); }}>{number === 'scratch' ? <span>{label}</span> : <span className={tileClass}><span className="__uprofile_play_pattern_digit">{label}</span></span>}</button>
      <span className={`__uprofile_play_rank ${rankClass}${inactive ? ' __uprofile_play_rank_inactive' : ''}`} aria-hidden="true" tabIndex={-1}>{inactive ? '' : evaluation?.rank ?? '—'}</span>
    </div>;
  };
  const keys = Array.from({ length: 7 }, (_, index) => index + 1);
  return <><div className="__uprofile_play_controller" data-player={player} onMouseLeave={(event) => { if (!event.currentTarget.parentElement?.querySelector('.__uprofile_play_keydetail')?.contains(event.relatedTarget as Node)) setOpenKey(null); }}>
    {player === 'P1' && key('scratch', '__uprofile_play_unit_scratch', 'SCRATCH')}
    <div className="__uprofile_play_keyboard">{keys.map((number) => key(number, `__uprofile_play_unit_${number % 2 === 1 ? 'white' : 'black'}`, String(number)))}</div>
    {player === 'P2' && key('scratch', '__uprofile_play_unit_scratch', 'SCRATCH')}
  </div>{openKey != null && position && createPortal(<div id={`play-key-detail-${player}-${openKey}`} onMouseEnter={() => {}} onMouseLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpenKey(null); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpenKey(null); }} style={{ position: 'fixed', zIndex: 10000, top: position.top, left: position.left, width: 'min(560px, calc(100vw - 16px))', maxWidth: 'calc(100vw - 16px)', maxHeight: 'min(52vh, 360px)', overflow: 'auto' }}><PlayLaneDetail side={side} index={laneCounterIndex(openKey)} /></div>, document.body)}</>;
}

function PlayLaneDetail({ side, index }: { side: SideDetail | null | undefined; index: number }): JSX.Element {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const evaluation = laneKeyEvaluation(side, index);
  const names = ['PG', 'GR', 'GD', 'BD', 'PR', '空PR', 'F-GR', 'F-GD', 'S-GR', 'S-GD'];
  return <div className="__uprofile_play_keydetail">
    <div className="__uprofile_play_keydetail_row">
      <span>{index === 7 ? 'SCRATCH' : index + 1}</span>
      {names.map((name, column) => {
        const value = column < 6 ? side?.lanes?.[index]?.[column] : side?.lane_fs?.[index]?.[column - 6];
        const shown = column >= 6 && side?.lane_fs == null ? '—' : valid(value) ? String(value) : '—';
        return <span key={name}>{name} <b>{shown}</b></span>;
      })}
      <span>RANK <b>{evaluation?.rank ?? '—'}</b></span><span>EX% <b>{evaluation?.rate ?? '—'}</b></span>
    </div>
    {side?.lanes_ok === false && <small>레인 검증 불일치</small>}
  </div>;
}

function renderPlayDetail(detail: PlayDetail | null | undefined, play: PlayCsvRow, level: number | null, accountKey?: string | null): JSX.Element {
  const head = <div className="__uprofile_play_head"><span className="__uprofile_play_head_level">{level ?? '—'}</span><span className="__uprofile_play_head_options">{playOptionDisplay(play)}</span></div>;
  const renderLanePattern = (side: 'P1' | 'P2') => {
    const order = displayLaneOrder(side === 'P1' ? play.lane_order_p1 : play.lane_order_p2, side, play);
    const activity = playSideActivity(play);
    const inactive = activity === 'P1' || activity === 'P2' ? activity !== side : false;
    const tiles = inactive ? Array.from({ length: 7 }, () => '') : order === '—' ? null : [...order];
    return <div key={side} className={`__uprofile_play_pattern_row${inactive ? ' __uprofile_play_pattern_inactive' : ''}`}><span className="__uprofile_play_pattern_tiles">{tiles === null ? '—' : tiles.map((digit, index) => <span key={index} className={`__uprofile_play_pattern_tile ${digit === '' ? (index % 2 === 0 ? '__uprofile_play_pattern_tile_white' : '__uprofile_play_pattern_tile_black') : Number(digit) % 2 === 1 ? '__uprofile_play_pattern_tile_white' : '__uprofile_play_pattern_tile_black'}`}><span className="__uprofile_play_pattern_digit">{digit}</span></span>)}</span><span className="__uprofile_play_pattern_label">PLAYER {side === 'P1' ? '1' : '2'} LANE</span></div>;
  };
  const renderLanePatternGroup = () => <div className="__uprofile_play_pattern_scale"><div className="__uprofile_play_pattern_scroll"><div className="__uprofile_play_pattern_groups">{(['P1', 'P2'] as const).map(renderLanePattern)}</div></div></div>;
  const summary = <div className="__uprofile_playdetail_summary">
    <span><span>램프</span> <b>{playLampLabel(play.clear_lamp)}</b></span>
    <span><span>EX 스코어</span> <b>{play.ex_score == null || play.ex_score === '' ? '—' : play.ex_score}</b></span>
    <span><span>Rate</span> <b>{play.dj_rate_pct == null || play.dj_rate_pct === '' ? '—' : `${play.dj_rate_pct}%`}</b></span>
    <span><span>DJ LEVEL</span> <b>{play.dj_rank == null || play.dj_rank === '' ? '—' : play.dj_rank}</b></span>
    <span><span>BP</span> <b>{playMissLabel(play.miss_count)}</b></span>
  </div>;
  if (!detail) return <div className="__uprofile_play_sections">{head}{summary}<section className="__uprofile_playdetail_judge __uprofile_play_inactive"><p>상세 기록 없음</p></section><div className="__uprofile_play_lane_layout"><section className="__uprofile_play_pattern"><h4>랜덤 레인 패턴</h4>{renderLanePatternGroup()}</section><section className="__uprofile_play_rating"><h4>레인별 평가</h4><div className="__uprofile_play_rating_scale"><div className="__uprofile_play_panel_scroll"><div className="__uprofile_play_panel">{(['P1', 'P2'] as const).map((side) => <div key={side}><h5>PLAYER{side === 'P1' ? '1' : '2'}</h5><PlayLaneController side={undefined} player={side} activity={playSideActivity(play)} /></div>)}</div></div></div></section></div></div>;
  const sides = ([['P1', detail.p1], ['P2', detail.p2]] as const).filter(([, side]) => !detailSideHidden(side));
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const aggregate = (index: number) => {
    const values = sides.flatMap(([, side]) => side.lanes?.map((lane) => lane?.[index]));
    return values.length === sides.length * 8 && values.every(valid) ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const fsValues = sides.map(([, side]) => side.fs);
  const hasFs = fsValues.every((fs) => fs != null && [fs.fast_great, fs.fast_good, fs.slow_great, fs.slow_good].every(valid));
  const sumFs = (key: 'fast_great' | 'fast_good' | 'slow_great' | 'slow_good') => hasFs ? fsValues.reduce((sum, fs) => sum + (fs?.[key] ?? 0), 0) : null;
  const values = [aggregate(0), aggregate(1), aggregate(2), aggregate(3), aggregate(4), aggregate(5)] as const;
  const scoreValues = values.slice(0, 5);
  const total = scoreValues.every(valid) ? scoreValues.reduce<number>((sum, value) => sum + (valid(value) ? value : 0), 0) : null;
  const evaluations = sides.map(([label, side]) => [label, laneEvaluation(side)] as const);
  const cbParts = (play.judge_16 || '').trim().split(/\s+/);
  const cb = sides.length > 0 && cbParts.length === 16 && [cbParts[10], cbParts[11]].every((value) => /^\d+$/.test(value))
    ? sides.reduce((sum, [label]) => sum + Number(cbParts[label === 'P1' ? 10 : 11]), 0) : null;
  const fmt = (value: unknown) => valid(value) ? String(value) : '—';
  const rows: { kind: string; tag?: string; name: string; value: number | null; pct?: boolean; bar?: boolean }[] = [];
  const add = (kind: string, name: string, value: number | null, tag?: string, pct = true, bar = true) => rows.push({ kind, tag, name, value, pct, bar });
  if (hasFs) {
    add('k-good', 'GOOD', sumFs('fast_good'), 'FAST'); add('k-great', 'GREAT', sumFs('fast_great'), 'FAST');
    add('k-pg', 'PERFECT GREAT', values[0]); add('k-great', 'GREAT', sumFs('slow_great'), 'SLOW'); add('k-good', 'GOOD', sumFs('slow_good'), 'SLOW');
  } else { add('k-great', 'GREAT', values[1]); add('k-pg', 'PERFECT GREAT', values[0]); add('k-good', 'GOOD', values[2]); }
  rows.push({ kind: 'sep', name: '', value: null });
  add('k-bad', 'BAD', values[3]); add('k-poor', 'POOR', values[4]); add('k-empty', '空POOR', values[5], undefined, false); add('k-cb', 'COMBO BREAK', cb, undefined, false, false);
  const percent = (value: number | null) => total != null && total > 0 && valid(value) ? `${Math.round(value / total * 100)}%` : '—';
  return <div className="__uprofile_play_sections">
    {head}
    {summary}
    <section className="__uprofile_playdetail_judge __uprofile_play_tiles"><div className="__uprofile_playdetail_summary">{!detail.complete && <span className="__uprofile_playdetail_badge">부분 기록</span>}{sides.some(([, side]) => side.fs_ok === false) && <span className="__uprofile_playdetail_badge">FAST/SLOW 검증 불일치</span>}</div><div className="__uprofile_playdetail_bars">{rows.map((row, index) => row.kind === 'sep' ? <span key="sep" className="__uprofile_playdetail_sep" /> : <div key={`${row.kind}-${index}`} className={`__uprofile_playdetail_barrow ${row.kind}`}><span className="__uprofile_playdetail_lab">{row.tag && <span className={`__uprofile_playdetail_tag ${row.tag === 'FAST' ? 't-fast' : 't-slow'}`}>{row.tag}</span>}{row.name}</span><span className="__uprofile_playdetail_n">{fmt(row.value)}</span><span className="__uprofile_playdetail_pct">{row.pct ? percent(row.value) : '—'}</span><span className="__uprofile_playdetail_track">{row.bar && total != null && total > 0 && valid(row.value) && <span className="__uprofile_playdetail_fill" style={{ width: `${Math.min(100, row.value / total * 100)}%` }} />}</span></div>)}</div>{!hasFs && <small className="__uprofile_playdetail_foot">FAST/SLOW 기록 없음 — 플레이 시작부터 관찰하지 못한 판</small>}</section>
    <div className="__uprofile_play_lane_layout"><section className="__uprofile_play_pattern"><h4>랜덤 레인 패턴</h4>{renderLanePatternGroup()}</section>
    <section className="__uprofile_play_rating"><h4>레인별 평가</h4><div className="__uprofile_play_rating_scale"><div className="__uprofile_play_panel_scroll"><div className="__uprofile_play_panel">{(['P1', 'P2'] as const).map((side) => { const sideDetail = detail[side === 'P1' ? 'p1' : 'p2']; return <div key={side}><h5>PLAYER{side === 'P1' ? '1' : '2'}</h5><PlayLaneController side={sideDetail} player={side} activity={playSideActivity(play)} accountKey={accountKey} /></div>; })}</div></div></div></section></div>
  </div>;
}

export function RecentPlays({ iidxId }: { iidxId: string | null }): JSX.Element {
  const [listState, setListState] = useState<RecentPlayListState>(() => ({ accountId: '', rows: [], signature: '', openKeys: new Set() }));
  const [playReadError, setPlayReadError] = useState<string | null>(null);
  const [textage, setTextage] = useState<Awaited<ReturnType<typeof ensureTextageMeta>>>(null);
  const normalizedId = useMemo(() => iidxId?.replace(/-/g, '').trim() || '', [iidxId]);

  const recentPlays = listState.accountId === normalizedId ? listState.rows : [];
  const renderedRows = recentPlayRows(recentPlays, normalizedId).reverse();

  useEffect(() => {
    setListState({ accountId: normalizedId, rows: [], signature: '', openKeys: new Set() });
    setPlayReadError(null);
    setTextage(null);
    if (!normalizedId) return;
    let active = true;
    void ensureTextageMeta().then((meta) => { if (active) setTextage(meta); });
    const unsubscribe = subscribeRecentPlays(normalizedId, (nextRows, nextError) => {
      const signature = JSON.stringify(nextRows);
      setListState((current) => {
        if (!active || current.accountId !== normalizedId) return current;
        if (current.signature === signature) return current;
        return { accountId: normalizedId, rows: nextRows, signature, openKeys: initialRecentOpenKeys(nextRows, normalizedId) };
      });
      setPlayReadError(nextError);
    });
    return () => { active = false; unsubscribe(); };
  }, [normalizedId]);

  return <section className="__uprofile_recentplays" aria-label="최근 플레이">
    <h3 className="__uprofile_recentplays_title">최근 플레이</h3>
    {playReadError ? (
      <p className="__uprofile_tabempty">플레이 기록을 읽지 못했습니다.</p>
    ) : recentPlays.length === 0 ? (
      <p className="__uprofile_tabempty">플레이 기록이 없습니다.</p>
    ) : (
      <div className="__uprofile_recentplays_list">
        {renderedRows.map(({ play, rowKey }) => isPlayErrorRow(play) ? (
          <div className="__uprofile_recentplays_row __uprofile_recentplays_error" key={rowKey}>
            기록 오류 (코드 {play.song_id})
          </div>
        ) : (
          <details className="__uprofile_recentplays_item" key={rowKey} open={listState.openKeys.has(rowKey)} onToggle={(event) => {
            const shouldOpen = event.currentTarget.open;
            setListState((current) => {
              if (current.accountId !== normalizedId || current.signature !== listState.signature) return current;
              const isOpen = current.openKeys.has(rowKey);
              if (isOpen === shouldOpen) return current;
              const openKeys = new Set(current.openKeys);
              if (shouldOpen) openKeys.add(rowKey); else openKeys.delete(rowKey);
              return { ...current, openKeys };
            });
          }}>
            <summary className="__uprofile_recentplays_row">
              <span>{recentPlayTime(play.timestamp)}</span>
              <span title={play.title}>{play.title || '—'}</span>
              <span>{play.difficulty || '—'}</span>
              <span>{play.ex_score === '' ? '—' : play.ex_score}</span>
              <span className="__uprofile_recentplays_chev">›</span>
            </summary>
            {renderPlayDetail(play.detail, play, playChartLevel(play, [], textage), normalizedId)}
          </details>
        ))}
      </div>
    )}
  </section>;
}

export default function Recent({ rows, iidxId, onPickChart }: Props): JSX.Element {
  // dates[0] = "오늘 (라이브)", dates[1..] = supabase 의 이전 업로드 날짜 (desc).
  // dateIdx === 0 → TSV vs latest, > 0 → fetchRecentCharts(pastDates[dateIdx-1].date_kst).
  const [supabaseDates, setSupabaseDates] = useState<{ date_kst: string; row_count: number }[]>([]);
  const [latestIdx, setLatestIdx] = useState<Map<string, LatestChartEntry> | null>(null);
  // latest(DB) fetch 완료 여부 — null 인 latestIdx 의 "로딩 중" vs "오프라인 실패" 구분용.
  // 로딩 중엔 전체 곡을 렌더하지 않고(렉 방지) 완료 후 필터링된 결과만 표시.
  const [latestLoaded, setLatestLoaded] = useState(false);
  const [dateIdx, setDateIdx] = useState(0);
  const [pastRows, setPastRows] = useState<RecentChartRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // DBR(배틀, played_version=-10) 토글 — ON 이면 DBR 만, OFF 면 DP(일반)만. (오소리웹 동일)
  //   DBR 모드는 로컬 TSV "오늘 라이브" 개념이 없어 supabase DBR 날짜(dbrDates)만 본다.
  const [dbrOnly, setDbrOnly] = useState(false);
  const [dbrDates, setDbrDates] = useState<{ date_kst: string; row_count: number }[] | null>(null); // lazy
  const [dbrMap, setDbrMap] = useState<Map<string, number> | null>(null); // DBR 난이도 (textageid|diff → dbrLevel)
  const dbrRequestGeneration = useMemo(() => ({ current: 0 }), []);

  // 시스템 시간 기준 KST 오늘 날짜 — 마운트 1회만 계산. 헤더 라벨 + supabaseDates 첫 entry 중복 제거에 사용.
  // 자정 넘기는 케이스는 다음 마운트 시 refresh (over-engineering 회피).
  const todayKst = useMemo(() => getTodayKst(), []);

  // iidxId 정규화 — IIDX ID 가 "C-1234-5678-9012" 같은 형식이면 하이픈 제거.
  const normalizedId = useMemo(() => {
    if (!iidxId) return '';
    return iidxId.replace(/-/g, '').trim();
  }, [iidxId]);

  // supabase 의 "이전 날짜" 목록 — 라이브 박스가 오늘 변동을 이미 표시하므로
  // 첫 entry 가 오늘 KST 와 같으면 중복 제거 (nav `<` 가 어제로 바로 이동).
  const pastDates = useMemo(() => {
    if (supabaseDates.length > 0 && supabaseDates[0].date_kst === todayKst) {
      return supabaseDates.slice(1);
    }
    return supabaseDates;
  }, [supabaseDates, todayKst]);

  // DBR 토글 — 모드 전환 + dateIdx 리셋. ON 전환 시 DBR 날짜/난이도 맵 lazy fetch.
  const toggleDbr = useCallback(() => {
    setDbrOnly((prev) => {
      const next = !prev;
      setDateIdx(0);
      setPastRows(null);
      if (next) {
        if (normalizedId && /^[A-Z0-9]+$/.test(normalizedId)) {
          const generation = ++dbrRequestGeneration.current;
          setDbrDates(null);
          setError(null);
          fetchRecentDates(normalizedId, true).then((dates) => {
            if (generation === dbrRequestGeneration.current) setDbrDates(dates);
          }).catch((e) => {
            if (generation === dbrRequestGeneration.current) setError((e as Error).message || 'DBR 날짜 조회 실패');
          });
        } else {
          setDbrDates([]);
        }
        if (dbrMap == null) loadDbrMap().then(setDbrMap).catch(() => setDbrMap(new Map()));
      }
      return next;
    });
  }, [normalizedId, dbrMap, dbrRequestGeneration]);

  useEffect(() => {
    dbrRequestGeneration.current++;
  }, [normalizedId]);

  // 마운트 / iidxId 변경 시: supabase 날짜 + latest (PREV source) 병렬 fetch.
  // 두 호출 다 실패해도 "오늘 (라이브)" 박스는 TSV-only 모드로 동작.
  useEffect(() => {
    if (!normalizedId || !/^[A-Z0-9]+$/.test(normalizedId)) {
      setSupabaseDates([]);
      setLatestIdx(null);
      setLatestLoaded(false);
      return;
    }
    let cancelled = false;
    setLatestLoaded(false);  // 새 fetch 시작 — 완료까지 전체 목록 렌더 보류 (로딩 표시)
    void (async () => {
      const [datesRes, latestRes] = await Promise.allSettled([
        fetchRecentDates(normalizedId),
        fetchUserLatestCharts(normalizedId),
      ]);
      if (cancelled) return;
      if (datesRes.status === 'fulfilled') setSupabaseDates(datesRes.value);
      else console.warn('[Recent] dates fetch 실패:', datesRes.reason);
      if (latestRes.status === 'fulfilled') setLatestIdx(latestRes.value);
      else console.warn('[Recent] latest fetch 실패:', latestRes.reason);
      // 성공/실패 무관하게 완료 표시 — 실패 시 latestIdx=null 로 TSV-only fallback.
      setLatestLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [normalizedId]);

  // supabase 날짜 charts fetch.
  //   DP 모드: dateIdx 0 = 오늘 라이브(TSV) → fetch X. dateIdx>0 = pastDates[dateIdx-1].
  //   DBR 모드: 라이브 없음 → 항상 dbrDates[dateIdx] fetch.
  //   fetch 후 played_version 으로 모드별 필터 (DP: !=-10, DBR: ==-10).
  useEffect(() => {
    if (!dbrOnly && dateIdx === 0) { setPastRows(null); setError(null); return; }
    const targetDate = dbrOnly ? dbrDates?.[dateIdx]?.date_kst : pastDates[dateIdx - 1]?.date_kst;
    if (!normalizedId || !targetDate) { setPastRows(null); return; }
    setLoading(true);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const charts = await fetchRecentCharts(normalizedId, targetDate, dbrOnly);
        const filtered = charts.filter((c) => (dbrOnly ? c.playedVersion === -10 : c.playedVersion !== -10));
        if (!cancelled) setPastRows(filtered);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'fetch 실패');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dateIdx, pastDates, dbrDates, dbrOnly, normalizedId]);

  // 현재 표시할 행들 — 오늘 모드면 TSV diff, 그 외엔 supabase 응답.
  //   오늘 모드: latest(DB) 로드 완료 전엔 [] 반환 — 전체 곡을 먼저 렌더했다가 필터하는 렉 방지.
  //   로드 완료 후 latestIdx 로 변동 곡만 계산 (실패 시 latestIdx=null → TSV-only fallback).
  const displayRows = useMemo(() => {
    // DBR 모드: supabase DBR 날짜만, dbrLevel desc 정렬.
    if (dbrOnly) {
      return pastRows ? sortDbrRows(pastRows, dbrMap) : [];
    }
    // DP 모드: dateIdx 0 = 오늘 라이브(TSV), 그 외 supabase.
    if (dateIdx === 0) {
      if (!latestLoaded) return [];
      return sortRows(computeTodayCharts(rows, latestIdx));
    }
    return pastRows ? sortRows(pastRows) : [];
  }, [dbrOnly, dateIdx, rows, latestIdx, latestLoaded, pastRows, dbrMap]);

  // 헤더 라벨 / nav — DP 모드: 오늘(라이브) + < 이전 supabase. DBR 모드: dbrDates 만 (라이브 없음).
  const isToday = !dbrOnly && dateIdx === 0;
  const dbrDateList = dbrDates || [];
  // 로딩 표시: DP 오늘 모드 latest 대기 / DBR 모드 날짜 목록 미로드.
  const todayLoading = isToday && !latestLoaded;
  const dbrLoading = dbrOnly && dbrDates == null;
  const busy = loading || todayLoading || dbrLoading;
  const hasPrev = dbrOnly
    ? dateIdx < dbrDateList.length - 1
    : (isToday ? pastDates.length > 0 : dateIdx < pastDates.length);
  const hasNext = dateIdx > 0;
  const headerLabel = dbrOnly
    ? (dbrDateList[dateIdx]?.date_kst || '') + ' (DBR)'
    : (isToday ? `${todayKst} (오늘, 라이브)` : (pastDates[dateIdx - 1]?.date_kst || '') + ' 업로드');

  if (!normalizedId || !/^[A-Z0-9]+$/.test(normalizedId)) {
    return (
      <div>
        <p className="__uprofile_tabempty">IIDX ID 가 감지되지 않았어요. INFINITAS 실행 후 다시 시도해주세요.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="__uprofile_rcheader">
        <div className="__uprofile_rcheader_nav">
          {hasPrev ? (
            <button
              type="button"
              className="__uprofile_rcnav"
              aria-label="이전 날짜"
              onClick={() => setDateIdx((i) => i + 1)}
            >
              &lt;
            </button>
          ) : <span style={{ width: 18 }} />}
          <span className="__uprofile_rcheader_label">{headerLabel}</span>
          {hasNext ? (
            <button
              type="button"
              className="__uprofile_rcnav"
              aria-label="다음 날짜"
              onClick={() => setDateIdx((i) => Math.max(0, i - 1))}
            >
              &gt;
            </button>
          ) : <span style={{ width: 18 }} />}
        </div>
        <span className="__uprofile_rcheader_right" style={{ gridColumn: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <span className="__uprofile_rcheader_count">
            {busy ? '불러오는 중...' : `${displayRows.length}곡`}
          </span>
          {/* DBR(배틀) 토글 — ON 분홍 / OFF 회색 (오소리웹 동일) */}
          <button
            type="button"
            className="__uprofile_rcdbrtoggle"
            onClick={toggleDbr}
            style={dbrOnly
              ? { fontSize: 11, fontWeight: 700, border: '1px solid #ff6b9d', borderRadius: 3, background: '#ff6b9d', color: '#fff', padding: '2px 8px', lineHeight: 1.2, cursor: 'pointer' }
              : { fontSize: 11, border: '1px solid #495057', borderRadius: 3, background: '#2b2f36', color: '#adb5bd', padding: '2px 8px', lineHeight: 1.2, cursor: 'pointer' }}
          >
            DBR
          </button>
        </span>
      </div>

      {error && (
        <p className="__uprofile_tabempty">데이터 조회 실패: {error}</p>
      )}

      {!error && displayRows.length === 0 && !busy && (
        <p className="__uprofile_tabempty">
          {dbrOnly
            ? 'DBR 기록이 없습니다'
            : (isToday
              ? (latestIdx ? '마지막 업로드 이후 변동된 곡 없음' : '플레이 데이터 없음')
              : '플레이 데이터 없음')}
        </p>
      )}

      {!error && displayRows.length > 0 && (
        <div className="__pd_tbody __pd_rctbody">
          {displayRows.map((c) => {
            const slotColor = DIFF_COLOR[c.diff] || '#868e96';
            const lampKey = c.lampAbbr || 'NP';
            const played = c.exScore > 0;
            const exDisplay = played ? c.exScore.toLocaleString() : '-';
            const prev = typeof c.prevExScore === 'number' ? c.prevExScore : 0;
            const prevDisplay = prev > 0 ? prev.toLocaleString() : '';
            // DBR 은 SP 2채보 합산이라 EX 만점 = noteCount*4 → djLevel/등급차를 effNote(=noteCount*2)로 재계산.
            //   (SP 단일 기준이면 ex 가 2배라 거의 AAA 오판) — 오소리웹 동일.
            const effNote = (dbrOnly && c.noteCount) ? c.noteCount * 2 : c.noteCount;
            const djNow = (dbrOnly && c.noteCount) ? (djLevelFromScore(c.exScore, effNote) || '') : (c.djLevel || '');
            const djPrev = (dbrOnly && typeof c.prevExScore === 'number' && effNote)
              ? (djLevelFromScore(c.prevExScore, effNote) || '')
              : (c.prevDjLevel || '');
            // DBR 모드는 prev 가 같은 played_version(-10)일 때만 비교 — DP 기록이 prev 로 섞이지 않게 엄격(null 불허).
            const sameVersion = dbrOnly
              ? c.prevPlayedVersion === c.playedVersion
              : (c.prevPlayedVersion == null || c.prevPlayedVersion === c.playedVersion);
            const showPrev = prevDisplay && prevDisplay !== exDisplay && sameVersion;
            const gradeDiff = played && effNote ? nextGradeDiff(djNow, c.exScore, effNote) : '';

            // 곡명 cell — LEG 면 † + slot 색
            const isLeg = c.diff === 'LEGGENDARIA';
            const titleStyle: React.CSSProperties = isLeg ? { color: slotColor } : {};
            const titleText = (isLeg ? '† ' : '') + c.title;

            // DBR 모드: 레벨 칸/곡명 앞 zasa 자리에 DBR 난이도 표시 (textageid|diff 매칭). 그 외 빈 문자열.
            const dbrLevel = (dbrOnly && dbrMap) ? dbrMap.get((c.textageSongId || '') + '|' + c.diff) : undefined;
            const zasaLabel = typeof dbrLevel === 'number' ? dbrLevel.toFixed(2) : '';
            const gameLevelLabel = c.gameLevel != null ? String(c.gameLevel) : '-';

            // LAMP 변동 — same 이면 단색 하나, diff 면 prev → now.
            const lampSame = c.prevLampAbbr === c.lampAbbr || c.prevLampAbbr == null;
            const lampPrevStr = lampAbbr(c.prevLamp);
            const lampNowStr = lampAbbr(c.lamp);
            // DBR 모드는 sameVersion 게이팅 — 시즌 다른 prev 면 현재값만. djLevel 은 effNote 재계산값 사용.
            const showLampPrev = !lampSame && (!dbrOnly || sameVersion);
            const djSame = djPrev === djNow;
            const showDjPrev = !djSame && (!dbrOnly || sameVersion);
            const djPrevStr = djPrev || '-';
            const djNowStr = djNow || '-';

            // 사용자 요청 — RECENT 행 클릭 시 DP 탭 점프 비활성화. role/tabIndex/onClick 제거.
            return (
              <div
                key={c.title + '|' + c.diff}
                className="__pd_tr __pd_recrow"
              >
                <div className={`__pd_cell __pd_lamp __pd_lamp-${lampKey}`} />
                <div className="__pd_cell __pd_level" style={{ color: slotColor }}>
                  <span className="__pd_level_game">{gameLevelLabel}</span>
                  <span className="__pd_level_zasa">{zasaLabel}</span>
                </div>
                <div className="__pd_cell __pd_title" style={titleStyle} title={c.title}>
                  <span className="__pd_zasa">{zasaLabel}</span>
                  {titleText}
                </div>
                <div className="__pd_cell __pd_rclampchange">
                  {!showLampPrev ? (
                    <span style={{ color: lampTextColor(c.lamp) }}>{lampNowStr}</span>
                  ) : (
                    <>
                      <span style={{ color: lampTextColor(c.prevLamp) }}>{lampPrevStr}</span>
                      →
                      <span style={{ color: lampTextColor(c.lamp) }}>{lampNowStr}</span>
                    </>
                  )}
                </div>
                <div className="__pd_cell __pd_rcdjchange">
                  {!showDjPrev ? (
                    <span style={{ color: djLetterColor(djNow) }}>{djNowStr}</span>
                  ) : (
                    <>
                      <span style={{ color: djLetterColor(djPrev) }}>{djPrevStr}</span>
                      →
                      <span style={{ color: djLetterColor(djNow) }}>{djNowStr}</span>
                    </>
                  )}
                </div>
                <div className="__pd_cell __pd_rcexchange">
                  {showPrev && <span className="__pd_recprev">{prevDisplay}→</span>}
                  <span className="__pd_excur">{exDisplay}</span>
                  {gradeDiff && <span className="__pd_grade">{gradeDiff}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
