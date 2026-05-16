// Supabase user_profiles upsert — Reflux 데이터 갱신 시마다 무조건 덮어쓰기.
// ohSorry 와 같은 DB / 같은 RPC (upsert_user_profile) 를 사용해서 통합 추적.
//
// 차이점:
//   - iidx_id 형식: ohSorry 는 8자리 숫자 (xxxx-xxxx 의 하이픈 제거),
//                    INFOhSorry 는 "C293036891870" (C + 12자리)
//   - version 필드: 'INFv0.0.9' 등으로 ohSorry / INFOhSorry 구분
//   - series 필드: 'INF' (INFINITAS)
//   - charts_json: INFOhSorry 의 dp12 charts (slot 정보 포함)
//
// fire-and-forget — 실패해도 사용자 경험에 영향 X.
import type { ProfileInfo } from './useProfile';
import type { StarResult } from '../../shared/star-estimator';
import type { RecInputChart } from '../../shared/recommend';

const SUPABASE_URL = 'https://ryesiijulrlmstmhzpnv.supabase.co';
// Legacy JWT anon key (publishable key 는 RLS 호환성 문제로 사용 X) — ohSorry 와 동일
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5ZXNpaWp1bHJsbXN0bWh6cG52Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNzAxNDAsImV4cCI6MjA5Mzc0NjE0MH0.KaKa241XpXbRkdM0C3euyUM3jOX673ijd319HFFFxwA';

export interface UploadInput {
  appVersion: string; // package.json version, e.g. '0.0.9'
  profile: ProfileInfo;
  starResult: StarResult;
  charts: RecInputChart[]; // dp12Match.charts (★11.6~12.7 ereter 매칭된 차트) — lamp 통계 집계 기준
  // 서열표 '미분류' 곡 (ratingData 미등재). charts_json 에만 charts 와 합쳐 올림, lamp 통계엔 미포함.
  unclassifiedCharts?: Omit<RecInputChart, 'level'>[];
  // 선택: ereter 매핑 있으면 함께 (대개 INF ID 는 ereter 에 없어 null)
  ereterStar?: number | null;
}

export async function uploadProfile(input: UploadInput): Promise<{ ok: boolean; error?: string }> {
  const { appVersion, profile, starResult, charts, unclassifiedCharts, ereterStar } = input;

  // iidx_id 정규화 — 하이픈 제거 (게임 메모리에 이미 하이픈 없는 형식이라 그대로지만 안전망)
  const rawId = profile.iidxId;
  if (!rawId) return { ok: false, error: 'iidx_id 없음' };
  const iidxIdNorm = rawId.replace(/-/g, '');

  // ☆12 lamp 통계
  let nPlayedLv12 = 0;
  let nClearedLv12 = 0;
  let hcCount = 0;
  let exhCount = 0;
  let fcCount = 0;
  for (const c of charts) {
    if (c.lampNum > 0) nPlayedLv12++;
    if (c.lampNum >= 3) nClearedLv12++;
    if (c.lampNum >= 5) hcCount++;
    if (c.lampNum >= 6) exhCount++;
    if (c.lampNum === 7) fcCount++;
  }

  const payload = {
    iidx_id: iidxIdNorm,
    dj_name: profile.djName ?? null,
    star_estimate: Number(starResult.star.toFixed(4)),
    ereter_star: ereterStar != null ? Number(ereterStar) : null,
    raw_s: Number(starResult.raw.toFixed(4)),
    version: `INFv${appVersion}`,
    // 단위는 메모리 read 신뢰성 문제로 일단 빈칸 (UI 표시도 제거)
    sp_rank: null,
    dp_rank: null,
    n_cleared: nClearedLv12,
    n_played_lv12: nPlayedLv12,
    fc_count: fcCount,
    hc_count: hcCount,
    exh_count: exhCount,
    level_filter: 'lv12',
    series: 'INF',
    // tsv lv11/12 전곡 등재 — m.charts (ratingData∩tsv, zasa≤12.7) + m.unclassifiedCharts (tsv \ ratingData)
    // 의 union = tsvIdx 전체. 게스트 서열표가 zasaLevel > 12.7 곡 / ratingData 미등재 신곡까지 표시 가능.
    // lamp 통계 (n_played_lv12 등) 는 위 집계 그대로 — m.charts 만 ★ 추정 풀.
    charts_json: [...charts, ...(unclassifiedCharts ?? [])],
  };
  const isDpSlot = (slot: unknown): boolean => (
    slot === 'DPN' || slot === 'DPH' || slot === 'DPA' || slot === 'DPL'
  );
  const scoreDate = new Date().toISOString();
  const chartScoreRowsRaw = payload.charts_json.filter((c) => isDpSlot(c.slot) && (c.exScore ?? 0) > 0).map((c) => ({
    played_version: 'INF',
    level: 'level' in c && typeof c.level === 'number' ? c.level : (c.zasaLevel ?? c.ereterLevel ?? null),
    title: c.title,
    iidx_id: iidxIdNorm,
    dj_name: profile.djName ?? null,
    diff: c.diff,
    game_level: c.gameLevel ?? null,
    dj_level: c.djLevel ?? null,
    ex_score: c.exScore ?? null,
    date: scoreDate,
  }));
  const chartScoreRows = Array.from(chartScoreRowsRaw.reduce((m, r) => {
    const key = `${r.played_version}|${r.iidx_id}|${r.title}|${r.diff}`;
    const prev = m.get(key);
    if (!prev || (r.ex_score ?? 0) > (prev.ex_score ?? 0)) m.set(key, r);
    return m;
  }, new Map()).values());

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_user_profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ p: payload }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${errText}` };
    }
    const chartRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_user_chart_scores`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ p_rows: chartScoreRows }),
    });
    if (!chartRes.ok) {
      const errText = await chartRes.text().catch(() => '');
      return { ok: false, error: `chart scores HTTP ${chartRes.status} ${errText}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
