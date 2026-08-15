// 원격모드(LAN 로컬보드) — INF 로컬 데이터를 오소리웹 user 객체(별값 + charts_json)로 변환.
//   http-server 의 GET /api/me 가 이 객체를 노출 → 오소리웹 fetchUserProfile 의 원격 분기(?remote)가
//   supabase 대신 읽는다. 필드 매핑은 ohSorryWeb/modules/api.js 의 fetchUserProfile / viewRowToChart
//   반환 형식과 1:1 (어긋나면 카드가 안 그려짐).
import type { SongChart, SpTierData, StarResult } from '../../shared/types';
import type { RecInputChart } from '../../shared/recommend';
import { lampNum, slotToDiff, norm } from '../../shared/match';

// title(raw) → textage_song_id 매핑. 라이벌 비교 머지 키(__textageSongId) 안정화용 — supabaseSync 의
//   getTextageByTitle 과 동일 norm 키. 없으면(미로딩/미매칭) null → 머지 키가 song_id/title fallback.
type TxMap = Map<string, string> | null | undefined;
const txIdOf = (title: string, txMap: TxMap): string | null =>
  (txMap ? (txMap.get(norm(title)) ?? null) : null);

// 노트레이더 6지표 (useProfile 이 INFINITAS 메모리에서 읽은 값).
interface RadarLike {
  notes: number | null;
  chord: number | null;
  peak: number | null;
  charge: number | null;
  scratch: number | null;
  soft: number | null;
}

interface RemoteProfile {
  iidxId: string | null;
  djName: string | null;
  // v0.0.108+ — 메모리에서 읽은 노트레이더 / 단위. ProfileInfo 가 그대로 들어온다(구조적 호환).
  spRadar?: RadarLike | null;
  dpRadar?: RadarLike | null;
  spRank?: string | null;   // 표기 문자열 ('十段' 등). 미취득/미확인은 null → '-' 로 내보냄
  dpRank?: string | null;
}

// 오소리웹 notes_radar 형식 — 대문자 키 + total(6지표 합).
//   modules/api.js 의 radarOut 과 1:1 (supabase 경로가 user_radars 로 만드는 것과 같은 모양이어야
//   원격/서버 어느 쪽이든 카드가 같은 코드로 그려진다). total 컬럼은 DB 에도 없어서 합으로 만든다.
function toWebRadar(r: RadarLike | null | undefined): Record<string, number> | null {
  if (!r) return null;
  const v = (x: number | null | undefined): number =>
    typeof x === 'number' && Number.isFinite(x) ? x : 0;
  const out: Record<string, number> = {
    NOTES: v(r.notes),
    PEAK: v(r.peak),
    CHARGE: v(r.charge),
    CHORD: v(r.chord),
    SCRATCH: v(r.scratch),
    'SOF-LAN': v(r.soft),
  };
  // 부동소수 오차 정리 (747.0699999999999 → 747.07) — 카드가 그대로 표시할 수 있게.
  out.total = Number(
    (out.NOTES + out.PEAK + out.CHARGE + out.CHORD + out.SCRATCH + out['SOF-LAN']).toFixed(2),
  );
  return out;
}

// unclassifiedCharts 는 level 이 빠진 RecInputChart — 공통 타입으로 받아 charts 와 함께 변환.
type ChartLike = Omit<RecInputChart, 'level'> & { level?: number | null };

// RecInputChart → 오소리웹 charts_json 항목 (viewRowToChart 형식).
function toChartJson(c: ChartLike, txMap?: TxMap): unknown {
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
    __textageSongId: txIdOf(c.title, txMap),   // 라이벌 비교 머지 키 안정화 (라이벌 supabase 도 textage_song_id 보유)
  };
}

// SongChart(SP TSV 추출) → 오소리웹 charts_json 항목. DP charts_json 과 동일 형식 + playStyle:'SP'.
//   소스 비종속 설계 — 나중에 오소리본체가 supabase 에 SP 를 실으면 같은 형식이 그대로 재사용됨.
//   SP 는 별값/zasa 매칭이 없어 level/zasaLevel/ereterLevel 은 null (PlayData 는 gameLevel 로 그림).
function spChartToJson(c: SongChart, txMap?: TxMap): unknown {
  const diff = slotToDiff(c.slot);
  return {
    title: c.title,
    diff,
    slot: c.slot,
    playStyle: 'SP',
    lamp: c.lamp,
    lampNum: lampNum(c.lamp),
    exScore: typeof c.exScore === 'number' ? c.exScore : 0,
    prevLamp: null,
    prevExScore: null,
    prevPlayedVersion: null,
    djLevel: c.letter || null,
    prevDjLevel: null,
    gameLevel: typeof c.level === 'number' ? c.level : null,
    level: null,
    zasaLevel: null,
    ereterLevel: c.ereterLevel ?? null,
    pgreat: null,
    great: null,
    missCount: typeof c.missCount === 'number' ? c.missCount : null,
    noteCount: typeof c.noteCount === 'number' ? c.noteCount : null,
    unlocked: c.unlocked ?? true,
    date: null,
    __songId: null,
    __playedVersion: 0,
    __textageSongId: txIdOf(c.title, txMap),   // 라이벌 비교 머지 키 안정화 (SP 도 동일)
  };
}

// INF 로컬 값(profile + 별값 + 분류/미분류 charts) → 오소리웹 user 객체.
//   notes_radar / sp_rank / dp_rank 는 v0.0.108+ 부터 INFINITAS 메모리 값으로 채운다(그 전엔 null).
//   os_pattern_score 는 여전히 null — 카드 내부 calcWeakness 가 charts_json 으로 패턴을 보강한다.
//   BP / 노트수는 charts_json 각 항목의 missCount / noteCount 로 이미 나간다(웹 shelf.js 가 그 키를 읽음).
//   spCharts / spTier12 는 원격모드 SP 표시용 (소스 비종속 — 추후 DB 백필 시 같은 필드 재사용).
export function buildRemoteUser(
  profile: RemoteProfile,
  starResult: StarResult,
  charts: RecInputChart[],
  unclassified: Array<Omit<RecInputChart, 'level'>>,
  spCharts?: SongChart[],
  spTier12?: SpTierData | null,
  spStar?: { cpiInt: number | null; starRounded: number | null } | null,
  textageByTitle?: TxMap,   // title(raw)→textage_song_id (라이벌 비교 머지 키). 미로딩이면 undefined→__textageSongId null
): unknown {
  const allCharts: ChartLike[] = [...charts, ...unclassified];
  return {
    iidx_id: profile.iidxId,
    dj_name: profile.djName,
    star_estimate: typeof starResult.star === 'number' ? starResult.star : null,
    native_star: typeof starResult.nativeStar === 'number' ? starResult.nativeStar : null,
    ereter_star: typeof starResult.star === 'number' ? starResult.star : null,
    // SP 발광★ — 오소리웹 ?remote SP 모드 카드/서열표 헤더·목록 별값용(없으면 null).
    sp_cpi: spStar && typeof spStar.cpiInt === 'number' ? spStar.cpiInt : null,
    sp_star: spStar && typeof spStar.starRounded === 'number' ? spStar.starRounded : null,
    // 단위 — 오소리웹은 supabase 경로에서 rankIntToStr 로 이미 문자열('十段' / 미취득 '-')을 넣어 보낸다.
    //   원격도 같은 모양이어야 카드가 분기 없이 그린다.
    sp_rank: profile.spRank ?? '-',
    dp_rank: profile.dpRank ?? '-',
    series: 'INF',
    played_version: 0,
    charts_json: allCharts.map((c) => toChartJson(c, textageByTitle)),
    // SP — 친 모든 SP 채보(전 레벨/시리즈) + SP12 서열표. 오소리웹이 ?remote 에서 SP 모드로 표시.
    sp_charts_json: Array.isArray(spCharts) ? spCharts.map((c) => spChartToJson(c, textageByTitle)) : [],
    sp_tier12: spTier12 ?? null,
    // 노트레이더 — 메모리에서 읽은 SP/DP. 없으면 null (카드가 레이더 영역을 접는다).
    notes_radar: { sp: toWebRadar(profile.spRadar), dp: toWebRadar(profile.dpRadar) },
    os_pattern_score: null,
    _ratingData: null,
  };
}
