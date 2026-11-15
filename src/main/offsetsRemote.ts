// gist offsets.json (Reflux offsets + 프로필 메모리 offset) fetch + 캐시 + 빌드별 선택.
//
// INFINITAS 패치로 메모리 offset 이 이동하면, 이 gist 의 offsets.json 한 파일만 갱신하면
// 앱이 다음 실행 때 자동 반영한다 (재빌드/재배포 불필요).
//   - reflux: Reflux offsets.txt 절대주소 → reflux.ts 의 ensureOffsetsFile 이 사용
//   - profile: bm2dx.exe modBase 기준 상대 offset → useProfile(renderer) 이 기본값으로 사용
// fetch 실패(오프라인/gist 다운) 시: reflux 는 코드 번들, profile 은 profileOffsets.ts 상수로 fallback.
//
// 스키마 v2 — 빌드별 분기:
//   최상위 version/reflux/profile 은 구버전 앱 호환용 미러(= builds[0]).
//   builds[] 는 게임 빌드별 offset 이고, 실행 중인 게임의 datecode 와 version 을 맞춰 고른다.
//   ※ 최상위를 배열로 바꾸면 구버전 앱이 파일 전체를 거부한다(version 문자열 검사) — 유지할 것.
import { getGameDatecode, datecodeNum } from './gameBuild';
import { PROFILE_OFFSETS, PROFILE_NUMERIC_OFFSETS } from '../shared/profileOffsets';

const GIST_OFFSETS_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/b586710a7a6efc3a245da2c85db8d1f2/raw/offsets.json';

// profile 맵 항목 = 문자열 offset({offset, encoding, maxBytes}) 또는 숫자 offset({offset, count, scale}).
//   djName/iidxId 는 전자, radar/dan 은 후자. 값이 null 이면 "이 빌드에서는 그 주소를 아직 모른다" 는 뜻이고,
//   생략(키 없음)과 구분한다 — null 이면 옛 빌드 상수로 fallback 하지 않고 읽기를 건너뛴다.
//   타입 정의는 renderer(useProfile)도 함께 쓰므로 shared 에 있다.
export type {
  RemoteProfileEntry,
  RemoteProfileMap,
  RemoteStringOffset,
  RemoteNumericOffset,
} from '../shared/profileOffsets';
import type { RemoteProfileMap } from '../shared/profileOffsets';

export interface RemoteBuild {
  version: string; // 'P2D:J:B:A:YYYYMMDDxx'
  note?: string;
  reflux?: Record<string, string>;
  profile?: RemoteProfileMap;
}
export interface RemoteOffsets {
  schema?: number;
  version: string; // 최상위 미러 (구버전 앱 호환)
  reflux?: Record<string, string>;
  profile?: RemoteProfileMap;
  builds?: RemoteBuild[]; // v2. builds[0] = 최신
}

// 어떤 근거로 이 build 를 골랐는지 — UI/로그가 경고를 띄울 수 있게 남긴다.
export type BuildConfidence =
  | 'matched' // 게임 datecode 와 일치하는 build 를 찾음
  | 'latest' // datecode 는 읽었으나 일치 항목 없음 → builds[0] 낙관 사용
  | 'blind' // datecode 자체를 못 읽음(게임 미실행 등) → builds[0]
  | 'legacy'; // builds 가 없는 v1 gist → 최상위 필드 사용

export interface ResolvedBuild {
  build: RemoteBuild;
  confidence: BuildConfidence;
  gameDatecode: string | null;
}

let _cache: RemoteOffsets | null = null;
let _request: Promise<RemoteOffsets | null> | null = null;
let _requestSettled = false;

export interface PlayLoggerLayout {
  log: { markerScanFromJudge: number; markerDelta: number; settingsStateDelta: number; p2SettingsDelta: number; battleFlagDelta: number; gaugeWordP1: number; gaugeWordP2: number; playSpeedFromSettings: number; laneOrderP1FromSettings: number; laneOrderP2FromSettings: number; songStride: number; songIdOffset: number; songNoteOffset: number };
  detail: { laneWordsP1: number; laneWordsP2: number };
}
export type PlayLoggerSelection =
  | { state: 'waiting' }
  | { state: 'blocked'; build: string | null; issues: string[]; unknownKeys: string[] }
  | { state: 'ready'; build: string | null; layout: PlayLoggerLayout; applied: string[]; defaults: { key: string; reason: 'remote-unavailable' | 'build-not-found' | 'key-omitted' | 'version-unavailable' }[]; unknownKeys: string[]; timedOut: boolean };

const PLAYLOGGER_DEFAULTS: PlayLoggerLayout = {
  log: { markerScanFromJudge: 144, markerDelta: 24, settingsStateDelta: 0x18, p2SettingsDelta: 0x48, battleFlagDelta: 0x28, gaugeWordP1: 77, gaugeWordP2: 78, playSpeedFromSettings: 0x17a0, laneOrderP1FromSettings: 0x37cc, laneOrderP2FromSettings: 0x37ec, songStride: 0x730, songIdOffset: 0x5b0, songNoteOffset: 0x370 },
  detail: { laneWordsP1: 3448385, laneWordsP2: 3452299 },
};
const PLAYLOGGER_KEYS: Record<keyof PlayLoggerLayout, string[]> = {
  log: Object.keys(PLAYLOGGER_DEFAULTS.log), detail: Object.keys(PLAYLOGGER_DEFAULTS.detail),
};
const PLAYLOGGER_WORD_KEYS = new Set(['log.gaugeWordP1', 'log.gaugeWordP2', 'detail.laneWordsP1', 'detail.laneWordsP2']);

export function startPlayLoggerOffsetsPreparation(): void {
  void getRemoteOffsets();
}

export function selectPlayLoggerLayout(gameVersion: string, startedAt: number, now: number): PlayLoggerSelection {
  const timedOut = now - startedAt >= 1000;
  if (!_cache && !_requestSettled && _request && !timedOut) return { state: 'waiting' };
  const versionNum = datecodeNum(gameVersion);
  if (!_cache) return defaultsOnly('remote-unavailable', null, timedOut);
  if (!versionNum) return defaultsOnly('version-unavailable', null, false);
  const builds = Array.isArray(_cache.builds) ? _cache.builds : [];
  const build = builds.find((candidate) => candidate && datecodeNum(candidate.version) === versionNum);
  if (!build) return defaultsOnly('build-not-found', null, false);
  const raw = (build as RemoteBuild & { playLogger?: unknown }).playLogger;
  if (raw === null) return { state: 'blocked', build: build.version, issues: ['playLogger:null'], unknownKeys: [] };
  if (raw === undefined) return defaultsOnly('key-omitted', build.version, false);
  if (typeof raw !== 'object' || Array.isArray(raw)) return { state: 'blocked', build: build.version, issues: ['playLogger:type'], unknownKeys: [] };
  const unknownKeys: string[] = [];
  const issues: string[] = [];
  const applied: string[] = [];
  const defaults: { key: string; reason: 'remote-unavailable' | 'build-not-found' | 'key-omitted' | 'version-unavailable' }[] = [];
  const layout = structuredClone(PLAYLOGGER_DEFAULTS);
  for (const group of Object.keys(raw as object)) if (!(group in PLAYLOGGER_KEYS)) unknownKeys.push(`playLogger.${group}`);
  for (const group of ['log', 'detail'] as const) {
    const groupValue = (raw as Record<string, unknown>)[group];
    if (groupValue === null) { issues.push(`playLogger.${group}:null`); continue; }
    if (groupValue === undefined) {
      for (const key of PLAYLOGGER_KEYS[group]) defaults.push({ key: `${group}.${key}`, reason: 'key-omitted' });
      continue;
    }
    if (typeof groupValue !== 'object' || Array.isArray(groupValue)) { issues.push(`playLogger.${group}:type`); continue; }
    const obj = groupValue as Record<string, unknown>;
    for (const key of Object.keys(obj)) if (!PLAYLOGGER_KEYS[group].includes(key)) unknownKeys.push(`playLogger.${group}.${key}`);
    for (const key of PLAYLOGGER_KEYS[group]) {
      const path = `${group}.${key}`;
      const value = obj[key];
      if (value === undefined) { defaults.push({ key: path, reason: 'key-omitted' }); continue; }
      if (value === null) { issues.push(`${path}:null`); continue; }
      const word = PLAYLOGGER_WORD_KEYS.has(path);
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff || (word && value > Math.floor(0x7fffffff / 4))) { issues.push(`${path}:range`); continue; }
      if (!word && path !== 'log.songStride' && value % 4 !== 0) { issues.push(`${path}:alignment`); continue; }
      (layout[group] as Record<string, number>)[key] = value;
      applied.push(`${path}=${value}`);
    }
  }
  const l = layout.log;
  const check = (condition: boolean, issue: string) => { if (!condition) issues.push(issue); };
  check(l.songStride > 0 && l.songStride % 4 === 0, 'log.songStride:stride');
  check(0x100 <= l.songStride && l.songIdOffset + 4 <= l.songStride && l.songNoteOffset + 40 <= l.songStride, 'log.songStride:fields');
  check(2600 * l.songStride <= 0x7fffffff, 'log.songStride:capacity');
  check(l.battleFlagDelta / 4 < 11, 'log.battleFlagDelta:range');
  check(l.gaugeWordP2 === l.gaugeWordP1 + 1, 'log.gaugeWordP2:pair');
  check(l.markerScanFromJudge + l.markerDelta + 96 <= 0x7fffffff, 'log.markerDelta:range');
  const d = layout.detail;
  check(d.laneWordsP1 + 48 <= d.laneWordsP2 || d.laneWordsP2 + 48 <= d.laneWordsP1, 'detail.laneWords:overlap');
  check(Math.max(d.laneWordsP1, d.laneWordsP2) + 48 <= Math.floor(0x7fffffff / 4), 'detail.laneWords:range');
  if (issues.length) return { state: 'blocked', build: build.version, issues, unknownKeys };
  return { state: 'ready', build: build.version, layout, applied, defaults, unknownKeys, timedOut: false };
}

function defaultsOnly(reason: 'remote-unavailable' | 'build-not-found' | 'key-omitted' | 'version-unavailable', build: string | null, timedOut: boolean): PlayLoggerSelection {
  const defaults = Object.entries(PLAYLOGGER_DEFAULTS).flatMap(([group, values]) => Object.keys(values).map((key) => ({ key: `${group}.${key}`, reason })));
  return { state: 'ready', build, layout: structuredClone(PLAYLOGGER_DEFAULTS), applied: [], defaults, unknownKeys: [], timedOut };
}

// gist 에서 offsets.json fetch. 성공 시 캐시 갱신 후 반환, 실패 시 이전 캐시(or null).
export async function getRemoteOffsets(force = false): Promise<RemoteOffsets | null> {
  if (_cache && !force) return _cache;
  if (_request && !force) return _request;
  _requestSettled = false;
  const pending = (async (): Promise<RemoteOffsets | null> => {
  try {
    const res = await fetch(`${GIST_OFFSETS_URL}?t=${Date.now()}`, {
      headers: { 'User-Agent': 'INFOhSorry (+https://github.com/yenkara/INFOhSorry)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as RemoteOffsets;
    if (j && typeof j === 'object' && typeof j.version === 'string') {
      _cache = j;
      return _cache;
    }
    throw new Error('형식 불일치 (version 없음)');
  } catch (e) {
    console.warn('[offsets] gist offsets.json fetch 실패:', (e as Error).message);
    return _cache;
  } finally {
    _requestSettled = true;
    _request = null;
  }
  })();
  _request = pending;
  return pending;
}

// 실행 중인 게임에 맞는 build 를 고른다.
//   1. builds 가 없으면(v1 gist) 최상위 필드를 build 로 감싸 반환 — legacy
//   2. 게임 datecode 를 읽어 version 이 같은 build 를 찾으면 그것 — matched
//   3. datecode 는 읽었는데 일치 항목이 없으면 builds[0](최신) — latest (경고 대상)
//   4. datecode 를 못 읽으면 builds[0] — blind
export async function resolveBuild(gameDatecode?: string | null): Promise<ResolvedBuild | null> {
  const remote = await getRemoteOffsets();
  if (!remote) return null;

  const builds = Array.isArray(remote.builds) ? remote.builds.filter((b) => b && b.version) : [];
  if (builds.length === 0) {
    return {
      build: { version: remote.version, reflux: remote.reflux, profile: remote.profile },
      confidence: 'legacy',
      gameDatecode: null,
    };
  }

  const datecode = gameDatecode === undefined ? getGameDatecode() : gameDatecode;
  if (!datecode) return { build: builds[0], confidence: 'blind', gameDatecode: null };

  // datecode 비교는 끝 10자리 숫자로 — 접두사 표기가 달라도 같은 빌드면 매칭되게.
  const want = datecodeNum(datecode);
  const hit = builds.find((b) => datecodeNum(b.version) === want);
  if (hit) return { build: hit, confidence: 'matched', gameDatecode: datecode };

  console.warn(
    `[offsets] 게임 빌드 ${datecode} 에 맞는 항목이 gist 에 없음 — 최신(${builds[0].version}) 으로 진행. offset 이 틀릴 수 있음.`,
  );
  return { build: builds[0], confidence: 'latest', gameDatecode: datecode };
}

// renderer(useProfile) 가 IPC 로 받는 프로필 offset — 매칭된 build 의 profile. 없으면 null.
//   반환에 buildVersion 을 함께 실어, 저장된 스캔 결과가 다른 빌드 것인지 renderer 가 판별한다.
export interface RemoteProfileSession { pid: number | null; generation: number }
export async function getRemoteProfileOffsets(
  session: RemoteProfileSession = { pid: null, generation: 0 },
  gameDatecode?: string | null,
): Promise<{
  profile: RemoteProfileMap | null;
  buildVersion: string | null;
  confidence: BuildConfidence | null;
  profilePolicy: 'normal' | 'constants-only' | 'blocked';
  session: RemoteProfileSession;
  gameDatecode: string | null;
} | null> {
  const r = await resolveBuild(gameDatecode);
  if (!r) {
    // 인자 없는 기존 호출은 getGameDatecode() 기반 동작과 동일하게 null을 유지한다.
    if (gameDatecode === undefined) return null;
    const sessionValid = session !== null && Number.isSafeInteger(session.pid) && (session.pid as number) > 0
      && Number.isSafeInteger(session.generation) && session.generation > 0;
    let profile: RemoteProfileMap | null = null;
    let profilePolicy: 'normal' | 'constants-only' | 'blocked' = 'normal';
    if (!sessionValid) {
      profilePolicy = 'blocked';
      profile = { iidxId: null, djName: null, radar: null, dan: null, spRank: null, dpRank: null };
    } else if (gameDatecode !== null) {
      const measuredBuild = datecodeNum(gameDatecode);
      const constantsBuild = datecodeNum(PROFILE_OFFSETS.refluxVersion);
      if (measuredBuild !== 0 && constantsBuild !== 0 && measuredBuild === constantsBuild) {
        profilePolicy = 'constants-only';
        profile = {
          iidxId: PROFILE_OFFSETS.iidxId,
          djName: PROFILE_OFFSETS.djName,
          radar: PROFILE_NUMERIC_OFFSETS.radar ?? null,
          dan: PROFILE_NUMERIC_OFFSETS.dan ?? null,
          spRank: null,
          dpRank: null,
        };
      } else {
        profilePolicy = 'blocked';
        profile = { iidxId: null, djName: null, radar: null, dan: null, spRank: null, dpRank: null };
      }
    }
    return { profile, buildVersion: null, confidence: null, profilePolicy, session, gameDatecode };
  }
  let profile: RemoteProfileMap | null = r.build.profile ?? null;
  let profilePolicy: 'normal' | 'constants-only' | 'blocked' = 'normal';
  const sessionValid = session !== null && Number.isSafeInteger(session.pid) && (session.pid as number) > 0
    && Number.isSafeInteger(session.generation) && session.generation > 0;
  if (r.confidence === 'latest') {
    const measuredBuild = r.gameDatecode ? datecodeNum(r.gameDatecode) : null;
    const constantsBuild = datecodeNum(PROFILE_OFFSETS.refluxVersion);
    if (sessionValid && measuredBuild && constantsBuild && measuredBuild === constantsBuild) {
      profilePolicy = 'constants-only';
      profile = {
        iidxId: PROFILE_OFFSETS.iidxId,
        djName: PROFILE_OFFSETS.djName,
        radar: PROFILE_NUMERIC_OFFSETS.radar ?? null,
        dan: PROFILE_NUMERIC_OFFSETS.dan ?? null,
        spRank: null,
        dpRank: null,
      };
    } else {
      profilePolicy = 'blocked';
      profile = { iidxId: null, djName: null, radar: null, dan: null, spRank: null, dpRank: null };
    }
  }
  return {
    profile,
    buildVersion: r.build.version ?? null,
    confidence: r.confidence,
    profilePolicy,
    session,
    gameDatecode: r.gameDatecode,
  };
}
