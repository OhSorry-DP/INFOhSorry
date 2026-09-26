import { norm } from '../shared/match';

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
export function composeV3Profile(remote: AnyRecord, cdn: AnyRecord | null, songIndex: SongIndex | null): AnyRecord {
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
  return out;
}

type Cache<T> = { value: T; expires: number };
let songsCache: Cache<{ index: SongIndex }> | null = null;
const profileCache = new Map<string, Cache<AnyRecord | null>>();

// 원격 요청에 공통 timeout과 no-store 옵션을 적용한다.
async function get(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try { return await fetch(url, { signal: controller.signal, cache: 'no-store' }); }
  finally { clearTimeout(timeout); }
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

async function profile(id: string): Promise<{ value: AnyRecord | null; status: 'ok' | 'notfound' | 'error' }> {
  const now = Date.now();
  const old = profileCache.get(id);
  if (old && old.expires > now) return { value: old.value, status: old.value ? 'ok' : 'notfound' };
  try {
    const response = await get(`https://data.iidx.in/user/${id.replace(/-/g, '').toUpperCase()}.json`);
    if (response.status === 404) { profileCache.set(id, { value: null, expires: now + 300000 }); return { value: null, status: 'notfound' }; }
    if (!response.ok) throw Error();
    const value = await response.json() as AnyRecord;
    profileCache.set(id, { value, expires: now + 600000 });
    return { value, status: 'ok' };
  } catch { return old?.value ? { value: old.value, status: 'ok' } : { value: null, status: 'error' }; }
}

export async function getV3Profile(remote: unknown): Promise<AnyRecord | null> {
  const value = remote as AnyRecord | null;
  if (!value || !value.iidx_id) return null;
  const [songIndex, result] = await Promise.all([songs(), profile(String(value.iidx_id))]);
  const out = composeV3Profile(value, result.value, songIndex);
  out._remote.cdn = result.status;
  if (!songIndex) out._remote.songs = 'error';
  return out;
}
