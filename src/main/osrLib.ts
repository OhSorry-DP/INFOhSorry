// calc-OSRating.js gist 자동 갱신 — 부팅 시 fetch + userData 캐시
//
// 흐름:
//   1. 앱 시작 시 main process 가 gist 에서 calc-OSRating.js 텍스트 fetch (비동기)
//   2. 캐시 파일 (userData/libs/calc-OSRating.js) 의 version 과 비교
//   3. fetch 한 게 더 최신이면 캐시 갱신
//   4. renderer 가 IPC 로 캐시 lib 코드 요청 → renderer 가 eval → window.ohSorryRating 등록
//   5. App.tsx 의 osrInferUserTiered 호출 시 window 에 있으면 그것 우선, 없으면 bundle 사용
//
// fetch 실패 시: 캐시가 있으면 그대로 유지, 없으면 renderer 가 bundle (src/shared/calc-osrating.ts) 사용.
import { app } from 'electron';
import { promises as fsp, existsSync } from 'fs';
import { join, dirname } from 'path';

const OSR_GIST_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw/calc-OSRating.js';

function cachePath(): string {
  return join(app.getPath('userData'), 'libs', 'calc-OSRating.js');
}

// version 추출 — UMD lib 의 `version: '0.0.X'` 패턴 검색
function extractVersion(code: string): string | null {
  const m = code.match(/version\s*:\s*['"]([\d.]+)['"]/);
  return m ? m[1] : null;
}

// 단순 문자열 비교 — '0.0.2' > '0.0.1' (자릿수 같을 때 OK). semver 까진 아님.
function isNewer(remote: string | null, local: string | null): boolean {
  if (!remote) return false;
  if (!local) return true;
  // dot split → number 배열 비교
  const a = remote.split('.').map((n) => parseInt(n, 10) || 0);
  const b = local.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] || 0;
    const bi = b[i] || 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false; // 같으면 false (갱신 X)
}

// gist 에서 fetch → 캐시 갱신 (background, 실패해도 throw X)
export async function checkAndUpdateOsrLib(): Promise<{ updated: boolean; version: string | null; source: 'fetch' | 'cache' | 'none'; error?: string }> {
  const path = cachePath();
  // 현재 캐시 version
  let cachedVersion: string | null = null;
  if (existsSync(path)) {
    try {
      const cached = await fsp.readFile(path, 'utf-8');
      cachedVersion = extractVersion(cached);
    } catch {}
  }
  // gist fetch
  try {
    const url = OSR_GIST_URL + '?t=' + Date.now();
    const res = await fetch(url, {
      headers: { 'User-Agent': 'INFOhSorry (+https://github.com/yenkara/INFOhSorry)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const code = await res.text();
    const remoteVersion = extractVersion(code);
    if (!remoteVersion) throw new Error('version 추출 실패');

    if (isNewer(remoteVersion, cachedVersion)) {
      // 캐시 갱신
      await fsp.mkdir(dirname(path), { recursive: true });
      await fsp.writeFile(path, code, 'utf-8');
      console.log(`[osrLib] 갱신: ${cachedVersion || '(없음)'} → ${remoteVersion}`);
      return { updated: true, version: remoteVersion, source: 'fetch' };
    }
    console.log(`[osrLib] 최신 (${cachedVersion}, remote ${remoteVersion})`);
    return { updated: false, version: cachedVersion, source: 'cache' };
  } catch (e) {
    const msg = (e as Error).message;
    console.warn(`[osrLib] fetch 실패: ${msg} (캐시 ${cachedVersion ? 'v' + cachedVersion : '없음'} 유지)`);
    return {
      updated: false,
      version: cachedVersion,
      source: cachedVersion ? 'cache' : 'none',
      error: msg,
    };
  }
}

// renderer 가 호출 — 캐시 lib 코드 + version 반환. 없으면 null.
export async function getOsrLibCode(): Promise<{ code: string; version: string | null } | null> {
  const path = cachePath();
  if (!existsSync(path)) return null;
  try {
    const code = await fsp.readFile(path, 'utf-8');
    return { code, version: extractVersion(code) };
  } catch {
    return null;
  }
}
