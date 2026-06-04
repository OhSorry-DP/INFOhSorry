// gist offsets.json (Reflux offsets + 프로필 메모리 offset) fetch + 캐시.
//
// INFINITAS 패치로 메모리 offset 이 이동하면, 이 gist 의 offsets.json 한 파일만 갱신하면
// 앱이 다음 실행 때 자동 반영한다 (재빌드/재배포 불필요).
//   - reflux: Reflux offsets.txt 절대주소 → reflux.ts 의 ensureOffsetsFile 이 버전비교 후보로 사용
//   - profile: bm2dx.exe modBase 기준 상대 offset → useProfile(renderer) 이 기본값으로 사용
// fetch 실패(오프라인/gist 다운) 시: reflux 는 코드 번들, profile 은 profileOffsets.ts 상수로 fallback.

const GIST_OFFSETS_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw/offsets.json';

export interface RemoteProfileEntry {
  offset: string; // bigint string (modBase 기준)
  encoding: string; // 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'
  maxBytes: number;
}
export interface RemoteOffsets {
  version: string; // 'P2D:J:B:A:YYYYMMDDxx' — 끝 10자리가 클수록 최신
  reflux?: Record<string, string>; // songList / unlockdata / ... = 절대주소
  profile?: Record<string, RemoteProfileEntry>; // djName / iidxId / spRank / dpRank
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

// renderer(useProfile) 가 IPC 로 받는 프로필 offset — gist 의 profile 부분만. 없으면 null.
export async function getRemoteProfileOffsets(): Promise<Record<string, RemoteProfileEntry> | null> {
  const remote = await getRemoteOffsets();
  return remote?.profile ?? null;
}
