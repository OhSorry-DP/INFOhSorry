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

interface SongEntry { song_id: number; title: string; ac: number }

// songs 마스터 캐시 (norm(title) → SongEntry[]) — 페이징 fetch + 메모리 보관
let songsCache: Map<string, SongEntry[]> | null = null;
async function getSongsCache(): Promise<Map<string, SongEntry[]>> {
  if (songsCache) return songsCache;
  const byNorm = new Map<string, SongEntry[]>();
  const pageSize = 1000;
  let offset = 0;
  let totalFetched = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/songs?select=song_id,title,ac&order=song_id.asc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`songs fetch HTTP ${res.status}`);
    const rows = (await res.json()) as SongEntry[];
    for (const r of rows) {
      if (!r.title) continue;
      const k = norm(r.title);
      if (!k) continue;
      const entry: SongEntry = { song_id: r.song_id, title: r.title, ac: r.ac };
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
  for (const c of allChartsForScores) {
    if (!isDpSlot(c.slot)) continue;
    if ((c.exScore ?? 0) <= 0) continue; // 미플레이 skip
    const diffInt = DIFF_MAP[c.diff];
    if (diffInt == null) { invalidDiff++; continue; }
    const candidates = songMap.get(norm(c.title));
    const songId = pickSongId(candidates, PLAYED_VERSION_INF);
    if (songId == null) {
      unmatched++;
      if (unmatchedSamples.length < 10) unmatchedSamples.push(c.title);
      continue;
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
