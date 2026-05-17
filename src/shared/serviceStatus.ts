// 원격 service status fetch — fail-closed (fetch 실패 시 disabled).
//
// gist 의 service-status.json (secret) 으로 uploadEnabled / shelfEnabled toggle.
// supabase / 서비스 점검 시 코드 / 빌드 변경 없이 즉시 (또는 캐시 만료 후) 차단 가능.
//
// 의도:
//   - uploadEnabled=false → 모든 supabase upload skip
//   - shelfEnabled=false → 게스트 페이지의 grid 탭 skip (INFOhSorry 와 무관)
//   - fetch 실패 → fail-closed: 둘 다 disabled 로 취급
//
// 캐시: 5분 메모리. 앱 재시작 시 재 fetch.

const SERVICE_STATUS_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw/service-status.json';
const SERVICE_STATUS_CACHE_MS = 5 * 60 * 1000;

export interface ServiceStatus {
  uploadEnabled: boolean;
  shelfEnabled: boolean;
  message?: string;
  updatedAt?: string;
}

let cache: ServiceStatus | null = null;
let cachedAt = 0;

export async function fetchServiceStatus(): Promise<ServiceStatus> {
  const now = Date.now();
  if (cache && now - cachedAt < SERVICE_STATUS_CACHE_MS) {
    return cache;
  }
  try {
    const res = await fetch(`${SERVICE_STATUS_URL}?t=${now}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as ServiceStatus;
    cache = data;
    cachedAt = now;
    return data;
  } catch (e) {
    console.warn('[serviceStatus] fetch 실패, fail-closed 적용:', (e as Error).message);
    return {
      uploadEnabled: false,
      shelfEnabled: false,
      message: '서비스 상태 확인 실패 — 잠시 후 다시 시도해주세요.',
    };
  }
}

// 캐시 강제 무효화 — UI 에서 수동 재시도 시 사용.
export function invalidateServiceStatusCache(): void {
  cache = null;
  cachedAt = 0;
}
