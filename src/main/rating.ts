// ohSorryRating.json (ereter 미등록 lv11/lv12 차트의 EC/HC/EXH ★ 추정값) gist fetch + 캐시
//
// 출처: ohSorry/scripts/test-fill-stars.js 가 생성한 JSON 을 gist 에 push.
// 추천 풀의 ratingMap fallback 으로 사용 — 이레터에 없는 lv11/lv12 차트도 추천 후보.
//
// 캐시: userData/ohSorryRating.json, TTL 24h.
import { app } from 'electron';
import { promises as fsp, existsSync, statSync } from 'fs';
import { join } from 'path';

export const TTL_MS = 24 * 60 * 60 * 1000;
const RATING_GIST_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw/ohSorryRating.json';

export interface RatingChart {
  title: string;
  diff: string;
  gameLevel: number; // 11 or 12
  zasaLevel: number; // ohSorry 의 zasa 기반 ★ 추정값 (10.2 ~ 12.7)
  estEc: number | null;
  estHc: number | null;
  estExh?: number | null;
  nEcCleared?: number | null;
  nHcCleared?: number | null;
  nPlayed?: number | null;
}

export interface RatingData {
  generatedAt: string;
  source: string;
  ratings: RatingChart[];
}

function dataPath(): string {
  return join(app.getPath('userData'), 'ohSorryRating.json');
}

async function fetchRaw(): Promise<RatingData> {
  const url = `${RATING_GIST_URL}?t=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'INFOhSorry (+https://github.com/yenkara/INFOhSorry)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RatingData;
}

export async function getRatingData(force = false): Promise<RatingData> {
  const path = dataPath();
  if (!force && existsSync(path)) {
    try {
      const text = await fsp.readFile(path, 'utf-8');
      const cached: RatingData = JSON.parse(text);
      const age = Date.now() - new Date(cached.generatedAt).getTime();
      if (age < TTL_MS) return cached;
    } catch {
      // 손상된 캐시 — 다시 fetch
    }
  }
  const data = await fetchRaw();
  await fsp.writeFile(path, JSON.stringify(data), 'utf-8');
  return data;
}

export interface RatingCacheStatus {
  mtime: number | null;
  isStale: boolean;
  exists: boolean;
}

export function getRatingCacheStatus(): RatingCacheStatus {
  const path = dataPath();
  if (!existsSync(path)) return { mtime: null, isStale: true, exists: false };
  try {
    const st = statSync(path);
    return {
      mtime: st.mtimeMs,
      isStale: Date.now() - st.mtimeMs > TTL_MS,
      exists: true,
    };
  } catch {
    return { mtime: null, isStale: true, exists: false };
  }
}
