// 원격모드(LAN 로컬보드) — INF 로컬 데이터를 오소리웹 user 객체(별값 + charts_json)로 변환.
//   http-server 의 GET /api/me 가 이 객체를 노출 → 오소리웹 fetchUserProfile 의 원격 분기(?remote)가
//   supabase 대신 읽는다. 필드 매핑은 ohSorryWeb/modules/api.js 의 fetchUserProfile / viewRowToChart
//   반환 형식과 1:1 (어긋나면 카드가 안 그려짐).
import type { StarResult } from '../../shared/types';
import type { RecInputChart } from '../../shared/recommend';

interface RemoteProfile {
  iidxId: string | null;
  djName: string | null;
}

// unclassifiedCharts 는 level 이 빠진 RecInputChart — 공통 타입으로 받아 charts 와 함께 변환.
type ChartLike = Omit<RecInputChart, 'level'> & { level?: number | null };

// RecInputChart → 오소리웹 charts_json 항목 (viewRowToChart 형식).
function toChartJson(c: ChartLike): unknown {
  return {
    title: c.title,
    diff: c.diff,
    slot: c.slot,
    lamp: c.lamp,
    lampNum: c.lampNum,
    exScore: typeof c.exScore === 'number' ? c.exScore : 0,
    prevLamp: null,
    prevExScore: null,
    prevPlayedVersion: null,
    djLevel: c.djLevel ?? null,
    prevDjLevel: null,
    gameLevel: c.gameLevel ?? null,
    level: c.level ?? c.zasaLevel ?? null,
    zasaLevel: c.zasaLevel ?? null,
    ereterLevel: c.ereterLevel ?? null,
    pgreat: null,
    great: null,
    missCount: c.missCount ?? null,
    noteCount: c.noteCount ?? null,
    unlocked: c.unlocked ?? true,
    date: null,
    __songId: null,
    __playedVersion: 0,
    __textageSongId: null,
  };
}

// INF 로컬 값(profile + 별값 + 분류/미분류 charts) → 오소리웹 user 객체.
//   notes_radar / os_pattern_score 는 옵션(null) — 카드 내부 calcWeakness 가 charts_json 으로 패턴 보강.
export function buildRemoteUser(
  profile: RemoteProfile,
  starResult: StarResult,
  charts: RecInputChart[],
  unclassified: Array<Omit<RecInputChart, 'level'>>,
): unknown {
  const allCharts: ChartLike[] = [...charts, ...unclassified];
  return {
    iidx_id: profile.iidxId,
    dj_name: profile.djName,
    star_estimate: typeof starResult.star === 'number' ? starResult.star : null,
    native_star: typeof starResult.nativeStar === 'number' ? starResult.nativeStar : null,
    ereter_star: typeof starResult.star === 'number' ? starResult.star : null,
    sp_rank: null,
    dp_rank: null,
    series: 'INF',
    played_version: 0,
    charts_json: allCharts.map(toChartJson),
    notes_radar: null,
    os_pattern_score: null,
    _ratingData: null,
  };
}
