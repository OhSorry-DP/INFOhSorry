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
import type { StarResult, SongChart } from '../../shared/types';
import type { RecInputChart } from '../../shared/recommend';
import { norm, slotToDiff } from '../../shared/match';

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
async function getSongsCache(): Promise<Map<string, SongEntry[]>> {
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
  starResult: StarResult | null; // null = ★ 미산출 (SP 전용·DP 저레벨 전용 유저) → users.star = null
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
}

export async function uploadProfile(input: UploadInput): Promise<{ ok: boolean; error?: string }> {
  const { appVersion, profile, starResult, charts, unclassifiedCharts, ereterStar, spCpi, spStar } = input;

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
  //   SP 대표 실력값: 표본부족/미산출이면 null → RPC COALESCE 가 기존 sp_cpi/sp_star 보존(절대 덮어 0 안 함).
  const spCpiVal = (typeof spCpi === 'number' && isFinite(spCpi)) ? Math.round(spCpi) : null;
  const spStarVal = (typeof spStar === 'number' && isFinite(spStar)) ? Number(spStar.toFixed(1)) : null;
  try {
    console.log(`[supabase] users upsert 시도 ${iidxIdNorm} — DP★=${starResult ? starResult.star.toFixed(2) : 'null'} / SP sp_cpi=${spCpiVal ?? 'null(보존)'} sp_star=${spStarVal ?? 'null(보존)'}`);
    const userRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_user`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        p_iidx_id: iidxIdNorm,
        p_dj_name: profile.djName ?? null,
        p_star: starResult ? Number(starResult.star.toFixed(4)) : null,
        p_ereter_star: ereterStar != null ? Number(ereterStar) : null,
        // SP/DP 단위는 절대 업셋하지 않음 — null 보내 RPC COALESCE 가 기존 값 유지.
        // 단위 채우는 책임: ohSorryAdmin/getInfRadar.js (eagate djdata 페이지에서 fetch).
        // INFOhSorry 메모리 리딩에서 단위가 안 잡혀도 supabase 저장값을 fetchUserPublic 으로 받아 ProfileCard 에 표시.
        p_sp_rank: null,
        p_dp_rank: null,
        p_sp_cpi: spCpiVal,    // SP 대표 실력값(CPI). null → COALESCE 보존
        p_sp_star: spStarVal,  // 発狂★相当. null → COALESCE 보존
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
      play_style: 1,   // DP
      date: scoreDate,
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
  // SP 차트 — gameLevel 10~12 만 play_style:0 으로 (song_id 는 곡 단위라 DP 와 공유. songs 미등록 신곡은 skip).
  let spUnmatched = 0;
  let spCount = 0;
  for (const c of (input.spCharts ?? [])) {
    if (c.level < 10 || c.level > 12) continue;
    if ((c.exScore ?? 0) <= 0) continue;  // 미플레이 skip
    const diffInt = DIFF_MAP[slotToDiff(c.slot)];
    if (diffInt == null) continue;
    const songId = pickSongId(songMap.get(norm(c.title)), PLAYED_VERSION_INF);
    if (songId == null) { spUnmatched++; continue; }
    const lampInt = c.lamp != null && LAMP_MAP[c.lamp] != null ? LAMP_MAP[c.lamp] : null;
    const exScore = c.exScore != null ? Number(c.exScore) : null;
    const newRow: ScoreRow = {
      song_id: songId, iidx_id: iidxIdNorm, diff: diffInt, lamp: lampInt,
      ex_score: exScore, played_version: PLAYED_VERSION_INF, play_style: 0, date: scoreDate,
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
  if (spCount > 0) console.log(`[supabaseSync] SP10~12 scores: ${spCount}건 (play_style:0)`);

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

// ─── Recent 탭 RPC (ohSorryWeb modules/api.js 의 호출 형식 그대로 옮김) ─────────────
//
// 두 RPC + 한 가지 dedup-latest helper:
//   1) fetchRecentDates(id)            → [{ date_kst, row_count }, ...] desc
//   2) fetchRecentCharts(id, dateKst)  → 그날의 raw chart entry 들 (prev/now 포함)
//   3) fetchUserLatestCharts(id)       → make_grid_data 의 dedup row → (norm(title)+'|'+diffStr) 인덱스
//      "당일" 박스에서 TSV row 와 비교할 supabase 마지막 row 들.
//
// make_recent_data 가 LATERAL prev row 까지 같이 반환 — UI 가 prev → now diff 표기에 그대로 사용.

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
export async function fetchRecentDates(iidxId: string, dbrOnly = false): Promise<{ date_kst: string; row_count: number }[]> {
  const id = String(iidxId || '').trim().replace(/-/g, '');
  if (!id) return [];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/make_recent_dates`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ p_iidx_id: id, p_dbr: !!dbrOnly }),
  });
  if (!res.ok) throw new Error(`Recent 날짜 조회 실패 (HTTP ${res.status})`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// DBR 난이도 맵 — dbr-inf-recommend.json(gist) 에서 textageid|diff → dbrLevel 로드 (1회 캐시).
//   DBR 모드 RECENT 의 레벨 칸/곡명 앞에 DBR 난이도 표시 + 정렬에 사용. 실패 시 빈 맵(graceful).
const DBR_RECOMMEND_URL = 'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw/dbr-inf-recommend.json';
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

export async function fetchRecentCharts(iidxId: string, dateKst: string): Promise<RecentChartRow[]> {
  const id = String(iidxId || '').trim().replace(/-/g, '');
  if (!id || !dateKst) return [];
  const [rowsRes, textageMeta] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/rpc/make_recent_data`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ p_iidx_id: id, p_date_kst: dateKst }),
    }),
    getTextageMeta().catch(() => null),
  ]);
  if (!rowsRes.ok) throw new Error(`Recent 데이터 조회 실패 (HTTP ${rowsRes.status})`);
  const rows = await rowsRes.json();
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => viewRowToRecent(r, textageMeta));
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
  const out: Array<{ title: string; diff: number; lamp: number; ex_score: number; played_version?: number; textage_song_id?: string | null }> = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/rpc/make_grid_data?limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ p_iidx_id: id }),
    });
    if (!res.ok) throw new Error(`grid data 조회 실패 (HTTP ${res.status})`);
    const rows = await res.json();
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
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
