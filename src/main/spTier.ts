// SP ☆12 서열표 — ohSorryRating 이 seed:full 마다 구글시트 "☆12参考表" 를 재파싱해
// 발행하는 sp-tier-12.json(data.iidx.in) 을 fetch → userData 캐시.
//
// 2026-09-06 이전에는 이 파일이 구글시트 published HTML 을 직접 fetch+파싱했으나,
//   (1) 오소리웹(pages/grid/shelf.js) 도 같은 데이터를 별도 경로로 쓰고 있어 파서가 두 곳에
//       중복돼 있었고, (2) 이 앱은 spTier.ts 만 24h TTL 로 재수집할 뿐 배포된 JSON 은
//       한 번 수동 생성된 뒤 갱신되지 않아 서로 다른 스냅샷을 볼 수 있었다.
//   ohSorryRating/scripts/derive/sp/fetch-sp-tier-12.js 로 파서를 이관하고 fetch-sources.js
//   (seed:full) 에 매번 재수집·재발행하도록 편입해 **단일 소스**로 만들었다 — 이 파일은
//   이제 rating.ts/ereter.ts 의 gist/R2 fallback 과 동일한 "그냥 JSON 하나 받기" 패턴만 남는다.
//
// 폴백 체인:
//   1. data.iidx.in 의 sp-tier-12.json 직접 fetch (authoritative — seed:full 마다 갱신)
//   2. 로컬 stale 캐시 (fetch 실패 / 네트워크 끊김 시 — TTL 무관 최후 수단)
//
// 캐시: userData/sp-tier-12.json, TTL 24h.
import { app } from 'electron';
import { promises as fsp, existsSync } from 'fs';
import { join } from 'path';
import { readCacheStatus } from './cacheStatus';
import { DATA_BASE } from '../shared/dataSource';
import type { SpTierData } from '../shared/types';

export const TTL_MS = 24 * 60 * 60 * 1000;
const SP_TIER12_URL = DATA_BASE + '/sp-tier-12.json';

function dataPath(): string {
  return join(app.getPath('userData'), 'sp-tier-12.json');
}

async function fetchRaw(): Promise<SpTierData> {
  const url = `${SP_TIER12_URL}?t=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'INFOhSorry (+https://github.com/OhSorry-DP/INFOhSorry)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SpTierData;
}

// 캐시 + fetch — force=false 면 24h 안 캐시 우선.
// 폴백: 발행 JSON fetch 성공 → 캐시 갱신 / 실패 → stale 캐시 → throw.
export async function getSpTierData(force = false): Promise<SpTierData> {
  const path = dataPath();
  if (!force && existsSync(path)) {
    try {
      const cached: SpTierData = JSON.parse(await fsp.readFile(path, 'utf-8'));
      const age = Date.now() - new Date(cached.extractedAt).getTime();
      if (age < TTL_MS) return cached;
    } catch {
      // 손상된 캐시 — 다시 fetch
    }
  }
  try {
    const data = await fetchRaw();
    await fsp.writeFile(path, JSON.stringify(data), 'utf-8');
    return data;
  } catch (e) {
    console.warn(`[spTier] sp-tier-12.json fetch 실패: ${(e as Error).message}`);
    // stale 캐시 fallback
    if (existsSync(path)) {
      try {
        const cached: SpTierData = JSON.parse(await fsp.readFile(path, 'utf-8'));
        console.warn(`[spTier] stale 캐시 fallback (${cached.extractedAt} 추출본).`);
        return cached;
      } catch {
        /* 손상된 캐시 */
      }
    }
    throw e;
  }
}

export interface SpTierCacheStatus {
  mtime: number | null;
  isStale: boolean;
  exists: boolean;
}
export function getCacheStatus(): SpTierCacheStatus {
  return readCacheStatus(dataPath(), TTL_MS);
}
