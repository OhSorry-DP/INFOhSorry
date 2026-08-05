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

const GIST_OFFSETS_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw/offsets.json';

export interface RemoteProfileEntry {
  offset: string; // bigint string (modBase 기준)
  encoding: string; // 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'
  maxBytes: number;
}
// profile 필드는 null 가능 — "이 빌드에서는 그 주소를 아직 모른다" 는 뜻.
//   생략(키 없음)과 구분한다: null 이면 옛 빌드 상수로 fallback 하지 않고 읽기를 건너뛴다.
export type RemoteProfileMap = Record<string, RemoteProfileEntry | null>;

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

// gist 에서 offsets.json fetch. 성공 시 캐시 갱신 후 반환, 실패 시 이전 캐시(or null).
export async function getRemoteOffsets(force = false): Promise<RemoteOffsets | null> {
  if (_cache && !force) return _cache;
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
  }
}

// 실행 중인 게임에 맞는 build 를 고른다.
//   1. builds 가 없으면(v1 gist) 최상위 필드를 build 로 감싸 반환 — legacy
//   2. 게임 datecode 를 읽어 version 이 같은 build 를 찾으면 그것 — matched
//   3. datecode 는 읽었는데 일치 항목이 없으면 builds[0](최신) — latest (경고 대상)
//   4. datecode 를 못 읽으면 builds[0] — blind
export async function resolveBuild(): Promise<ResolvedBuild | null> {
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

  const datecode = getGameDatecode();
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
export async function getRemoteProfileOffsets(): Promise<{
  profile: RemoteProfileMap | null;
  buildVersion: string | null;
  confidence: BuildConfidence | null;
} | null> {
  const r = await resolveBuild();
  if (!r) return null;
  return {
    profile: r.build.profile ?? null,
    buildVersion: r.build.version ?? null,
    confidence: r.confidence,
  };
}
