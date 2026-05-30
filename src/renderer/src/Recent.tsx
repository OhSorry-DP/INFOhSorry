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
import { useEffect, useMemo, useState } from 'react';
import type { ChartSlot, SongRow } from '../../shared/types';
import { DP_SLOTS } from '../../shared/types';
import { norm } from '../../shared/match';
import {
  fetchRecentDates,
  fetchRecentCharts,
  fetchUserLatestCharts,
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
  const [dateIdx, setDateIdx] = useState(0);
  const [pastRows, setPastRows] = useState<RecentChartRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // 마운트 / iidxId 변경 시: supabase 날짜 + latest (PREV source) 병렬 fetch.
  // 두 호출 다 실패해도 "오늘 (라이브)" 박스는 TSV-only 모드로 동작.
  useEffect(() => {
    if (!normalizedId || !/^[A-Z0-9]+$/.test(normalizedId)) {
      setSupabaseDates([]);
      setLatestIdx(null);
      return;
    }
    let cancelled = false;
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
    })();
    return () => { cancelled = true; };
  }, [normalizedId]);

  // 이전 날짜 (dateIdx > 0) 선택 시: 해당 날짜의 charts fetch.
  // dateIdx === 0 (= 오늘 박스) 면 fetch X — TSV/latest 로 직접 계산.
  useEffect(() => {
    if (dateIdx === 0) { setPastRows(null); setError(null); return; }
    const targetDate = pastDates[dateIdx - 1]?.date_kst;
    if (!normalizedId || !targetDate) { setPastRows(null); return; }
    setLoading(true);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const charts = await fetchRecentCharts(normalizedId, targetDate);
        if (!cancelled) setPastRows(charts);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'fetch 실패');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dateIdx, pastDates, normalizedId]);

  // 현재 표시할 행들 — 오늘 모드면 TSV diff, 그 외엔 supabase 응답.
  const displayRows = useMemo(() => {
    if (dateIdx === 0) return sortRows(computeTodayCharts(rows, latestIdx));
    return pastRows ? sortRows(pastRows) : [];
  }, [dateIdx, rows, latestIdx, pastRows]);

  // 헤더 라벨 / nav 버튼 표시 — 오늘 모드는 "YYYY-MM-DD (오늘, 라이브)" + 이전 버튼만, 그 외는 < 날짜 >.
  // pastDates 가 없으면 nav 자체 비활성 (오프라인 / 신규 계정 / 오늘만 데이터 있음).
  const isToday = dateIdx === 0;
  const hasPrev = isToday
    ? pastDates.length > 0
    : dateIdx < pastDates.length;  // dateIdx 는 1 부터 시작 (오늘 = 0)
  const hasNext = dateIdx > 0;
  const headerLabel = isToday
    ? `${todayKst} (오늘, 라이브)`
    : (pastDates[dateIdx - 1]?.date_kst || '') + ' 업로드';

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
        <span className="__uprofile_rcheader_count">
          {loading ? '불러오는 중...' : `${displayRows.length}곡`}
        </span>
      </div>

      {error && (
        <p className="__uprofile_tabempty">데이터 조회 실패: {error}</p>
      )}

      {!error && displayRows.length === 0 && !loading && (
        <p className="__uprofile_tabempty">
          {isToday
            ? (latestIdx ? '마지막 업로드 이후 변동된 곡 없음' : '플레이 데이터 없음')
            : '플레이 데이터 없음'}
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
            // 시즌 다르면 prev 안 보이게 (오소리웹 동일 로직). INFOhSorry 는 항상 INF (= 0) 라 같음.
            const sameVersion = c.prevPlayedVersion == null || c.prevPlayedVersion === c.playedVersion;
            const showPrev = prevDisplay && prevDisplay !== exDisplay && sameVersion;
            const gradeDiff = played && c.noteCount ? nextGradeDiff(c.djLevel, c.exScore, c.noteCount) : '';

            // 곡명 cell — LEG 면 † + slot 색
            const isLeg = c.diff === 'LEGGENDARIA';
            const titleStyle: React.CSSProperties = isLeg ? { color: slotColor } : {};
            const titleText = (isLeg ? '† ' : '') + c.title;

            const zasaLabel = '';  // INFOhSorry Recent 는 zasa 표시 안 함 (오소리웹은 ratingData 보강 — INF 본인 화면엔 큰 의미 X)
            const gameLevelLabel = c.gameLevel != null ? String(c.gameLevel) : '-';

            // LAMP 변동 — same 이면 단색 하나, diff 면 prev → now.
            const lampSame = c.prevLampAbbr === c.lampAbbr || c.prevLampAbbr == null;
            const lampPrevStr = lampAbbr(c.prevLamp);
            const lampNowStr = lampAbbr(c.lamp);
            const djSame = (c.prevDjLevel || '') === (c.djLevel || '') || c.prevDjLevel == null;
            const djPrevStr = c.prevDjLevel || '-';
            const djNowStr = c.djLevel || '-';

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
                  {lampSame ? (
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
                  {djSame ? (
                    <span style={{ color: djLetterColor(c.djLevel) }}>{djNowStr}</span>
                  ) : (
                    <>
                      <span style={{ color: djLetterColor(c.prevDjLevel) }}>{djPrevStr}</span>
                      →
                      <span style={{ color: djLetterColor(c.djLevel) }}>{djNowStr}</span>
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
