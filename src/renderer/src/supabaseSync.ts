// Supabase 새 디비 (users + scores) upsert — Reflux 데이터 갱신 시마다 무조건 덮어쓰기.
// ohSorry / INFOhSorry 가 같은 DB 공유 (iidx_id text PK 라 namespace 호환).
//
// 차이점 (ohSorry 와):
//   - iidx_id 형식: ohSorry = 8자리 숫자 (xxxx-xxxx 의 하이픈 제거), INFOhSorry = "C293036891870" (C + 12자리)
//   - played_version: 0 (INF)
//   - song matching: songs.ac & 2 (INF) 인 곡만 매칭 (동명이곡 자동 분리)
//   - user_radar 업로드 X (INF 는 notes radar 데이터 없음)
//
// 마이그레이션:
//   - 옛 RPC: upsert_user_profile + upsert_user_chart_scores (user_profiles + user_chart_scores)
//   - 새 RPC: upsert_user + upsert_scores (users + scores)
//   - songs 마스터 캐시 (norm key → [{ song_id, title, ac }]) + ac flag pickSongId
//   - 같은 PK (song_id, iidx_id, diff, played_version) 중복 안전망 dedup (best ex_score / lamp)
//
// fire-and-forget — 실패해도 사용자 경험에 영향 X.
import type { ProfileInfo } from './useProfile';
import type { StarResult } from '../../shared/star-estimator';
import type { RecInputChart } from '../../shared/recommend';
import { norm } from '../../shared/match';

const SUPABASE_URL = 'https://cvxpeecxiawddmrzbdvn.supabase.co';
// Legacy JWT anon key (publishable key 는 RLS 호환성 문제로 사용 X) — ohSorry 와 동일
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2eHBlZWN4aWF3ZGRtcnpiZHZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5ODMxMzQsImV4cCI6MjA5NDU1OTEzNH0.lWnnSsSIFFLs7NsJq5yI6fe9HPiT9yQ3Pj-8sgfGuxI';
const HEADERS = {
  'Content-Type': 'application/json',
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

// 새 디비 변환 매핑 (dbConn.js 와 동일)
const DIFF_MAP: Record<string, number> = { BEGINNER: 0, NORMAL: 1, HYPER: 2, ANOTHER: 3, LEGGENDARIA: 4 };
const LAMP_MAP: Record<string, number> = { NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7 };
const PLAYED_VERSION_INF = 0;

interface SongEntry { song_id: number; title: string; ac: number; legen: number }

// textage-meta gist — title (raw) → textage_song_id 매핑 빌드. ensure_song 호출 시
//   p_textage_song_id 전달 → ON CONFLICT (textage_song_id) 분기로 옛 row 와 자동 통합.
//   supabase songs cache 가 stale 한 케이스 (옛 row 와 norm 매칭 실패) 에서 textage-meta 가 fresh 면
//   textage_song_id UNIQUE 키로 매칭 → series_no=99 새 row 생성 안 됨.
const TEXTAGE_META_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw/textage-meta.json';
let textageByTitle: Map<string, string> | null = null;
async function getTextageByTitle(): Promise<Map<string, string>> {
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

// songs 마스터 캐시 (norm(title) → SongEntry[]) — 페이징 fetch + 메모리 보관
let songsCache: Map<string, SongEntry[]> | null = null;
async function getSongsCache(): Promise<Map<string, SongEntry[]>> {
  if (songsCache) return songsCache;
  const byNorm = new Map<string, SongEntry[]>();
  const pageSize = 1000;
  let offset = 0;
  let totalFetched = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/songs?select=song_id,title,ac,legen&order=song_id.asc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`songs fetch HTTP ${res.status}`);
    const rows = (await res.json()) as SongEntry[];
    for (const r of rows) {
      if (!r.title) continue;
      const k = norm(r.title);
      if (!k) continue;
      const entry: SongEntry = { song_id: r.song_id, title: r.title, ac: r.ac, legen: r.legen };
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
  songsCache = byNorm;
  console.log(`[supabaseSync] songs 매핑 캐시: ${byNorm.size} unique norm / ${totalFetched} 곡 fetch`);
  return byNorm;
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
function pickSongId(candidates: SongEntry[] | undefined, playedVersion: number): number | null {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].song_id;
  const wantInf = playedVersion === 0;
  const mask = wantInf ? 2 : 1;
  const filtered = candidates.filter((c) => (c.ac & mask) !== 0);
  if (filtered.length === 1) return filtered[0].song_id;
  if (filtered.length === 0) return candidates[0].song_id;
  return filtered[0].song_id;
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
  spRank: number | null;   // int 매핑 — setup_users.sql 의 매핑 (12=皆伝 / 11=中伝 / 10~1=十段~初段 / 0=一級 / -8~-1=九級~二級)
  dpRank: number | null;
}

const EMPTY_PUBLIC: UserPublicInfo = { dpRadar: null, spRank: null, dpRank: null };

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
    `&select=sp_rank,dp_rank` +
    `&limit=1`;

  const [radarResult, userResult] = await Promise.allSettled([
    fetch(radarUrl, { headers: HEADERS }).then(async (r) => r.ok ? (await r.json()) as DpRadarRow[] : []),
    fetch(userUrl,  { headers: HEADERS }).then(async (r) => r.ok ? (await r.json()) as Array<{ sp_rank: number | null; dp_rank: number | null }> : []),
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
  if (userResult.status === 'fulfilled' && userResult.value.length > 0) {
    const u = userResult.value[0];
    spRank = typeof u.sp_rank === 'number' ? u.sp_rank : null;
    dpRank = typeof u.dp_rank === 'number' ? u.dp_rank : null;
  }

  return { dpRadar, spRank, dpRank };
}

export interface UploadInput {
  appVersion: string; // package.json version, e.g. '0.0.9'
  profile: ProfileInfo;
  starResult: StarResult;
  charts: RecInputChart[]; // dp12Match.charts (★11.6~12.7 ereter 매칭된 차트) + unclassified 도 합쳐 올림
  unclassifiedCharts?: Omit<RecInputChart, 'level'>[];
  // 선택: ereter 매핑 있으면 함께 (대개 INF ID 는 ereter 에 없어 null)
  ereterStar?: number | null;
}

interface ScoreRow {
  song_id: number;
  iidx_id: string;
  diff: number;
  lamp: number | null;
  ex_score: number | null;
  played_version: number;
  date: string;
}

export async function uploadProfile(input: UploadInput): Promise<{ ok: boolean; error?: string }> {
  const { appVersion, profile, starResult, charts, unclassifiedCharts, ereterStar } = input;

  // 원격 service status — uploadEnabled === false 면 upload skip
  const status = await window.infohsorry.serviceStatus.get();
  if (!status.uploadEnabled) {
    return { ok: false, error: status.message || 'upload disabled by remote service status' };
  }

  // iidx_id 정규화 — 하이픈 제거 (INF 는 원래 없는 형식이지만 안전망)
  const rawId = profile.iidxId;
  if (!rawId) return { ok: false, error: 'iidx_id 없음' };
  const iidxIdNorm = rawId.replace(/-/g, '');

  // 1. users upsert (RPC upsert_user) — INF 는 sp_rank/dp_rank 없음, ereter_star 만 옵션
  try {
    const userRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_user`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        p_iidx_id: iidxIdNorm,
        p_dj_name: profile.djName ?? null,
        p_star: Number(starResult.star.toFixed(4)),
        p_ereter_star: ereterStar != null ? Number(ereterStar) : null,
        // SP/DP 단위는 절대 업셋하지 않음 — null 보내 RPC COALESCE 가 기존 값 유지.
        // 단위 채우는 책임: ohSorryAdmin/getInfRadar.js (eagate djdata 페이지에서 fetch).
        // INFOhSorry 메모리 리딩에서 단위가 안 잡혀도 supabase 저장값을 fetchUserPublic 으로 받아 ProfileCard 에 표시.
        p_sp_rank: null,
        p_dp_rank: null,
      }),
    });
    if (!userRes.ok) {
      const errText = await userRes.text().catch(() => '');
      return { ok: false, error: `users HTTP ${userRes.status} ${errText}` };
    }
  } catch (e) {
    return { ok: false, error: `users error: ${(e as Error).message}` };
  }

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

  // dedup map — key: `${song_id}|${iidx_id}|${diff}|${played_version}` → row
  const dedup = new Map<string, ScoreRow>();
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
    const lampInt = c.lamp != null && LAMP_MAP[c.lamp] != null ? LAMP_MAP[c.lamp] : null;
    const exScore = c.exScore != null ? Number(c.exScore) : null;
    const newRow: ScoreRow = {
      song_id: songId,
      iidx_id: iidxIdNorm,
      diff: diffInt,
      lamp: lampInt,
      ex_score: exScore,
      played_version: PLAYED_VERSION_INF,
      date: scoreDate,
    };
    const pk = `${songId}|${iidxIdNorm}|${diffInt}|${PLAYED_VERSION_INF}`;
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
  const scoreRows = [...dedup.values()];
  if (autoEnsured > 0) console.log(`[supabaseSync] songs 마스터 자동 등록 (ensure_song) ${autoEnsured}건:`, autoEnsuredSamples);
  if (unmatched > 0) console.warn(`[supabaseSync] song 매칭 실패 ${unmatched}건 (skip). 샘플:`, unmatchedSamples);
  if (invalidDiff > 0) console.warn(`[supabaseSync] diff 변환 실패 ${invalidDiff}건 (skip)`);
  console.log(`[supabaseSync] appVersion=${appVersion} scores upsert: ${scoreRows.length}건 (전체 ${allChartsForScores.length}건 중, dedup 후)`);

  if (scoreRows.length === 0) {
    return { ok: true };
  }

  try {
    const chartRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_scores`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ p_rows: scoreRows }),
    });
    if (!chartRes.ok) {
      const errText = await chartRes.text().catch(() => '');
      return { ok: false, error: `scores HTTP ${chartRes.status} ${errText}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `scores error: ${(e as Error).message}` };
  }
}
