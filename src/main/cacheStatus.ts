// 캐시 파일 상태(mtime / stale 여부) 계산 — ereter / zasa / spTier / rating 공용 헬퍼.
//
// 4개 데이터 모듈이 모두 "userData 에 JSON 캐시 + TTL 24h" 구조라 상태 계산 로직이 동일했다.
// 각 모듈은 자기 dataPath() / TTL_MS 만 넘기고, 공개 타입(EreterCacheStatus 등)과
// 함수 시그니처는 그대로 유지한다 (preload / renderer 계약 무변경).
import { existsSync, statSync } from 'fs';

export interface CacheStatus {
  mtime: number | null; // 파일 mtime epoch ms (없으면 null)
  isStale: boolean; // TTL 초과 또는 파일 없음
  exists: boolean;
}

export function readCacheStatus(path: string, ttlMs: number): CacheStatus {
  if (!existsSync(path)) return { mtime: null, isStale: true, exists: false };
  try {
    const st = statSync(path);
    return {
      mtime: st.mtimeMs,
      isStale: Date.now() - st.mtimeMs > ttlMs,
      exists: true,
    };
  } catch {
    return { mtime: null, isStale: true, exists: false };
  }
}
