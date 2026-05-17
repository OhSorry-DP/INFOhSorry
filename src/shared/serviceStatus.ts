// 원격 service status fetch — fail-closed (fetch 실패 시 disabled).
//
// gist 의 service-status.json (secret) 으로 uploadEnabled / shelfEnabled toggle.
// supabase / 서비스 점검 시 코드 / 빌드 변경 없이 즉시 차단 가능.
//
// 의도:
//   - uploadEnabled=false → 모든 supabase upload skip
//   - shelfEnabled=false → 게스트 페이지의 grid 탭 skip (INFOhSorry 와 무관)
//   - fetch 실패 → fail-closed: 둘 다 disabled 로 취급
//
// 캐시: 없음 (0.0.42). 매 호출마다 fresh fetch — 일시 fetch 실패가 5분 동안 영구 disabled 로
//        남는 것 방지. github gist raw CDN 이라 rate limit 부담 무관.

const SERVICE_STATUS_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw/service-status.json';

export interface ServiceStatus {
  uploadEnabled: boolean;
  shelfEnabled: boolean;
  message?: string;
  updatedAt?: string;
}

export async function fetchServiceStatus(): Promise<ServiceStatus> {
  try {
    const res = await fetch(`${SERVICE_STATUS_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as ServiceStatus;
  } catch (e) {
    console.warn('[serviceStatus] fetch 실패, fail-closed 적용:', (e as Error).message);
    return {
      uploadEnabled: false,
      shelfEnabled: false,
      message: '서비스 상태 확인 실패 — 잠시 후 다시 시도해주세요.',
    };
  }
}
