import { PLAY_CSV_KEYS, PLAY_CSV_LEGACY_KEYS, buildPlayErrorRow, isPlayErrorRow, type PlayCsvReadResult, type PlayCsvRow } from '../../shared/uploadSnapshot';
// Supabase 새 디비 (users + scores) upsert — Reflux 데이터 갱신 시마다 무조건 덮어쓰기.
// ohSorry / INFOhSorry 가 같은 DB 공유 (iidx_id text PK 라 namespace 호환).
//
// 차이점 (ohSorry 와):
//   - iidx_id 형식: ohSorry = 8자리 숫자 (xxxx-xxxx 의 하이픈 제거), INFOhSorry = "C293036891870" (C + 12자리)
//   - played_version: 0 (INF)
//   - song matching: songs.ac & 2 (INF) 인 곡만 매칭 (동명이곡 자동 분리)
//   - user_radars / 단위: v0.0.108 부터 INFINITAS 메모리에서 직접 읽어 SP·DP 둘 다 업로드
//     (그 전엔 INF 쪽에 레이더 데이터가 없어 ohSorryAdmin/getInfRadar.js 배치에만 의존했다)
//
// 마이그레이션:
//   - 옛 RPC: upsert_user_profile + upsert_user_chart_scores (user_profiles + user_chart_scores)
//   - 새 RPC: upsert_user + upsert_scores (users + scores)
//   - songs 마스터 캐시 (norm key → [{ song_id, title, ac }]) + ac flag pickSongId
//   - 같은 PK (song_id, iidx_id, diff, played_version) 중복 안전망 dedup (best ex_score / lamp)
//
// fire-and-forget — 실패해도 사용자 경험에 영향 X.
import type { ProfileInfo } from './useProfile';
import type { StarResult, SongChart } from '../../shared/types';
import type { RecInputChart } from '../../shared/recommend';
import { norm, slotToDiff } from '../../shared/match';
import { DATA_BASE } from '../../shared/dataSource';
import { getDbrRecentData, getDbrRecentDates, validateDbrHistory, type DbrHistory } from './dbr-history';

// BEGIN SCORE_HISTORY_UPLOAD_FILTER_SYNC
// Canonical source: D:/work/ohSorry-data/.github/scripts/score-history.mjs
// Pure score history merge helpers. Date parsing follows dbr-history.mjs day()/instant().

const SCORE_HISTORY_COLS = 10;
const scoreHistoryFail: (message: string) => never = (message) => { throw new TypeError(message); };
const DATE_PARSE_MEMO_LIMIT = 32768;
const dayMemo = new Map<string, string>();
const instantMemo = new Map<string, bigint>();

function scoreHistoryDay(value: unknown): string {
  if (typeof value === 'string' && dayMemo.has(value)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) scoreHistoryFail('invalid date_kst');
  if (dayMemo.size >= DATE_PARSE_MEMO_LIMIT) dayMemo.clear();
  dayMemo.set(value, value);
  return value;
}

function scoreHistoryInstant(value: unknown): bigint {
  const cached = typeof value === 'string' ? instantMemo.get(value) : undefined;
  if (cached !== undefined) return cached;
  const m = typeof value === 'string' && value.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/,
  );
  if (!m) scoreHistoryFail('date requires a timestamp with timezone (up to 6 fractional digits)');
  scoreHistoryDay(m[1]);
  if (+m[2] > 23 || +m[3] > 59 || +m[4] > 59) scoreHistoryFail('invalid timestamp time');
  const zone = m[6] === 'Z' ? 'Z' : m[6].length === 3 ? `${m[6]}:00`
    : m[6].includes(':') ? m[6] : `${m[6].slice(0, 3)}:${m[6].slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${zone}`);
  if (!Number.isFinite(ms)) scoreHistoryFail('invalid timestamp timezone');
  const result = BigInt(ms) * 1000n + BigInt((m[5] || '').padEnd(6, '0'));
  if (instantMemo.size >= DATE_PARSE_MEMO_LIMIT) instantMemo.clear();
  instantMemo.set(value, result);
  return result;
}

function scoreHistoryInteger(value: unknown, label: string, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    scoreHistoryFail(`${label} must be a finite integer${nullable ? ' or null' : ''}`);
  }
}

function normalizeScoreHistoryRow(row: unknown, kind: 'hist' | 'incoming', index: number): { row: unknown[]; time: bigint } {
  if (!Array.isArray(row) || (row.length !== 8 && row.length !== SCORE_HISTORY_COLS)) {
    scoreHistoryFail(`${kind} row at index ${index} must have 8 or 10 columns`);
  }
  const r: unknown[] = row.length === 8 ? [...row, null, null] : [...row];
  for (const i of [0, 1, 4, 7]) scoreHistoryInteger(r[i], `column ${i}`);
  if (r[4] === -10 && kind === 'incoming') scoreHistoryFail(`incoming row at index ${index} cannot be DBR (-10)`);
  if (r[7] !== 0 && r[7] !== 1) scoreHistoryFail(`column 7 at ${kind} row ${index} must be 0 or 1`);
  for (const i of [2, 3, 8, 9]) scoreHistoryInteger(r[i], `column ${i}`, true);
  const time = scoreHistoryInstant(r[5]);
  scoreHistoryDay(r[6]);
  const kst = new Date(Number(time / 1000n) + 9 * 3600000).toISOString().slice(0, 10);
  if (kst !== r[6]) scoreHistoryFail(`${kind} row at index ${index}: date_kst does not match date in KST`);
  return { row: r, time };
}

const scoreHistoryChartKey = (r: unknown[]) => JSON.stringify([r[0], r[1], r[4], r[7]]);
const scoreHistoryNaturalKey = (r: unknown[]) => JSON.stringify([r[0], r[1], r[4], r[7], r[6]]);
const scoreHistoryEx = (r: unknown[]) => (r[3] as number | null) ?? -1;
const scoreHistoryLamp = (r: unknown[]) => (r[2] as number | null) ?? 0;

/** Merge one SQL-request batch into score history without mutating input arrays. */
function mergeScoreHistory(histRows: unknown[][], incomingRows: unknown[][]): unknown[][] {
  if (!Array.isArray(histRows) || !Array.isArray(incomingRows)) scoreHistoryFail('histRows and incomingRows must be arrays');
  const hist = histRows.map((r, i) => normalizeScoreHistoryRow(r, 'hist', i));
  const incoming = incomingRows.map((r, i) => normalizeScoreHistoryRow(r, 'incoming', i));
  const keys = new Set<string>();
  for (let i = 0; i < hist.length; i += 1) {
    const r = hist[i].row;
    if (r[4] === -10) continue;
    const key = scoreHistoryNaturalKey(r);
    if (keys.has(key)) scoreHistoryFail(`duplicate natural key in hist at row ${i}: ${key}`);
    keys.add(key);
  }
  const incomingKeys = new Set<string>();
  for (let i = 0; i < incoming.length; i += 1) {
    const key = scoreHistoryChartKey(incoming[i].row);
    if (incomingKeys.has(key)) scoreHistoryFail(`duplicate incoming chart key at row ${i}: ${key}`);
    incomingKeys.add(key);
  }
  const result = hist.map(({ row }) => [...row]);
  for (const item of incoming) {
    const row = item.row;
    if (row[4] === -10) continue;
    const ck = scoreHistoryChartKey(row);
    const matches = result.map((r, i) => ({ r, i })).filter(({ r }) => r[4] !== -10 && scoreHistoryChartKey(r) === ck);
    if (!matches.some(({ r }) => scoreHistoryEx(r) > scoreHistoryEx(row) || (scoreHistoryEx(r) === scoreHistoryEx(row) && scoreHistoryLamp(r) >= scoreHistoryLamp(row)))) {
      const nk = scoreHistoryNaturalKey(row);
      const slot = result.findIndex((r) => r[4] !== -10 && scoreHistoryNaturalKey(r) === nk);
      if (slot < 0) result.push([...row]);
      else {
        const old = result[slot];
        const replacement = [...row];
        replacement[8] = row[8] ?? (row[3] !== null && row[3] === old[3] ? old[8] : null);
        replacement[9] = row[9] ?? old[9];
        result[slot] = replacement;
      }
    }
    for (const old of result) {
      if (old[4] === -10 || scoreHistoryChartKey(old) !== ck) continue;
      if (old[9] === null && row[9] !== null) old[9] = row[9];
      if (old[8] === null && row[8] !== null && row[3] !== null && old[3] === row[3]) old[8] = row[8];
    }
  }
  return result;
}

/** Return original incoming rows whose canonical merge changes history. */
function filterScoreHistoryRows(histRows: unknown[][], incomingRows: unknown[][]): unknown[][] {
  if (!Array.isArray(histRows) || !Array.isArray(incomingRows)) scoreHistoryFail('histRows and incomingRows must be arrays');
  const baseline = mergeScoreHistory(histRows, []);
  const normalizedIncoming = incomingRows.map((r, i) => normalizeScoreHistoryRow(r, 'incoming', i));
  mergeScoreHistory([], incomingRows);
  const byChart = new Map<string, unknown[][]>();
  for (const row of baseline) {
    if (row[4] === -10) continue;
    const key = scoreHistoryChartKey(row);
    const group = byChart.get(key) ?? [];
    group.push(row);
    byChart.set(key, group);
  }
  const changed: unknown[][] = [];
  for (let i = 0; i < normalizedIncoming.length; i += 1) {
    const item = normalizedIncoming[i];
    const group = byChart.get(scoreHistoryChartKey(item.row)) ?? [];
    if (JSON.stringify(mergeScoreHistory(group, [incomingRows[i]])) !== JSON.stringify(group)) changed.push(incomingRows[i]);
  }
  return changed;
}
// END SCORE_HISTORY_UPLOAD_FILTER_SYNC

export const SUPABASE_URL = 'https://cvxpeecxiawddmrzbdvn.supabase.co';
// Legacy JWT anon key (publishable key 는 RLS 호환성 문제로 사용 X) — ohSorry 와 동일
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2eHBlZWN4aWF3ZGRtcnpiZHZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5ODMxMzQsImV4cCI6MjA5NDU1OTEzNH0.lWnnSsSIFFLs7NsJq5yI6fe9HPiT9yQ3Pj-8sgfGuxI';
export const HEADERS = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};
const FAST_DUMP_ENQUEUE_INF = true;

// 새 디비 변환 매핑 (dbConn.js 와 동일)
export const DIFF_MAP: Record<string, number> = { BEGINNER: 0, NORMAL: 1, HYPER: 2, ANOTHER: 3, LEGGENDARIA: 4 };
export const LAMP_MAP: Record<string, number> = { NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7 };
const PLAYED_VERSION_INF = 0;

// supabase songs 마스터 1개 row — PlayData / Recent 의 곡 메타 lookup 에 사용.
// series_no / textage_song_id 는 PlayData 의 시리즈 폴더 그룹화 + textage-meta lookup 용.
export interface SongEntry {
  song_id: number;
  title: string;
  ac: number;                       // bit0=AC, bit1=INF (수록 시리즈 mask)
  legen: number;                    // 같은 mask 인데 LEG 채보 한정
  series_no?: number | null;        // 시리즈 번호 (99=NEW, 98=INFINITAS, ...)
  textage_song_id?: string | null;  // textage-meta lookup key
}

// textage-meta gist — title (raw) → textage_song_id 매핑 빌드. ensure_song 호출 시
//   p_textage_song_id 전달 → ON CONFLICT (textage_song_id) 분기로 옛 row 와 자동 통합.
//   supabase songs cache 가 stale 한 케이스 (옛 row 와 norm 매칭 실패) 에서 textage-meta 가 fresh 면
//   textage_song_id UNIQUE 키로 매칭 → series_no=99 새 row 생성 안 됨.
const TEXTAGE_META_URL =
  DATA_BASE + '/textage-meta.json';
let textageByTitle: Map<string, string> | null = null;
// title(raw)→textage_song_id 매핑(norm 키). score 업로드 + 원격 라이벌 비교 머지 키(remoteUser)에서 공유.
export async function getTextageByTitle(): Promise<Map<string, string>> {
  if (textageByTitle) return textageByTitle;
  textageByTitle = new Map<string, string>();
  try {
    const r = await fetch(TEXTAGE_META_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(`textage-meta HTTP ${r.status}`);
    const meta = (await r.json()) as { songs?: Record<string, { title?: string }> };
    if (meta && meta.songs) {
      for (const sid of Object.keys(meta.songs)) {
        const e = meta.songs[sid];
        if (!e || !e.title) continue;
        const k = norm(e.title);
        if (!k) continue;
        if (!textageByTitle.has(k)) textageByTitle.set(k, sid);
      }
    }
  } catch (e) {
    console.warn('[supabaseSync] textage-meta fetch 실패 (textage_song_id null 로 fallback):', (e as Error).message);
  }
  return textageByTitle;
}

// songs 마스터 캐시 (norm(title) → SongEntry[] + song_id → SongEntry) — 페이징 fetch + 메모리 보관.
//   byNorm: 곡명 매칭용 (Ø alias 포함). PlayData 의 TSV row 매칭에 사용.
//   byId:   song_id 기준 단일 entry. PlayData 의 곡 마스터 iteration (모든 곡 표시) 에 사용.
let songsCache: { byNorm: Map<string, SongEntry[]>; byId: Map<number, SongEntry> } | null = null;
async function getSongsCacheBundle(): Promise<{ byNorm: Map<string, SongEntry[]>; byId: Map<number, SongEntry> }> {
  if (songsCache) return songsCache;
  const byNorm = new Map<string, SongEntry[]>();
  const byId = new Map<number, SongEntry>();
  const pageSize = 1000;
  let offset = 0;
  let totalFetched = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/songs?select=song_id,title,ac,legen,series_no,textage_song_id&order=song_id.asc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`songs fetch HTTP ${res.status}`);
    const rows = (await res.json()) as SongEntry[];
    for (const r of rows) {
      if (!r.title) continue;
      const entry: SongEntry = {
        song_id: r.song_id, title: r.title, ac: r.ac, legen: r.legen,
        series_no: r.series_no ?? null,
        textage_song_id: r.textage_song_id ?? null,
      };
      byId.set(r.song_id, entry);
      const k = norm(r.title);
      if (!k) continue;
      if (!byNorm.has(k)) byNorm.set(k, []);
      byNorm.get(k)!.push(entry);
      // Ø/ø 곡은 eagate 표기가 일관되지 않음 — 'O' 알파벳 alias 도 등록
      if (/[Øø]/.test(r.title)) {
        const altTitle = r.title.replace(/[Øø]/g, 'O');
        const kAlt = norm(altTitle);
        if (kAlt && kAlt !== k) {
          if (!byNorm.has(kAlt)) byNorm.set(kAlt, []);
          byNorm.get(kAlt)!.push(entry);
        }
      }
    }
    totalFetched += rows.length;
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  songsCache = { byNorm, byId };
  console.log(`[supabaseSync] songs 매핑 캐시: ${byNorm.size} unique norm / ${byId.size} 곡 fetch (${totalFetched} rows)`);
  return songsCache;
}
export async function getSongsCache(): Promise<Map<string, SongEntry[]>> {
  return (await getSongsCacheBundle()).byNorm;
}
// PlayData 가 곡 마스터 전체를 시리즈별로 그룹화할 때 사용. song_id 기준 dedup.
export async function getSongsById(): Promise<Map<number, SongEntry>> {
  return (await getSongsCacheBundle()).byId;
}

// songs cache 의 ac / legen flag (bit1 = INF) 기반 — (title, chartName) → INF 수록 여부 sync checker.
// chartName = 'DP_LEG' 면 legen 컬럼 활용, 그 외는 ac. 차트 단위 정확 필터.
export async function getInfChartChecker(): Promise<(title: string, chartName?: string) => boolean> {
  const byNorm = await getSongsCache();
  return function isChartInInf(title: string, chartName?: string): boolean {
    if (!title) return false;
    const candidates = byNorm.get(norm(title));
    if (!candidates || candidates.length === 0) return false;
    const isLeg = chartName === 'DP_LEG' || chartName === 'SP_LEG';
    return candidates.some((c) => {
      const v = isLeg ? c.legen : c.ac;
      return typeof v === 'number' && (v & 2) !== 0;
    });
  };
}

// normKey 후보 array + played_version → song_id 단일 선택
//   played_version 0 = INF (ac & 2), > 0 = AC (ac & 1)
//   INFOhSorry 는 항상 INF — wantInf = true 고정
export function pickSongId(candidates: SongEntry[] | undefined, playedVersion: number): number | null {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].song_id;
  const wantInf = playedVersion === 0;
  const mask = wantInf ? 2 : 1;
  const filtered = candidates.filter((c) => (c.ac & mask) !== 0);
  if (filtered.length === 1) return filtered[0].song_id;
  if (filtered.length === 0) return candidates[0].song_id;
  return filtered[0].song_id;
}

// ensure_song RPC 호출 — 신곡 등록 / 기존곡 ac·legen 비트 OR. 성공 시 song_id, 실패 시 null (graceful).
//   INFOhSorry 는 항상 INF: 일반채보 있으면 p_ac=2, LEG 채보 있으면 p_legen=2.
async function callEnsureSong(
  title: string, txId: string | null, pAc: number | null, pLegen: number | null,
): Promise<number | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ensure_song`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ p_title: title, p_textage_song_id: txId, p_ac: pAc, p_legen: pLegen }),
    });
    if (!res.ok) throw new Error(`ensure_song HTTP ${res.status}`);
    const ensured = await res.json();
    const newId = typeof ensured === 'number' ? ensured : parseInt(ensured, 10);
    if (!Number.isFinite(newId) || newId <= 0) throw new Error('ensure_song returned non-numeric');
    return newId;
  } catch {
    return null;
  }
}

// user_radars 한 row 의 6 지표.
export interface DpRadarRow {
  notes: number | null;
  chord: number | null;
  peak: number | null;
  charge: number | null;
  scratch: number | null;
  soft: number | null;
}

// supabase 에서 한 유저의 공개 정보 — DP 노트레이더 + SP/DP 단위.
// INFOhSorry 메모리 리딩이 단위를 못 가져오는 케이스가 있어 supabase 저장값 (eagate djdata 기반) 으로 대체.
// 채워두는 주체: ohSorryAdmin/getInfRadar.js (INF 유저 대상 batch).
export interface UserPublicInfo {
  dpRadar: DpRadarRow | null;
  star: number | null;     // 저장된 별값 — 별값 단조 래칫의 하한으로 쓴다
  rStar: number | null;    // 저장된 r★ — userRateStar 단조 래칫의 하한으로 쓴다
  spRank: number | null;   // int 매핑 — setup_users.sql 의 매핑 (12=皆伝 / 11=中伝 / 10~1=十段~初段 / 0=一級 / -8~-1=九級~二級)
  dpRank: number | null;
}

const EMPTY_PUBLIC: UserPublicInfo = { dpRadar: null, star: null, rStar: null, spRank: null, dpRank: null };

// supabase user_radars (DP) + users (sp_rank/dp_rank) 를 병렬 fetch.
// 둘 중 한 쪽이 비어도 다른 쪽은 채워서 반환 (부분 데이터 OK). 네트워크 실패 / 데이터 없음 → 그 필드만 null.
export async function fetchUserPublic(iidxId: string): Promise<UserPublicInfo> {
  const id = iidxId.replace(/-/g, '').trim();
  if (!id) return EMPTY_PUBLIC;

  const radarUrl =
    `${SUPABASE_URL}/rest/v1/user_radars` +
    `?iidx_id=eq.${encodeURIComponent(id)}` +
    `&play_style=eq.1` +
    `&select=notes,chord,peak,charge,scratch,soft` +
    `&limit=1`;
  const userUrl =
    `${SUPABASE_URL}/rest/v1/users` +
    `?iidx_id=eq.${encodeURIComponent(id)}` +
    `&select=sp_rank,dp_rank,star,r_star` +
    `&limit=1`;

  const [radarResult, userResult] = await Promise.allSettled([
    fetch(radarUrl, { headers: HEADERS }).then(async (r) => r.ok ? (await r.json()) as DpRadarRow[] : []),
    fetch(userUrl,  { headers: HEADERS }).then(async (r) => r.ok ? (await r.json()) as Array<{ sp_rank: number | null; dp_rank: number | null; star: number | null; r_star: number | null }> : []),
  ]);

  let dpRadar: DpRadarRow | null = null;
  if (radarResult.status === 'fulfilled' && radarResult.value.length > 0) {
    const r = radarResult.value[0];
    const hasAny =
      typeof r.notes === 'number' || typeof r.chord === 'number' ||
      typeof r.peak === 'number'  || typeof r.charge === 'number' ||
      typeof r.scratch === 'number' || typeof r.soft === 'number';
    if (hasAny) dpRadar = r;
  }

  let spRank: number | null = null;
  let dpRank: number | null = null;
  let star: number | null = null;
  let rStar: number | null = null;
  if (userResult.status === 'fulfilled' && userResult.value.length > 0) {
    const u = userResult.value[0];
    spRank = typeof u.sp_rank === 'number' ? u.sp_rank : null;
    dpRank = typeof u.dp_rank === 'number' ? u.dp_rank : null;
    star = typeof u.star === 'number' ? u.star : null;
    rStar = typeof u.r_star === 'number' ? u.r_star : null;
  }

  return { dpRadar, star, rStar, spRank, dpRank };
}

export interface UploadInput {
  plays?: PlayCsvRow[] | null;
  gameRecognized?: () => Promise<boolean>;
  appVersion: string; // package.json version, e.g. '0.0.9'
  profile: ProfileInfo;
  starResult: StarResult | null; // null = ★ 미산출 (SP 전용·DP 저레벨 전용 유저) → users.star = null
  rStar?: number | null; // 사용자 r★. null = 미산출/표본부족 → RPC COALESCE 로 기존값 보존
  charts: RecInputChart[]; // dp12Match.charts (★11.6~12.7 ereter 매칭된 차트) + unclassified 도 합쳐 올림
  unclassifiedCharts?: Omit<RecInputChart, 'level'>[];
  // SP 차트 (전체) — gameLevel 10~12 만 추려 play_style:0 으로 함께 업로드.
  spCharts?: SongChart[];
  // DP 차트 (전체, 플레이한 것만) — 전 레벨 play_style:1 로 업로드. lv11/12 는 charts(dp12Match)와 겹치나 dedup 병합.
  //   charts(dp12Match)는 레이팅 매칭/ensure_song 경로라 유지하고, 이 필드가 저레벨 DP 까지 커버를 확장.
  dpAllCharts?: SongChart[];
  // TSV 전곡 (DP+SP 전 난이도/전 레벨, notInInf 제외) — songs 마스터 "곡 존재" 등록용.
  //   플레이 여부와 무관하게, 마스터에 없는 곡은 ensure_song 으로 등록 (미플레이 신곡도 목록에 노출).
  //   점수(scores) 업로드는 여기에 영향받지 않음 — 아래 scores 루프는 그대로 exScore>0 만 적재.
  allTsvCharts?: SongChart[];
  // 선택: ereter 매핑 있으면 함께 (대개 INF ID 는 ereter 에 없어 null)
  ereterStar?: number | null;
  // SP 대표 실력값 — sp_cpi(CPI 실력선 정수) / sp_star(発狂★相当). null(표본부족/미산출)이면 RPC COALESCE 가 기존 DB값 유지.
  spCpi?: number | null;
  spStar?: number | null;
}

interface ScoreRow {
  song_id: number;
  iidx_id: string;
  diff: number;
  lamp: number | null;
  ex_score: number | null;
  played_version: number;
  play_style: number;   // 0=SP, 1=DP
  date: string;
  // 14_scores_bp_notecount.sql 로 추가된 컬럼. 값 없으면 null → RPC 가 NULL 로 저장(미상).
  bp: number | null;          // Bad+Poor 미스카운트 (TSV missCount)
  note_count: number | null;  // 채보 총 노트수 (TSV noteCount)
}

// TSV 숫자 필드 → DB 값. 음수/비유한수는 "미상"(null) 으로 — Reflux 가 모르는 값을 -1 로 주는 경우가 있고,
//   0 은 BP 0(=FC) / noteCount 0(=미상) 로 의미가 갈려서 필드별로 최소값을 다르게 본다.
function bpOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}
function noteCountOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

// user_radars 업로드 — SP(play_style 0) / DP(1) 각각 RPC upsert_user_radar 1회.
//   INFINITAS 메모리에서 읽은 값만 올린다 (supabase 에서 받아온 값은 되쓰기하지 않음 — 왕복 오염 방지).
//   값이 없는 스타일은 skip. 실패는 warn 만 남기고 삼킨다 (fire-and-forget).
//
//   DB 함수는 ohSorryAdmin 이 쓰던 기존 upsert_user_radar 를 그대로 쓴다
//   (p_iidx_id, p_play_style, p_notes, p_peak, p_charge, p_chord, p_scratch, p_soft).
//   PostgREST 는 파라미터를 **이름**으로 넘기므로 선언 순서와 무관하다. 같은 이름으로 함수를 하나 더
//   만들면 오버로드가 되어 PGRST203("could not choose the best candidate")로 전부 실패한다 — 만들지 말 것.
async function uploadRadars(iidxIdNorm: string, profile: ProfileInfo): Promise<void> {
  const targets: Array<{ style: number; label: string; r: DpRadarRow | null }> = [
    { style: 0, label: 'SP', r: profile.spRadar },
    { style: 1, label: 'DP', r: profile.dpRadar },
  ];
  for (const t of targets) {
    if (!t.r) continue;
    const num = (v: number | null | undefined): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Number(v.toFixed(2)) : null;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_user_radar`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          p_iidx_id: iidxIdNorm,
          p_play_style: t.style,
          p_notes: num(t.r.notes),
          p_chord: num(t.r.chord),
          p_peak: num(t.r.peak),
          p_charge: num(t.r.charge),
          p_scratch: num(t.r.scratch),
          p_soft: num(t.r.soft),
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn(`[supabase] user_radars ${t.label} upsert 실패 HTTP ${res.status} ${errText}`);
        continue;
      }
      console.log(`[supabase] user_radars ${t.label} upsert OK ${iidxIdNorm}`);
    } catch (e) {
      console.warn(`[supabase] user_radars ${t.label} upsert error:`, (e as Error).message);
    }
  }
}

export async function uploadProfile(input: UploadInput): Promise<{ ok: boolean; error?: string }> {
  const { appVersion, profile, starResult, rStar, charts, unclassifiedCharts, ereterStar, spCpi, spStar } = input;

  // 원격 service status — uploadEnabled === false 면 upload skip
  const status = await window.infohsorry.serviceStatus.get();
  if (!status.uploadEnabled) {
    return { ok: false, error: status.message || 'upload disabled by remote service status' };
  }

  // iidx_id 정규화 — 하이픈 제거 (INF 는 원래 없는 형식이지만 안전망)
  const rawId = profile.iidxId;
  if (!rawId) return { ok: false, error: 'iidx_id 없음' };
  const iidxIdNorm = rawId.replace(/-/g, '');
  const uploadHistCache = new Map<string, Promise<UploadHistResult>>();
  const getUploadHist = (id: string): Promise<UploadHistResult> => {
    const cached = uploadHistCache.get(id);
    if (cached) return cached;
    const pending = fetchUploadHist(id);
    uploadHistCache.set(id, pending);
    return pending;
  };

  // 1. users upsert (RPC upsert_user) — INF 는 sp_rank/dp_rank 없음, ereter_star 만 옵션
  //   SP 대표 실력값: 표본부족/미산출이면 null → RPC COALESCE 가 기존 sp_cpi/sp_star 보존(절대 덮어 0 안 함).
  const spCpiVal = (typeof spCpi === 'number' && isFinite(spCpi)) ? Math.round(spCpi) : null;
  const spStarVal = (typeof spStar === 'number' && isFinite(spStar)) ? Number(spStar.toFixed(1)) : null;
  // SP/DP 단위 — 게임 메모리에서 읽은 값 (supabase 스케일 int). 못 읽었거나 미취득이면 null →
  //   RPC COALESCE 가 기존 DB값 유지 (eagate 배치가 넣어둔 값을 지우지 않음).
  const spRankVal = typeof profile.spRankInt === 'number' ? profile.spRankInt : null;
  const dpRankVal = typeof profile.dpRankInt === 'number' ? profile.dpRankInt : null;
  try {
    console.log(`[supabase] users upsert 시도 ${iidxIdNorm} — DP★=${starResult ? starResult.star.toFixed(2) : 'null'} r★=${typeof rStar === 'number' ? rStar.toFixed(2) : 'null(보존)'} / SP sp_cpi=${spCpiVal ?? 'null(보존)'} sp_star=${spStarVal ?? 'null(보존)'} / 단위 SP=${spRankVal ?? 'null(보존)'} DP=${dpRankVal ?? 'null(보존)'}`);
    const plays = playsForGame(input.plays, input.gameRecognized ? await input.gameRecognized() : true);
    const userRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_user`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        ...(plays !== undefined ? { p_plays: plays } : {}),
        p_iidx_id: iidxIdNorm,
        p_dj_name: profile.djName ?? null,
        p_star: null,
        p_ereter_star: ereterStar != null ? Number(ereterStar) : null,
        // SP/DP 단위 — v0.0.108 부터 게임 메모리에서 직접 읽어 업로드 (프로필 struct 의 정수 index).
        //   못 읽음/미취득이면 null → RPC COALESCE 가 기존 값 유지 (eagate 배치값을 null 로 덮지 않음).
        p_sp_rank: spRankVal,
        p_dp_rank: dpRankVal,
      }),
    });
    if (!userRes.ok) {
      const errText = await userRes.text().catch(() => '');
      return { ok: false, error: `users HTTP ${userRes.status} ${errText}` };
    }
    console.log(`[supabase] users upsert OK ${iidxIdNorm} — SP sp_cpi=${spCpiVal ?? 'null(보존)'} sp_star=${spStarVal ?? 'null(보존)'}`);
  } catch (e) {
    return { ok: false, error: `users error: ${(e as Error).message}` };
  }

  // 1-B. user_radars upsert — 메모리에서 읽은 SP(0) / DP(1) 노트레이더.
  //   실패해도 scores 업로드는 계속한다 (레이더는 부가 정보 — 점수 유실이 더 치명적).
  await uploadRadars(iidxIdNorm, profile);

  // 2. scores upsert — chart row 변환 + songs 매칭 + ac flag dedup
  const allChartsForScores = [...charts, ...(unclassifiedCharts ?? [])];
  const isDpSlot = (slot: unknown): boolean => (
    slot === 'DPN' || slot === 'DPH' || slot === 'DPA' || slot === 'DPL'
  );
  const scoreDate = new Date().toISOString();

  let songMap: Map<string, SongEntry[]>;
  try {
    songMap = await getSongsCache();
  } catch (e) {
    return { ok: false, error: `songs cache fetch: ${(e as Error).message}` };
  }

  // ── 곡 등록 패스 — TSV 전곡(플레이 무관)을 songs 마스터에 등록 + INF 비트 보정. 점수 루프와 독립. ──
  //   목적 1: 미플레이 신곡도 songs 마스터에 "존재"를 남겨 다른 유저/목록에 노출.
  //   목적 2: 기존 AC 곡이 INF 에 새로 들어온 경우, 플레이 전이라도 INF 비트(ac&2 / legen&2)를 켬.
  //   판정 기준 = "있나?" 가 아니라 "필요한 INF 비트가 켜져 있나?". 다 켜져 있으면 skip → 평상시 네트워크 0건,
  //     신곡/INF 신규수록 곡이 들어온 직후 주기에만 ensure_song 발생.
  //   비트 OR 은 ensure_song 이 textage_song_id 기준 ON CONFLICT (또는 NULL-textage 행 title 매칭) 으로 처리 →
  //     기존 행을 갱신하지 신규 행을 만들지 않음(중복 안전). songMap 도 갱신해 scores 루프 중복 RPC 방지.
  const LEG_SLOTS = new Set(['SPL', 'DPL']);
  if (input.allTsvCharts && input.allTsvCharts.length > 0) {
    // norm(title) → { title(raw), hasNonLeg, hasLeg } 집계
    const songAgg = new Map<string, { title: string; hasNonLeg: boolean; hasLeg: boolean }>();
    for (const c of input.allTsvCharts) {
      if (!c.title) continue;
      const k = norm(c.title);
      if (!k) continue;
      let agg = songAgg.get(k);
      if (!agg) { agg = { title: c.title, hasNonLeg: false, hasLeg: false }; songAgg.set(k, agg); }
      if (LEG_SLOTS.has(c.slot)) agg.hasLeg = true;
      else agg.hasNonLeg = true;
    }
    const txMap = await getTextageByTitle();
    let regNew = 0;       // 신규 곡 등록
    let regBitFix = 0;    // 기존 곡 INF 비트 보정
    const regSamples: string[] = [];
    for (const [k, agg] of songAgg) {
      const candidates = songMap.get(k);
      const pAc = agg.hasNonLeg ? 2 : null;
      const pLegen = agg.hasLeg ? 2 : null;
      // 필요한 INF 비트가 이미 어느 후보에든 켜져 있으면 skip. (동명이곡: INF 행이 이미 ac&2 → AC 행 안 건드림)
      const acCovered = pAc == null || (candidates?.some((c) => ((c.ac ?? 0) & 2) !== 0) ?? false);
      const legenCovered = pLegen == null || (candidates?.some((c) => ((c.legen ?? 0) & 2) !== 0) ?? false);
      const exists = !!candidates && candidates.length > 0;
      if (exists && acCovered && legenCovered) continue;

      const newId = await callEnsureSong(agg.title, txMap.get(k) || null, pAc, pLegen);
      if (newId == null) continue; // 실패 graceful skip (다음 주기 재시도)

      // songMap 갱신 — 반환 song_id 가 기존 후보면 비트 OR, 아니면(신규/중복) 새 entry 추가.
      const hit = candidates?.find((c) => c.song_id === newId);
      if (hit) {
        if (pAc != null) hit.ac = (hit.ac ?? 0) | 2;
        if (pLegen != null) hit.legen = (hit.legen ?? 0) | 2;
        regBitFix++;
      } else {
        if (!songMap.has(k)) songMap.set(k, []);
        songMap.get(k)!.push({ song_id: newId, title: agg.title, ac: pAc ?? 0, legen: pLegen ?? 0 });
        regNew++;
      }
      if (regSamples.length < 10) regSamples.push(agg.title);
    }
    if (regNew > 0 || regBitFix > 0) {
      console.log(`[supabaseSync] songs 마스터 곡 등록 (TSV 전곡) — 신규 ${regNew}건 / INF비트 보정 ${regBitFix}건:`, regSamples);
    }
  }

  // dedup map — key: `${song_id}|${iidx_id}|${diff}|${played_version}` → row
  const dedup = new Map<string, ScoreRow>();
  const ensuredSongBits = new Set<string>();
  let unmatched = 0;
  let invalidDiff = 0;
  const unmatchedSamples: string[] = [];
  let autoEnsured = 0;
  const autoEnsuredSamples: string[] = [];
  for (const c of allChartsForScores) {
    if (!isDpSlot(c.slot)) continue;
    if ((c.exScore ?? 0) <= 0) continue; // 미플레이 skip
    const diffInt = DIFF_MAP[c.diff];
    if (diffInt == null) { invalidDiff++; continue; }
    const candidates = songMap.get(norm(c.title));
    let songId = pickSongId(candidates, PLAYED_VERSION_INF);
    if (songId == null) {
      // songs 마스터 미등록 신곡 — ensure_song RPC 로 자동 등록. 실패 시 graceful skip.
      // INFOhSorry 는 항상 INF (PLAYED_VERSION_INF=0) → ac/legen 의 INF 비트(2) set.
      //
      // textage-meta lookup 으로 textage_song_id 찾기 — supabase songs cache 가 stale 한 경우에도
      //   textage-meta 매칭되면 textage_song_id UNIQUE 키로 옛 row 와 자동 통합 (series_no=99 새 row 생성 X).
      const isLeg = c.diff === 'LEGGENDARIA';
      const txMap = await getTextageByTitle();
      const txId = txMap.get(norm(c.title)) || null;
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ensure_song`, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({
            p_title: c.title,
            p_textage_song_id: txId,
            p_ac:    isLeg ? null : 2,
            p_legen: isLeg ? 2 : null,
          }),
        });
        if (!res.ok) throw new Error(`ensure_song HTTP ${res.status}`);
        const ensured = await res.json();
        const newId = typeof ensured === 'number' ? ensured : parseInt(ensured, 10);
        if (!Number.isFinite(newId) || newId <= 0) throw new Error('ensure_song returned non-numeric');
        songId = newId;
        const k = norm(c.title);
        if (!songMap.has(k)) songMap.set(k, []);
        songMap.get(k)!.push({
          song_id: songId, title: c.title,
          ac:    isLeg ? 0 : 2,
          legen: isLeg ? 2 : 0,
        });
        autoEnsured++;
        if (autoEnsuredSamples.length < 10) autoEnsuredSamples.push(c.title);
      } catch (e) {
        unmatched++;
        if (unmatchedSamples.length < 10) unmatchedSamples.push(c.title + ' (' + (e as Error).message + ')');
        continue;
      }
    }
    // TSV 전곡 패스 밖에 있는 입력도 점수 필터링 전에 INF 비트를 보충한다.
    const isLegForBits = c.diff === 'LEGGENDARIA';
    const songCandidates = songMap.get(norm(c.title));
    const songEntry = songCandidates?.find((entry) => entry.song_id === songId);
    const requiredBitMissing = !songEntry || (isLegForBits
      ? ((songEntry.legen ?? 0) & 2) === 0
      : ((songEntry.ac ?? 0) & 2) === 0);
    const ensuredSongBitsKey = `${songId}|${isLegForBits ? 'legen' : 'ac'}`;
    if (requiredBitMissing && !ensuredSongBits.has(ensuredSongBitsKey)) {
      const txMap = await getTextageByTitle();
      const newId = await callEnsureSong(c.title, txMap.get(norm(c.title)) || null,
        isLegForBits ? null : 2, isLegForBits ? 2 : null);
      if (newId === songId) {
        if (songEntry) {
          if (isLegForBits) songEntry.legen = (songEntry.legen ?? 0) | 2;
          else songEntry.ac = (songEntry.ac ?? 0) | 2;
        }
        ensuredSongBits.add(ensuredSongBitsKey);
      } else {
        console.warn(`[supabaseSync] ensure_song INF bit 보충 실패 또는 ID 불일치: ${c.title} (expected ${songId}, got ${newId ?? 'null'})`);
      }
    }
    const lampInt = c.lamp != null && LAMP_MAP[c.lamp] != null ? LAMP_MAP[c.lamp] : null;
    const exScore = c.exScore != null ? Number(c.exScore) : null;
    const newRow: ScoreRow = {
      song_id: songId,
      iidx_id: iidxIdNorm,
      diff: diffInt,
      lamp: lampInt,
      ex_score: exScore,
      played_version: PLAYED_VERSION_INF,
      play_style: 1,   // DP
      date: scoreDate,
      bp: bpOrNull(c.missCount),
      note_count: noteCountOrNull(c.noteCount),
    };
    const pk = `${songId}|${iidxIdNorm}|${diffInt}|${PLAYED_VERSION_INF}|1`;
    const prev = dedup.get(pk);
    if (!prev) {
      dedup.set(pk, newRow);
    } else {
      const prevEx = prev.ex_score || 0;
      const newEx = exScore || 0;
      if (newEx > prevEx || (newEx === prevEx && (lampInt || 0) > (prev.lamp || 0))) {
        dedup.set(pk, newRow);
      }
    }
  }
  // SP 차트 — gameLevel 1~12(BEGINNER 제외, 2026-09-28 사용자 결정 — 종전 10~12) play_style:0 으로 (song_id 는 곡 단위라 DP 와 공유. songs 미등록 신곡은 skip).
  let spUnmatched = 0;
  let spCount = 0;
  for (const c of (input.spCharts ?? [])) {
    if (c.level < 1 || c.level > 12) continue;
    if ((c.exScore ?? 0) <= 0) continue;  // 미플레이 skip
    const spDiff = slotToDiff(c.slot);
    if (spDiff === 'BEGINNER') continue;  // DP 처럼 BEGINNER 는 올리지 않는다
    const diffInt = DIFF_MAP[spDiff];
    if (diffInt == null) continue;
    const songId = pickSongId(songMap.get(norm(c.title)), PLAYED_VERSION_INF);
    if (songId == null) { spUnmatched++; continue; }
    const lampInt = c.lamp != null && LAMP_MAP[c.lamp] != null ? LAMP_MAP[c.lamp] : null;
    const exScore = c.exScore != null ? Number(c.exScore) : null;
    const newRow: ScoreRow = {
      song_id: songId, iidx_id: iidxIdNorm, diff: diffInt, lamp: lampInt,
      ex_score: exScore, played_version: PLAYED_VERSION_INF, play_style: 0, date: scoreDate,
      bp: bpOrNull(c.missCount), note_count: noteCountOrNull(c.noteCount),
    };
    const pk = `${songId}|${iidxIdNorm}|${diffInt}|${PLAYED_VERSION_INF}|0`;
    const prev = dedup.get(pk);
    if (!prev) { dedup.set(pk, newRow); spCount++; }
    else {
      const prevEx = prev.ex_score || 0; const newEx = exScore || 0;
      if (newEx > prevEx || (newEx === prevEx && (lampInt || 0) > (prev.lamp || 0))) dedup.set(pk, newRow);
    }
  }
  if (spUnmatched > 0) console.warn(`[supabaseSync] SP song 매칭 실패 ${spUnmatched}건 (skip, songs 미등록)`);
  if (spCount > 0) console.log(`[supabaseSync] SP1~12 scores: ${spCount}건 (play_style:0)`);

  // DP 전 레벨 — play_style:1 로 적재 (위 charts(dp12Match)는 lv11/12 만 → 저레벨 DP 보강).
  //   songs 미등록 신곡은 skip — allTsvCharts 등록 패스가 모든 DP 곡을 이미 ensure_song 했으므로 정상 매칭됨.
  //   lv11/12 는 위 루프와 겹치지만 같은 PK(play_style:1) dedup 으로 best ex/lamp 만 남음.
  let dpAllUnmatched = 0;
  let dpAllCount = 0;
  for (const c of (input.dpAllCharts ?? [])) {
    if ((c.exScore ?? 0) <= 0) continue;  // 미플레이 skip
    const diffInt = DIFF_MAP[slotToDiff(c.slot)];
    if (diffInt == null) continue;
    const songId = pickSongId(songMap.get(norm(c.title)), PLAYED_VERSION_INF);
    if (songId == null) { dpAllUnmatched++; continue; }
    const lampInt = c.lamp != null && LAMP_MAP[c.lamp] != null ? LAMP_MAP[c.lamp] : null;
    const exScore = c.exScore != null ? Number(c.exScore) : null;
    const newRow: ScoreRow = {
      song_id: songId, iidx_id: iidxIdNorm, diff: diffInt, lamp: lampInt,
      ex_score: exScore, played_version: PLAYED_VERSION_INF, play_style: 1, date: scoreDate,
      bp: bpOrNull(c.missCount), note_count: noteCountOrNull(c.noteCount),
    };
    const pk = `${songId}|${iidxIdNorm}|${diffInt}|${PLAYED_VERSION_INF}|1`;
    const prev = dedup.get(pk);
    if (!prev) { dedup.set(pk, newRow); dpAllCount++; }
    else {
      const prevEx = prev.ex_score || 0; const newEx = exScore || 0;
      if (newEx > prevEx || (newEx === prevEx && (lampInt || 0) > (prev.lamp || 0))) dedup.set(pk, newRow);
    }
  }
  if (dpAllUnmatched > 0) console.warn(`[supabaseSync] DP(전레벨) song 매칭 실패 ${dpAllUnmatched}건 (skip, songs 미등록)`);
  if (dpAllCount > 0) console.log(`[supabaseSync] DP 전레벨 scores: +${dpAllCount}건 신규 (play_style:1, lv11/12 제외 보강분)`);

  const originalScoreCount = allChartsForScores.length;
  const dedupScoreRows = [...dedup.values()];
  let scoreRows = [...dedupScoreRows];
  if (scoreRows.length > 0) {
    const histResult = await getUploadHist(iidxIdNorm);
    if (histResult.status === 'ok' && histResult.hist.length > 0) {
      try {
        const histRows = histResult.hist.map((row) => [row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8] ?? null, row[9] ?? null]);
        const incomingRows = scoreRows.map((row) => [row.song_id, row.diff, row.lamp, row.ex_score, row.played_version,
          row.date, new Date(new Date(row.date).getTime() + 9 * 3600000).toISOString().slice(0, 10), row.play_style, row.bp, row.note_count]);
        const filtered = filterScoreHistoryRows(histRows, incomingRows);
        const included = new Set(filtered);
        scoreRows = scoreRows.filter((_row, index) => included.has(incomingRows[index]));
      } catch (e) {
        console.warn(`[supabaseSync] 업로드 hist 비교 실패; 사용자 전체 전송: ${(e as Error).message}`);
      }
    } else if (histResult.status === 'error') {
      console.warn(`[supabaseSync] 업로드 hist 조회 실패; 사용자 전체 전송: ${histResult.error}`);
    }
  }
  if (autoEnsured > 0) console.log(`[supabaseSync] songs 마스터 자동 등록 (ensure_song) ${autoEnsured}건:`, autoEnsuredSamples);
  if (unmatched > 0) console.warn(`[supabaseSync] song 매칭 실패 ${unmatched}건 (skip). 샘플:`, unmatchedSamples);
  if (invalidDiff > 0) console.warn(`[supabaseSync] diff 변환 실패 ${invalidDiff}건 (skip)`);
  console.log(`[supabaseSync] appVersion=${appVersion} scores: 원본 ${originalScoreCount}건 / dedup ${dedupScoreRows.length}건 / 제외 ${dedupScoreRows.length - scoreRows.length}건 / 전송 ${scoreRows.length}건`);

  if (scoreRows.length === 0) {
    return { ok: true };
  }

  const SCORE_UPSERT_CHUNK_SIZE = 1000;
  const total = Math.ceil(scoreRows.length / SCORE_UPSERT_CHUNK_SIZE);
  let successfulScoreCount = 0;
  // 버퍼 계약에서 재전송 안전성을 소비자 측 best skip에 의존하지 않는다.
  for (let i = 0; i < total; i++) {
    const chunk = scoreRows.slice(i * SCORE_UPSERT_CHUNK_SIZE, (i + 1) * SCORE_UPSERT_CHUNK_SIZE);
    console.log(`[supabaseSync] scores 청크 ${i + 1}/${total} (${chunk.length}행)`);
    try {
      const chartRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_scores`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ p_rows: chunk }),
      });
      if (!chartRes.ok) {
        const errText = await chartRes.text().catch(() => '');
        return { ok: false, error: `scores chunk ${i + 1}/${total} HTTP ${chartRes.status} ${errText}` };
      }
      successfulScoreCount += chunk.length;
    } catch (e) {
      return { ok: false, error: `scores chunk ${i + 1}/${total} error: ${(e as Error).message}` };
    }
  }
  if (FAST_DUMP_ENQUEUE_INF && successfulScoreCount > 0) {
    try {
      const bearer = await existingRemoteBearer(iidxIdNorm);
      if (!bearer) {
        console.warn('[supabaseSync] INF dump 완료 중계 생략: remote Bearer 없음');
      } else {
        const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID() : null;
        if (!requestId) {
          console.warn('[supabaseSync] INF dump 완료 중계 생략: UUID 생성 불가');
        } else {
          const body = JSON.stringify({ source: 'inf', iidx_id: iidxIdNorm, request_id: requestId });
          let result: Response | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
              result = await fetch('https://iidx.in/api/dump-trigger?upload_complete=1', {
                method: 'POST', credentials: 'omit', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` }, body,
              });
              clearTimeout(timeout);
              if (!result.ok) {
                console.warn(`[supabaseSync] INF dump 완료 중계 HTTP ${result.status}`);
                if (result.status >= 500 && attempt === 0) continue;
                break;
              }
              try {
                const response = await result.json();
                if (typeof response?.accepted !== 'boolean') throw new Error('invalid accepted response');
                if (response.accepted === false) console.warn('[supabaseSync] INF dump 완료 중계 accepted:false');
              } catch (e) {
                console.warn('[supabaseSync] INF dump 완료 중계 응답 손상:', (e as Error).message);
                if (attempt === 0) continue;
              }
              break;
            } catch (e) {
              clearTimeout(timeout);
              console.warn(`[supabaseSync] INF dump 완료 중계 결과 불명 (시도 ${attempt + 1}/2):`, (e as Error).message);
              if (attempt === 1) break;
            }
          }
        }
      }
    } catch (e) {
      console.warn('[supabaseSync] INF dump 완료 중계 실패:', (e as Error).message);
    }
  }
  return { ok: true };
}

// ─── Recent 탭 R2 (일반 hist/user) ───────────────────────────────────────────
//
// 두 R2 객체:
//   1) fetchRecentDates(id)            → [{ date_kst, row_count }, ...] desc
//   2) fetchRecentCharts(id, dateKst)  → 그날의 raw chart entry 들 (prev/now 포함)
//   3) fetchUserLatestCharts(id)       → user dp grid → (norm(title)+'|'+diffStr) 인덱스
//      "당일" 박스에서 TSV row 와 비교할 supabase 마지막 row 들.
//
// 일반 hist는 원래 순회 순서로 PREV를 계산한다.

const DIFF_INT_TO_STR: Record<number, string> = {
  0: 'BEGINNER', 1: 'NORMAL', 2: 'HYPER', 3: 'ANOTHER', 4: 'LEGGENDARIA',
};
const LAMP_INT_TO_STR: Record<number, string> = {
  0: 'NO PLAY', 1: 'FAILED', 2: 'ASSIST', 3: 'EASY', 4: 'CLEAR',
  5: 'HARD', 6: 'EX HARD', 7: 'FULL COMBO',
};
// LAMP 풀네임 → INFOhSorry Lamp enum 약어 (lampStyle 호환).
const LAMP_FULL_TO_ABBR: Record<string, string> = {
  'NO PLAY': 'NP', 'FAILED': 'F', 'ASSIST': 'AC', 'EASY': 'EC',
  'CLEAR': 'NC', 'HARD': 'HC', 'EX HARD': 'EX', 'FULL COMBO': 'FC',
};

// 곡명 정규화 — match.ts 의 norm 과 일관.
//   (norm 은 match.ts 에서 import — 위에서 이미 사용 중.)

// DJ Level 계산 — ex_score / (noteCount * 2) → AAA/AA/A/B/C/D/E/F.
//   noteCount 없거나 ex_score <= 0 면 null.
function djLevelFromScore(exScore: number | null | undefined, noteCount: number | null | undefined): string | null {
  if (typeof exScore !== 'number' || exScore <= 0) return null;
  if (typeof noteCount !== 'number' || noteCount <= 0) return null;
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

// textage-meta gist — title (raw) → { textageSongId, levels: {DN,DH,DA,DX}, notes: {...} }.
//   ohSorryWeb fetchTextageMeta 와 같은 url. INFOhSorry 는 메모리 캐시.
const TEXTAGE_DIFF_KEY: Record<string, string> = {
  BEGINNER: 'DB', NORMAL: 'DN', HYPER: 'DH', ANOTHER: 'DA', LEGGENDARIA: 'DX',
};
export interface TextageMeta {
  songs: Record<string, { title?: string; levels?: Record<string, number>; notes?: Record<string, number> }>;
}
let textageMetaCache: TextageMeta | null = null;
async function getTextageMeta(): Promise<TextageMeta | null> {
  if (textageMetaCache) return textageMetaCache;
  try {
    const r = await fetch(TEXTAGE_META_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    const meta = (await r.json()) as TextageMeta;
    if (meta && meta.songs) textageMetaCache = meta;
    return textageMetaCache;
  } catch {
    return null;
  }
}
// PlayData 의 미플레이 곡 gameLevel / noteCount lookup 에 사용. fetch 실패 시 graceful null.
export async function ensureTextageMeta(): Promise<TextageMeta | null> {
  return getTextageMeta();
}

// series-name.json gist — { "99":"NEW", "98":"INFINITAS", "33":"Sparkle Shower", ..., "1":"1st&substream" }.
//   PlayData 의 시리즈 폴더 라벨용. fetch 실패 → 빈 객체 (라벨은 숫자만 표시 fallback).
const SERIES_NAME_URL = 'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw/series-name.json';
let seriesNamesCache: Record<string, string> | null = null;
export async function fetchSeriesNames(): Promise<Record<string, string>> {
  if (seriesNamesCache) return seriesNamesCache;
  try {
    const r = await fetch(SERIES_NAME_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as Record<string, string>;
    seriesNamesCache = j && typeof j === 'object' ? j : {};
    return seriesNamesCache;
  } catch (e) {
    console.warn('[supabaseSync] series-name fetch 실패:', (e as Error).message);
    return {};
  }
}

// recent row 한 줄 → RecentChartRow (UI 가 직접 쓰는 형태).
//   make_recent_data row: { title, diff(int), lamp(int), ex_score, prev_lamp, prev_ex_score,
//                           prev_played_version, played_version, textage_song_id, date }
// noteCount / gameLevel 은 textage-meta lookup. djLevel / prevDjLevel 은 클라이언트 계산.
export interface RecentChartRow {
  title: string;
  diff: string;                     // 'NORMAL' / 'HYPER' / 'ANOTHER' / 'LEGGENDARIA' / 'BEGINNER'
  lamp: string;                     // 풀네임 ('HARD' 등)
  lampAbbr: string;                 // 약어 ('HC' 등) — lampStyle 호환
  exScore: number;
  prevLamp: string | null;
  prevLampAbbr: string | null;
  prevExScore: number | null;
  prevPlayedVersion: number | null;
  playedVersion: number;
  djLevel: string | null;
  prevDjLevel: string | null;
  gameLevel: number | null;
  noteCount: number | null;
  textageSongId: string | null;     // DBR 난이도 맵 매칭용 (textageid|diff)
  date: string | null;              // 같은 날짜 내 정렬용 (timestamp)
}

function viewRowToRecent(r: {
  title: string; diff: number; lamp: number; ex_score: number;
  prev_lamp?: number | null; prev_ex_score?: number | null; prev_played_version?: number | null;
  played_version?: number; textage_song_id?: string | null; date?: string | null;
}, textageMeta: TextageMeta | null): RecentChartRow {
  const diffStr = DIFF_INT_TO_STR[r.diff] || 'ANOTHER';
  const lampStr = LAMP_INT_TO_STR[typeof r.lamp === 'number' ? r.lamp : 0] || 'NO PLAY';
  const prevLampStr = typeof r.prev_lamp === 'number' ? (LAMP_INT_TO_STR[r.prev_lamp] || null) : null;
  let gameLevel: number | null = null;
  let noteCount: number | null = null;
  if (textageMeta && textageMeta.songs && r.textage_song_id) {
    const meta = textageMeta.songs[r.textage_song_id];
    const tKey = TEXTAGE_DIFF_KEY[diffStr];
    if (meta && tKey) {
      if (meta.levels && typeof meta.levels[tKey] === 'number') gameLevel = meta.levels[tKey];
      if (meta.notes && typeof meta.notes[tKey] === 'number' && meta.notes[tKey] > 0) noteCount = meta.notes[tKey];
    }
  }
  const exScore = typeof r.ex_score === 'number' ? r.ex_score : 0;
  const prevExScore = typeof r.prev_ex_score === 'number' ? r.prev_ex_score : null;
  return {
    title: r.title,
    diff: diffStr,
    lamp: lampStr,
    lampAbbr: LAMP_FULL_TO_ABBR[lampStr] || 'NP',
    exScore,
    prevLamp: prevLampStr,
    prevLampAbbr: prevLampStr ? (LAMP_FULL_TO_ABBR[prevLampStr] || null) : null,
    prevExScore,
    prevPlayedVersion: typeof r.prev_played_version === 'number' ? r.prev_played_version : null,
    playedVersion: typeof r.played_version === 'number' ? r.played_version : 0,
    djLevel: djLevelFromScore(exScore, noteCount),
    prevDjLevel: djLevelFromScore(prevExScore, noteCount),
    gameLevel,
    noteCount,
    textageSongId: r.textage_song_id ?? null,
    date: r.date ?? null,
  };
}

// p_dbr=false(기본): DP 일반 플레이 날짜, true: DBR(배틀, played_version=-10) 날짜.
const recentCache = new Map<string, { expiresAt: number; promise: Promise<{ hist: unknown[]; user: unknown }> }>();
const RECENT_CACHE_TTL_MS = 60_000;
type UploadHistResult = { status: 'ok'; hist: unknown[][] } | { status: 'notfound' } | { status: 'error'; error: string };

/** Fetch raw upload-comparison history without Recent's paired user read or TTL cache. */
async function fetchUploadHist(id: string): Promise<UploadHistResult> {
  try {
    const response = await fetch(`${DATA_BASE}/hist/${encodeURIComponent(id)}.json`);
    if (response.status === 404) return { status: 'notfound' };
    if (!response.ok) return { status: 'error', error: `HTTP ${response.status}` };
    let document: unknown;
    try { document = await response.json(); } catch { return { status: 'error', error: 'invalid JSON' }; }
    if (!Array.isArray(document)) return { status: 'error', error: 'invalid hist schema' };
    return { status: 'ok', hist: document as unknown[][] };
  } catch (e) {
    return { status: 'error', error: (e as Error).message };
  }
}

function normalizedRecentId(iidxId: string): string {
  return String(iidxId || '').trim().replace(/-/g, '').toUpperCase();
}
async function fetchRecentObjects(id: string): Promise<{ hist: unknown[]; user: unknown }> {
  const cached = recentCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    const [histRes, userRes] = await Promise.all([
      fetch(`${DATA_BASE}/hist/${encodeURIComponent(id)}.json`),
      fetch(`${DATA_BASE}/user/${encodeURIComponent(id)}.json`),
    ]);
    const read = async (res: Response, kind: string) => {
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${kind} HTTP ${res.status}`);
      try { return await res.json(); } catch { throw new Error(`${kind}: invalid JSON`); }
    };
    const [histDoc, userDoc] = await Promise.all([read(histRes, 'Recent history'), read(userRes, 'Recent user')]);
    if (histDoc === null && userDoc === null) return { hist: [], user: {} };
    if (histDoc === null || userDoc === null) throw new Error('Recent R2 object missing');
    if (!Array.isArray(histDoc)) throw new Error('Recent history: invalid format');
    if (!userDoc || typeof userDoc !== 'object' || Array.isArray(userDoc)
      || !Array.isArray((userDoc as { dp?: unknown }).dp)) throw new Error('Recent user: invalid format');
    return { hist: histDoc, user: userDoc };
  })();
  recentCache.set(id, { expiresAt: Date.now() + RECENT_CACHE_TTL_MS, promise });
  try { return await promise; } catch (e) { recentCache.delete(id); throw e; }
}

export async function fetchRecentDates(iidxId: string, dbrOnly = false): Promise<{ date_kst: string; row_count: number }[]> {
  const id = normalizedRecentId(iidxId);
  if (!id) return [];
  if (dbrOnly) {
    const history = await fetchDbrHistory(id);
    if (history == null) return [];
    const result = getDbrRecentDates(history) as unknown as { complete: boolean; dates: { date_kst: string; row_count: number }[] };
    if (!result.complete) throw new Error('DBR history: complete=false');
    return result.dates;
  }
  const { hist } = await fetchRecentObjects(id);
  const counts = new Map<string, number>();
  for (const raw of hist) {
    if (!Array.isArray(raw)) throw new Error('Recent history: invalid row');
    const pv = raw[4], ex = raw[3], date = raw[6], style = raw[7];
    if (style !== 1 || !(typeof ex === 'number' && ex > 0) || pv === -10) continue;
    if (typeof date !== 'string') throw new Error('Recent history: invalid date');
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  return Array.from(counts, ([date_kst, row_count]) => ({ date_kst, row_count }))
    .sort((a, b) => b.date_kst.localeCompare(a.date_kst));
}

async function fetchDbrHistory(iidxId: string) {
  const id = String(iidxId || '').trim().replace(/-/g, '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(id)) throw new Error('DBR history: invalid IIDX ID');
  const res = await fetch(`${DATA_BASE}/dbr/${encodeURIComponent(id)}.json?fresh=1`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DBR history HTTP ${res.status}`);
  let doc: unknown;
  try { doc = await res.json(); } catch { throw new Error('DBR history: invalid JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('DBR history: invalid document');
  const history = (doc as { history?: unknown }).history;
  if (history == null) throw new Error('DBR history: complete=false');
  validateDbrHistory(history);
  if (!(history as { complete: boolean }).complete) throw new Error('DBR history: complete=false');
  return history as DbrHistory;
}

// DBR 난이도 맵 — dbr-inf-recommend.json(gist) 에서 textageid|diff → dbrLevel 로드 (1회 캐시).
//   DBR 모드 RECENT 의 레벨 칸/곡명 앞에 DBR 난이도 표시 + 정렬에 사용. 실패 시 빈 맵(graceful).
const DBR_RECOMMEND_URL = DATA_BASE + '/dbr-inf-recommend.json';
let _dbrMapCache: Map<string, number> | null = null;
export async function loadDbrMap(): Promise<Map<string, number>> {
  if (_dbrMapCache) return _dbrMapCache;
  const m = new Map<string, number>();
  try {
    const res = await fetch(`${DBR_RECOMMEND_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) {
      const arr = await res.json();
      if (Array.isArray(arr)) {
        for (const s of arr) {
          if (s && s.textageid && s.diff && typeof s.dbrLevel === 'number') {
            m.set(`${s.textageid}|${s.diff}`, s.dbrLevel);
          }
        }
      }
    }
  } catch {
    /* graceful — 못 받으면 빈 맵, 난이도 미표시 */
  }
  _dbrMapCache = m;
  return m;
}

export async function fetchRecentCharts(iidxId: string, dateKst: string, dbrOnly = false): Promise<RecentChartRow[]> {
  const id = normalizedRecentId(iidxId);
  if (!id || !dateKst) return [];
  if (dbrOnly) {
    const history = await fetchDbrHistory(id);
    if (history == null) return [];
    const result = getDbrRecentData(history, dateKst) as unknown as { complete: boolean; rows: Array<{
      song_id: number; diff: number; lamp: number | null; ex_score: number | null; played_version: number;
      prev_lamp: number | null; prev_ex_score: number | null; prev_played_version: number | null;
      textage_song_id?: string; date: string;
    }> };
    if (!result.complete) throw new Error('DBR history: complete=false');
    const [songs, textageMeta] = await Promise.all([getSongsById(), getTextageMeta()]);
    return result.rows.flatMap((r) => {
      const song = songs.get(r.song_id);
      if (!song?.title) return [];
      return [viewRowToRecent({
        title: song.title, diff: r.diff, lamp: r.lamp ?? 0, ex_score: r.ex_score ?? 0,
        prev_lamp: r.prev_lamp, prev_ex_score: r.prev_ex_score,
        prev_played_version: r.prev_played_version, played_version: r.played_version,
        textage_song_id: song.textage_song_id, date: r.date,
      }, textageMeta)];
    });
  }
  const [{ hist }, textageMeta, songs] = await Promise.all([fetchRecentObjects(id), getTextageMeta().catch(() => null), getSongsById()]);
  const lastByKey = new Map<string, { lamp: number; ex_score: number; played_version: number; bp: number | null }>();
  const rows: RecentChartRow[] = [];
  for (const row of hist) {
    if (!Array.isArray(row)) throw new Error('Recent history: invalid row');
    const [songId, diff, lamp, ex, pv, date, dk, style, bp, noteCount] = row;
    if (style !== 1 || !(typeof ex === 'number' && ex > 0) || pv === -10) continue;
    const key = `${songId}|${diff}|${pv}`;
    const prev = lastByKey.get(key) || (typeof pv === 'number' && pv >= 2 ? lastByKey.get(`${songId}|${diff}|${pv - 1}`) : null);
    if (dk === dateKst) {
      const song = songs.get(songId as number);
      if (song?.title) rows.push(viewRowToRecent({ title: song.title, diff: diff as number, lamp: lamp as number,
        ex_score: ex as number, prev_lamp: prev?.lamp ?? null, prev_ex_score: prev?.ex_score ?? null,
        prev_played_version: prev?.played_version ?? null, played_version: pv as number,
        textage_song_id: song.textage_song_id, date: typeof date === 'string' ? date : null,
      }, textageMeta));
    }
    lastByKey.set(key, { lamp: lamp as number, ex_score: ex as number, played_version: pv as number,
      bp: typeof bp === 'number' ? bp : null });
    // noteCount is read to preserve the 8/10-column contract; textage metadata remains authoritative for UI.
    void noteCount;
  }
  return rows;
}

// make_grid_data — 차트별 dedup latest row. "당일" 박스의 PREV (마지막 supabase upload 시점 값) source.
// 반환: norm(title)+'|'+diffStr → { lamp, lampAbbr, exScore, playedVersion, djLevel, noteCount, gameLevel }.
export interface LatestChartEntry {
  lamp: string;
  lampAbbr: string;
  exScore: number;
  playedVersion: number;
  djLevel: string | null;
  noteCount: number | null;
  gameLevel: number | null;
}
async function fetchGridDataRows(id: string): Promise<Array<{
  title: string; diff: number; lamp: number; ex_score: number; played_version?: number; textage_song_id?: string | null;
}>> {
  const [{ user }, songs] = await Promise.all([fetchRecentObjects(id), getSongsById()]);
  const doc = user as { dp: Array<Record<string, unknown>> };
  return doc.dp.map((r) => {
    const song = songs.get(Number(r.song_id));
    return { title: song?.title ?? '', diff: Number(r.diff), lamp: Number(r.lamp), ex_score: Number(r.ex_score),
      played_version: typeof r.played_version === 'number' ? r.played_version : undefined,
      textage_song_id: song?.textage_song_id ?? null };
  });
}
export async function fetchUserLatestCharts(iidxId: string): Promise<Map<string, LatestChartEntry>> {
  const id = String(iidxId || '').trim().replace(/-/g, '');
  if (!id) return new Map();
  const [scoreRows, textageMeta] = await Promise.all([
    fetchGridDataRows(id),
    getTextageMeta().catch(() => null),
  ]);
  const idx = new Map<string, LatestChartEntry>();
  for (const r of scoreRows) {
    if (!r.title || r.diff == null) continue;
    const diffStr = DIFF_INT_TO_STR[r.diff] || 'ANOTHER';
    const lampStr = LAMP_INT_TO_STR[typeof r.lamp === 'number' ? r.lamp : 0] || 'NO PLAY';
    let gameLevel: number | null = null;
    let noteCount: number | null = null;
    if (textageMeta && textageMeta.songs && r.textage_song_id) {
      const meta = textageMeta.songs[r.textage_song_id];
      const tKey = TEXTAGE_DIFF_KEY[diffStr];
      if (meta && tKey) {
        if (meta.levels && typeof meta.levels[tKey] === 'number') gameLevel = meta.levels[tKey];
        if (meta.notes && typeof meta.notes[tKey] === 'number' && meta.notes[tKey] > 0) noteCount = meta.notes[tKey];
      }
    }
    const exScore = typeof r.ex_score === 'number' ? r.ex_score : 0;
    idx.set(norm(r.title) + '|' + diffStr, {
      lamp: lampStr,
      lampAbbr: LAMP_FULL_TO_ABBR[lampStr] || 'NP',
      exScore,
      playedVersion: typeof r.played_version === 'number' ? r.played_version : 0,
      djLevel: djLevelFromScore(exScore, noteCount),
      noteCount,
      gameLevel,
    });
  }
  return idx;
}

type PlayHistoryParse = { rows: PlayCsvRow[]; lastCompleteError: { columns: number } | null; errorCode?: number };
function tokenizePlayHistory(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { record.push(field); field = ''; }
    else if (c === '\n' && !quoted) {
      record.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      records.push(record); record = []; field = '';
    } else field += c;
  }
  return records;
}
export function parsePlayHistoryDetailed(csv: string): PlayHistoryParse {
  const records = tokenizePlayHistory(csv);
  const header = records.shift();
  const legacyHeader = !!header && header.length === PLAY_CSV_LEGACY_KEYS.length && PLAY_CSV_LEGACY_KEYS.every((key, i) => header[i] === key);
  const currentHeader = !!header && header.length === PLAY_CSV_KEYS.length && PLAY_CSV_KEYS.every((key, i) => header[i] === key);
  if (!legacyHeader && !currentHeader) return { rows: [], lastCompleteError: null, errorCode: -9 };
  const valid: PlayCsvRow[] = [];
  let lastCompleteError: { columns: number } | null = null;
  for (const row of records) {
    if (row.length !== PLAY_CSV_LEGACY_KEYS.length && row.length !== PLAY_CSV_KEYS.length) { lastCompleteError = { columns: row.length }; continue; }
    const mapped = Object.fromEntries(PLAY_CSV_KEYS.map((key, i) => [key, row[i] ?? ''])) as PlayCsvRow;
    valid.push(mapped);
    lastCompleteError = null;
  }
  return { rows: valid, lastCompleteError };
}
export function buildUploadPlays(result: PlayCsvReadResult): PlayCsvRow[] {
  const versions = { appVersion: result.appVersion ?? '', gameVersion: result.gameVersion ?? '' };
  const error = (code: number) => [buildPlayErrorRow(code, versions, new Date().toISOString())];
  if (!result.ok) return error(-11);
  if (result.found === false) return error(-8);
  const parsed = parsePlayHistoryDetailed(result.csv ?? '');
  if (parsed.errorCode === -9) return error(-9);
  if (parsed.rows.length === 0) return error(-10);
  return parsed.rows.slice(-100);
}
export function parsePlayHistory(csv: string): PlayCsvRow[] { return parsePlayHistoryDetailed(csv).rows; }
// 기존 최근 100행 동작을 유지한다.
export function parseRecentPlays(csv: string): PlayCsvRow[] { return parsePlayHistory(csv).slice(-100); }

export function isCompletedPlay(row: PlayCsvRow): boolean {
  if (isPlayErrorRow(row)) return false;
  // INFOhSorry/docs/play-logger.md:168-170: 일반 DP 행에서 BAD와 놓친 POOR를 포함한 판정 합계가 notes와 같을 때 완주다. 콤보 브레이크는 BAD+놓친 POOR이며 공POOR는 끊지 않으므로 합계에서 제외한다. BP(miss_count)는 BAD+POOR(공POOR 포함)로 게임 BP와 같은 값이므로 그대로 쓴다.
  const j = row.judge_16.trim().split(/\s+/).map(Number);
  const notes = Number(row.notes);
  return j.length === 16 && j.every(Number.isFinite) && j.every(Number.isInteger) && Number.isFinite(notes) && notes > 0
    && (j[0] + j[1] + j[2]) + (j[5] + j[6] + j[7]) + j[10] + j[11] === notes;
}
const strictNumber = (value: string): number | null => {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n !== 4294967295 ? n : null;
};
export function decodeArrangeScore(row: PlayCsvRow) {
  const lamp = strictNumber(row.clear_lamp); const bp = strictNumber(row.miss_count); const ex = strictNumber(row.ex_score);
  return { lamp: lamp != null && lamp >= 1 && lamp <= 8 ? lamp : null, bp, ex };
}
export function compareArrangeScores(previous: { lamp: number | null; bp: number | null; ex: number | null } | null,
  current: { lamp: number | null; bp: number | null; ex: number | null }) {
  const improved = { lamp: previous?.lamp != null && current.lamp != null && current.lamp > previous.lamp,
    bp: previous?.bp != null && current.bp != null && current.bp < previous.bp,
    ex: previous?.ex != null && current.ex != null && current.ex > previous.ex };
  const count = Number(improved.lamp) + Number(improved.bp) + Number(improved.ex);
  return { previous: previous ?? { lamp: null, bp: null, ex: null }, improved, count };
}
export function evaluateAutomaticArrange(history: PlayCsvRow[] | PlayHistoryParse) {
  const parsed = Array.isArray(history) ? { rows: history, lastCompleteError: null } : history;
  if (parsed.lastCompleteError != null) return { excluded: true as const, reason: 'last_row_invalid' };
  const rows = parsed.rows;
  const last = rows[rows.length - 1];
  if (!last || isPlayErrorRow(last) || !isCompletedPlay(last)) return { excluded: true as const, reason: 'current_not_completed' };
  const currentRow = last;
  if (!['DPB', 'DPN', 'DPH', 'DPA', 'DPL'].includes(currentRow.difficulty)) return { excluded: true as const, reason: 'not_dp' };
  const currentSettings = currentRow.settings_p1_11.trim().split(/\s+/).map(Number);
  const validSettings = (p: number[]) => p.length === 11 && p.every(Number.isInteger) && p[3] >= 0 && p[3] <= 1
    && [p[0],p[5]].every(v => v >= 0 && v <= 4) && p[2] === 0 && p[9] === 0 && p[10] === 0;
  const decode = (row: PlayCsvRow, p: number[]) => {
    if (row.source !== 'playdata' || row.battle_flag !== '0' || !validSettings(p)) return null;
    return decodeArrangeScore(row);
  };
  const current = decode(currentRow, currentSettings);
  const previousRows = rows.slice(0, -1).filter(row => row.song_id === currentRow.song_id && row.difficulty === currentRow.difficulty
    && isCompletedPlay(row)).map(row => decode(row, row.settings_p1_11.trim().split(/\s+/).map(Number))).filter((v): v is NonNullable<typeof v> => v !== null);
  if (!current) return { excluded: true as const, reason: 'invalid_current' };
  const best = previousRows.reduce<{ lamp: number | null; bp: number | null; ex: number | null }>((acc, value) => ({
    lamp: value.lamp == null ? acc.lamp : Math.max(acc.lamp ?? -Infinity, value.lamp),
    bp: value.bp == null ? acc.bp : Math.min(acc.bp ?? Infinity, value.bp),
    ex: value.ex == null ? acc.ex : Math.max(acc.ex ?? -Infinity, value.ex),
  }), { lamp: null, bp: null, ex: null });
  const compared = compareArrangeScores(previousRows.length ? best : null, current);
  const diffs: Record<string, number> = { DPB: 0, DPN: 1, DPH: 2, DPA: 3, DPL: 4 };
  const option = currentSettings;
  const v = [0,8,24,16,2][option[0]] | [0,32,96,64,4][option[5]] | (option[3] ? 1 : 0);
  return { current: currentRow, previous: compared.previous, improved: compared.improved, count: compared.count,
    arrange: v === 0 ? -2 : v, diff: diffs[currentRow.difficulty], excluded: false as const };
}

export function playsForGame(plays: PlayCsvRow[] | null | undefined, gameRecognized: boolean): PlayCsvRow[] | null | undefined {
  return gameRecognized ? plays : undefined;
}

// DBR 후보 조건과 옵션 값은 사용자 지정 명세를 따른다.
export const GAUGE_COLUMN = 'gauge_p2_w78';
export interface BattleRandomScore { diff: number; lamp: number; ex_score: number }
export function decodeBattleRandomPlay(row: PlayCsvRow): BattleRandomScore | null {
  if (isPlayErrorRow(row)) return null;
  const p1 = row.settings_p1_11.split(' ').map(Number);
  if (p1.length !== 11 || p1.some(value => !Number.isInteger(value))
    || row.battle_flag !== '1' || p1[0] !== 1 || p1[5] !== 1 || p1[2] !== 1) return null;
  const diffs: Record<string, number> = { SPB: 0, SPN: 1, SPH: 2, SPA: 3, SPL: 4 };
  if (!row.song_id.trim() || !/^\d+(?:\.\d+)?$/.test(row.song_id) || !row.ex_score.trim()
    || !row.notes.trim() || !row[GAUGE_COLUMN].trim()) return null;
  const songId = Number(row.song_id); const diff = diffs[row.difficulty];
  const exScore = Number(row.ex_score); const notes = Number(row.notes); const gauge = Number(row[GAUGE_COLUMN]);
  if (!Number.isSafeInteger(songId) || songId < 0 || !Number.isInteger(diff)
    || !Number.isFinite(exScore) || exScore < 0 || !Number.isFinite(notes) || notes <= 0
    || !Number.isFinite(gauge) || gauge < 0) return null;
  let lamp: number;
  switch (p1[1]) {
    case 1: case 2: lamp = gauge >= 80 ? 3 : gauge >= 60 ? 2 : 1; break;
    case 0: lamp = gauge >= 80 ? 4 : 1; break;
    case 3: lamp = gauge > 0 ? 5 : 1; break;
    case 4: lamp = gauge > 0 ? 6 : 1; break;
    default: return null;
  }
  return { diff, lamp, ex_score: exScore };
}
function matchAutomaticSong(songs: Map<string, SongEntry[]>, title: string, diff: number):
  { songId: number } | { skipped: 'song_not_found' | 'ambiguous_song' } {
  const candidates = songs.get(norm(title)) ?? [];
  const matches = candidates.filter(song => (((diff === 4 ? song.legen : song.ac) ?? 0) & 2) !== 0);
  if (matches.length === 1) return { songId: matches[0].song_id };
  return { skipped: matches.length ? 'ambiguous_song' : 'song_not_found' };
}
const REMOTE_API_ORIGIN = 'https://iidx.in';
// Web 원격 인증과 같은 issue/exchange와 Bearer 세션을 사용한다. 별도 토큰 저장소는 없다.
async function existingRemoteBearer(iidxId: string): Promise<string | null> {
  const key = 'ohsorry:remoteAuthToken';
  let token = localStorage.getItem(key);
  if (!token) {
    const issued = await fetch(`${REMOTE_API_ORIGIN}/auth/issue`, { method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iidx_id: iidxId, source: 'inf' }) });
    if (!issued.ok) return null;
    const ticket = new URL((await issued.json()).url).searchParams.get('ticket');
    if (!ticket) return null;
    const exchanged = await fetch(`${REMOTE_API_ORIGIN}/auth/exchange`, { method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, mode: 'token' }) });
    if (!exchanged.ok) return null;
    token = (await exchanged.json()).token;
    if (!token) return null;
    localStorage.setItem(key, token);
  }
  const session = await fetch(`${REMOTE_API_ORIGIN}/auth/session`, { credentials: 'omit', headers: { Authorization: `Bearer ${token}` } });
  if (!session.ok) return null;
  const data = await session.json();
  return data.logged_in && data.iidx_id === iidxId ? token : null;
}

// 한 INF 클라이언트의 DBR POST는 전송 중에만 직렬화한다. 재시도 큐는 없다.
let dbrSending: Promise<void> | null = null;
export async function uploadAutomaticDbr(plays: PlayCsvRow[], iidxId: string, gameRecognized: () => Promise<boolean>,
  decode: (row: PlayCsvRow) => BattleRandomScore | null = decodeBattleRandomPlay,
  bearer: (id: string) => Promise<string | null> = existingRemoteBearer,
  send: typeof fetch = fetch, songs: () => Promise<Map<string, SongEntry[]>> = getSongsCache): Promise<void> {
  while (dbrSending) await dbrSending;
  let finish!: () => void;
  dbrSending = new Promise<void>(resolve => { finish = resolve; });
  try {
    const candidates = plays.map(row => ({ row, score: decode(row) })).filter((item): item is { row: PlayCsvRow; score: BattleRandomScore } => item.score !== null);
    if (!candidates.length || !await gameRecognized()) return;
    const token = await bearer(iidxId);
    if (!token) return;
    const songMap = await songs();
    for (const { row, score } of candidates) {
      const match = matchAutomaticSong(songMap, row.title, score.diff);
      if ('skipped' in match) continue;
      if (!await gameRecognized()) return;
      const response = await send(`${REMOTE_API_ORIGIN}/api/me/dbr-scores`, { method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ song_id: match.songId, diff: score.diff, lamp: score.lamp, ex_score: score.ex_score, improvements_only: true }) });
      if (!response.ok) throw new Error(`DBR HTTP ${response.status}`);
    }
  } finally { dbrSending = null; finish(); }
}

// 자동 배열은 현재 완주 행 하나만 원격 배열로 upsert한다. 애매한 곡명은 전송하지 않는다.
export async function uploadAutomaticArrange(evaluation: ReturnType<typeof evaluateAutomaticArrange>, iidxId: string,
  gameRecognized: () => Promise<boolean>, bearer: (id: string) => Promise<string | null> = existingRemoteBearer,
  send: typeof fetch = fetch, songs: () => Promise<Map<string, SongEntry[]>> = getSongsCache): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  if (evaluation.excluded) return { ok: true, skipped: evaluation.reason };
  if (!await gameRecognized()) return { ok: true, skipped: 'game_unrecognized' };
  const token = await bearer(iidxId);
  if (!token) return { ok: true, skipped: 'unauthenticated' };
  try {
    const match = matchAutomaticSong(await songs(), evaluation.current.title, evaluation.diff);
    if ('skipped' in match) return { ok: true, skipped: match.skipped };
    // DBR와 같이 전송 직전에 기존 게임 인식 검사를 한 번 더 한다.
    if (!await gameRecognized()) return { ok: true, skipped: 'game_unrecognized' };
    const response = await send(`${REMOTE_API_ORIGIN}/api/me/chart-arrange`, { method: 'PUT', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ song_id: match.songId, diff: evaluation.diff, play_style: 1, arrange: evaluation.arrange }) });
    if (!response.ok) throw new Error(`Arrange HTTP ${response.status}`);
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message;
    console.warn('[supabaseSync] 자동 배열 업로드 실패:', error);
    return { ok: false, error };
  }
}
