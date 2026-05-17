// 0.0.43 — fetch 로직은 src/main/serviceStatus.ts 로 이동 (CORS 우회).
// 이 파일은 type-only 호환 layer 로 유지 (외부 import 호환). 신규 코드는 shared/types.ts 의
// ServiceStatus + window.infohsorry.serviceStatus.get() 사용 권장.
export type { ServiceStatus } from './types';
