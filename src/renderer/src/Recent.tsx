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
import type { ChartSlot, SongRow } from '../../shared/types';
import { DP_SLOTS } from '../../shared/types';
import { norm } from '../../shared/match';
import {
  fetchRecentDates,
  fetchRecentCharts,
  fetchUserLatestCharts,
  loadDbrMap,
  type RecentChartRow,
  type LatestChartEntry,
} from './supabaseSync';

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
          fetchRecentDates(normalizedId, true).then(setDbrDates).catch(() => setDbrDates([]));
        } else {
          setDbrDates([]);
        }
        if (dbrMap == null) loadDbrMap().then(setDbrMap).catch(() => setDbrMap(new Map()));
      }
      return next;
    });
  }, [normalizedId, dbrMap]);

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
        const charts = await fetchRecentCharts(normalizedId, targetDate);
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
