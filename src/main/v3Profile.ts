import { norm } from '../shared/match';
import { buildRemoteRecentRows } from './remoteRecent';

type AnyRecord = Record<string, any>;
type SongRecord = AnyRecord & { title?: string; song_id: string | number; ac?: number };
export type SongIndex = Map<string, SongRecord[]>;

const DIFF: Record<string, number> = { BEGINNER: 0, NORMAL: 1, HYPER: 2, ANOTHER: 3, LEGGENDARIA: 4 };

// 제목 정규화는 shared/match.ts의 공통 규칙을 사용한다.
export function buildSongIndex(songs: SongRecord[]): SongIndex {
  const index: SongIndex = new Map();
  for (const song of songs) {
    const key = norm(song.title ?? '');
    const candidates = index.get(key) ?? [];
    candidates.push(song);
    index.set(key, candidates);
  }
  return index;
}

// 후보 선택 규칙은 renderer/src/supabaseSync.ts:153-162를 따른다.
function pickSongId(candidates: SongRecord[]): string | number | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].song_id;
  const filtered = candidates.filter((song) => (Number(song.ac) & 2) !== 0);
  return (filtered[0] ?? candidates[0]).song_id;
}

// CDN 프로필이 없을 때에도 화면이 소비할 기본 구조를 만든다.
function empty(remote: AnyRecord): AnyRecord {
  return { _v: null, user: { iidx_id: remote.iidx_id ?? null }, radars: [], osPattern: [], persona: null, spPersona: null, dp: [], sp: [], dpRecent: [], spRecent: [], reachNps: null };
}

// 원격 사용자 정보와 차트 점수를 CDN 프로필에 합친다.
export function composeV3Profile(remote: AnyRecord, cdn: AnyRecord | null, songIndex: SongIndex | null, nowIso = new Date().toISOString()): AnyRecord {
  const mappedRows: Array<{ song_id: string | number; diff: number; play_style: number; lamp: number; ex_score: number; bp: number | null; note_count: number | null }> = [];
  const out = cdn ? JSON.parse(JSON.stringify(cdn)) as AnyRecord : empty(remote);
  out.user = { ...(out.user || {}) };
  const fields: Record<string, string> = { dj_name: 'dj_name', star: 'star_estimate', native_star: 'native_star', ereter_star: 'ereter_star', r_star: 'r_star', sp_cpi: 'sp_cpi', sp_star: 'sp_star', sp_rank: 'sp_rank', dp_rank: 'dp_rank' };
  for (const [to, from] of Object.entries(fields)) {
    if (remote[from] !== null && remote[from] !== undefined) out.user[to] = remote[from];
  }
  if (out.user.iidx_id == null) out.user.iidx_id = remote.iidx_id ?? null;
  let matched = 0;
  let unmatched = 0;

  // 인덱스가 없으면 CDN 행은 보존하고 원격 사용자 정보만 덮어쓴다.
  const apply = (key: 'dp' | 'sp', charts: AnyRecord[]): void => {
    if (!songIndex) return;
    const rows: AnyRecord[] = Array.isArray(out[key]) ? out[key] : (out[key] = []);
    for (const chart of charts || []) {
      const id = pickSongId(songIndex.get(norm(String(chart.title ?? ''))) ?? []);
      const diff = DIFF[String(chart.diff)];
      if (id == null || diff === undefined) { unmatched++; continue; }
      mappedRows.push({ song_id: id, diff, play_style: key === 'dp' ? 1 : 0, lamp: chart.lampNum, ex_score: chart.exScore, bp: chart.missCount ?? null, note_count: chart.noteCount ?? null });
      const row = rows.find((item) => item.song_id === id && item.diff === diff && item.played_version === 0);
      if (row) {
        row.lamp = chart.lampNum;
        row.ex_score = chart.exScore;
        if (chart.missCount != null) row.bp = chart.missCount;
        if (chart.noteCount != null) row.note_count = chart.noteCount;
        matched++;
      } else if (!(chart.lampNum === 0 && chart.exScore === 0)) {
        rows.push({ song_id: id, diff, lamp: chart.lampNum, ex_score: chart.exScore, played_version: 0, date: null, bp: chart.missCount ?? null, note_count: chart.noteCount ?? null });
        matched++;
      }
    }
  };
  apply('dp', Array.isArray(remote.charts_json) ? remote.charts_json : []);
  apply('sp', Array.isArray(remote.sp_charts_json) ? remote.sp_charts_json : []);
  out._remote = { matched, unmatched, cdn: cdn ? 'ok' : 'notfound' };
  const normalizedId = String(remote.iidx_id ?? '').replace(/-/g, '').trim().toUpperCase();
  const cdnOwner = String(cdn?.user?.iidx_id ?? '').replace(/-/g, '').trim().toUpperCase();
  const ownerMatches = !cdn || !cdnOwner || cdnOwner === normalizedId;
  out.remote_recent = { iidx_id: normalizedId, date_kst: new Date(Date.parse(nowIso) + 9 * 3600000).toISOString().slice(0, 10), cdn_revision: ownerMatches && cdn?._v != null ? String(cdn._v) : null, rows: ownerMatches && songIndex ? buildRemoteRecentRows(mappedRows, cdn, nowIso) : [] };
  return out;
}

type Cache<T> = { value: T; expires: number };
let songsCache: Cache<{ index: SongIndex }> | null = null;
async function get(url: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8000);
  try { return await fetchImpl(url, { signal: controller.signal, cache: 'no-store' }); } finally { clearTimeout(timeout); }
}

export function createV3CdnProfileLoader(fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
  type Result = { value: AnyRecord | null; status: 'ok' | 'notfound' | 'error'; revision: string | null };
  const cache = new Map<string, { result: Result; expires: number }>();
  const lastSuccess = new Map<string, AnyRecord>();
  const inFlight = new Map<string, Promise<Result>>();
  const load = (id: string): Promise<Result> => {
    const key = id.replace(/-/g, '').trim().toUpperCase(); const current = now(); const cached = cache.get(key);
    if (cached && cached.expires > current) return Promise.resolve(cached.result);
    const active = inFlight.get(key); if (active) return active;
    const request = (async (): Promise<Result> => {
      try {
        const response = await get(`https://data.iidx.in/user/${key}.json`, fetchImpl);
        if (response.status === 404) { const result: Result = { value: null, status: 'notfound', revision: null }; cache.set(key, { result, expires: now() + 60000 }); return result; }
        if (!response.ok) throw Error();
        const value = await response.json() as AnyRecord; lastSuccess.set(key, value);
        const result: Result = { value, status: 'ok', revision: value._v == null ? null : String(value._v) }; cache.set(key, { result, expires: now() + 60000 }); return result;
      } catch {
        const value = lastSuccess.get(key) ?? null; const result: Result = { value, status: 'error', revision: value?._v == null ? null : String(value._v) };
        cache.set(key, { result, expires: now() + 60000 }); return result;
      }
    })();
    inFlight.set(key, request); void request.finally(() => { if (inFlight.get(key) === request) inFlight.delete(key); }); return request;
  };
  return { load };
}

// songs 캐시를 갱신할 때 제목 인덱스도 한 번만 만든다.
async function songs(): Promise<SongIndex | null> {
  const now = Date.now();
  if (songsCache && songsCache.expires > now) return songsCache.value.index;
  try {
    const response = await get('https://data.iidx.in/songs.json');
    if (!response.ok) throw Error();
    const value = await response.json() as SongRecord[];
    const index = buildSongIndex(value);
    songsCache = { value: { index }, expires: now + 3600000 };
    return index;
  } catch { return songsCache?.value.index ?? null; }
}

const defaultProfileLoader = createV3CdnProfileLoader();

export async function getV3Profile(remote: unknown): Promise<AnyRecord | null> {
  const value = remote as AnyRecord | null;
  if (!value || !value.iidx_id) return null;
  const [songIndex, result] = await Promise.all([songs(), defaultProfileLoader.load(String(value.iidx_id))]);
  const owner = String(result.value?.user?.iidx_id ?? '').replace(/-/g, '').trim().toUpperCase();
  const cdn = result.value;
  const out = composeV3Profile(value, cdn, songIndex);
  out._remote.cdn = result.status;
  if (owner && owner !== String(value.iidx_id).replace(/-/g, '').trim().toUpperCase()) { out.remote_recent.rows = []; out.remote_recent.cdn_revision = null; }
  if (!songIndex) out._remote.songs = 'error';
  if (result.status === 'error' && !result.value) out.remote_recent.rows = [];
  if (!owner || owner === String(value.iidx_id).replace(/-/g, '').trim().toUpperCase()) out.remote_recent.cdn_revision = cdn?._v == null ? null : String(cdn._v);
  return out;
}
