// 원격 service status fetch — main 프로세스 (Node fetch). renderer 의 CORS / Chromium 정책 우회.
//
// gist 의 service-status.json (secret) 으로 uploadEnabled / shelfEnabled toggle.
// supabase / 서비스 점검 시 코드 / 빌드 변경 없이 즉시 차단 가능.
//
// 의도:
//   - uploadEnabled=false → 모든 supabase upload skip
//   - shelfEnabled=false → 게스트 페이지의 grid 탭 skip (INFOhSorry 와 무관)
//   - fetch 실패 → fail-closed: 둘 다 disabled 로 취급
//
// 캐시: 없음. 매 호출마다 fresh fetch — github gist raw CDN 이라 rate limit 부담 무관.
// renderer 에서 직접 fetch 하던 0.0.42 까지의 코드를 main 으로 옮김 (다른 gist fetch lib 들과 동일 패턴).
// ServiceStatus 타입은 shared/types.ts 정본을 단일 정의로 재노출 — 종전 로컬 중복 인터페이스 제거(schema alignment).
//   스키마 정본 문서: ohSorry/docs/service-status-schema.md (cross-repo 계약). 런타임 변화 없음(타입은 빌드 시 erase).
import type { ServiceStatus } from '../shared/types';
export type { ServiceStatus };

const SERVICE_STATUS_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw/service-status.json';

export async function fetchServiceStatus(): Promise<ServiceStatus> {
  try {
    const res = await fetch(`${SERVICE_STATUS_URL}?t=${Date.now()}`, {
      headers: { 'User-Agent': 'INFOhSorry (+https://github.com/OhSorry-DP/INFOhSorry)' },
    });
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
