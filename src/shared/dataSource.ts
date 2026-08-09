// dataSource.ts — 원격 코어 JS·데이터의 base URL 정본. main/renderer 공용.
//
// 왜 모듈로 모았나:
//   종전엔 같은 gist raw URL 이 8개 파일에 하드코딩돼 있었다(`ereter.ts`·`rating.ts`·`zasa.ts`·
//   `Analysis.tsx`·`PlayData.tsx`·`recommendCore.ts`·`supabaseSync.ts`·`WeaknessRecommend.tsx`).
//   그래서 소스를 옮길 때마다 전수 수정 + 릴리즈가 필요했다. 한 곳으로 모아 다음엔 여기만 고치면 되게 한다.
//
// 이전 (2026-08-09, CF 통합 §3): gist `c3da608…` → **Cloudflare R2(`data.iidx.in`)**
//   - gist raw 는 `Cache-Control: max-age=300` 고정이라 캐시 정책을 우리가 쥘 수 없었다.
//   - R2 는 Worker(ohsorry-data/cf)가 정책을 쥔다(현재 `max-age=60`) → 갱신 반영이 빠르다.
//   - 배치 규칙: **JS·CSS = `lib/`, JSON = `data/`** (Worker 허용키가 이 규칙으로 검사한다).
//
// ⚠️ **CSP** — renderer 는 `src/renderer/index.html` 의 `connect-src` 에 등재된 오리진으로만 fetch 할 수 있다.
//   여기를 바꾸면 그 화이트리스트도 **반드시 같이** 바꿔야 한다. 안 그러면 브라우저 레벨에서 조용히 차단된다.
//   (main 프로세스는 Node 라 CSP 무관이지만, 상수는 공용으로 둔다.)
//
// ⚠️ **운영 메타는 gist 에 남는다** — `service-status.json`·`offsets.json`·`series-name.json` 은
//   코드 배포 없이 웹에서 바로 고쳐 켜고 끄는 운영 스위치라 gist 편집이 더 낫다. 아래 OPS_GIST_RAW.

/** 코어 JS 모듈 (fetch + eval). 예: `${LIB_BASE}/normTitle.js` */
export const LIB_BASE = 'https://data.iidx.in/lib';

/** 데이터 JSON. 예: `${DATA_BASE}/textage-meta.json` */
export const DATA_BASE = 'https://data.iidx.in/data';

/** 운영 메타 gist(`30c3ba6…`) — service-status / offsets / series-name. **이전 대상 아님.** */
export const OPS_GIST_RAW = 'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw';
