// zasa.sakura.ne.jp/dp/run.php 의 비공식 ☆12 난이도표 보충 — ereter 미등록 차트 검증용.
//
// 추천곡 / ★값 추정에는 사용 X. DP12 격자 표의 미분류 곡들을 ★ 단위로 분류해주는 용도만.
//
// 폴백 체인 (우선순위):
//   1. zasa.sakura.ne.jp 직접 HTML scraping (authoritative)
//   2. ohSorry gist 의 zasa-data.json (admin 수동 갱신본 — zasa 다운 대응)
//   3. 로컬 stale 캐시 (네트워크 자체 안 될 때 최후)
//
// 캐시: userData/zasa-data.json, TTL 24h.
import { app } from 'electron';
import { promises as fsp, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parse } from 'node-html-parser';

export const TTL_MS = 24 * 60 * 60 * 1000;
const ZASA_URL = 'https://zasa.sakura.ne.jp/dp/run.php';
const ZASA_GIST_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw/zasa-data.json';

// span class → 우리가 쓰는 차트 표기 (ereter 와 일치)
const SPAN_TO_DIFF: Record<string, string> = {
  H: 'HYPER',
  A: 'ANOTHER',
  L: 'LEGGENDARIA',
};

export interface ZasaChart {
  title: string;
  diff: string; // 'HYPER' | 'ANOTHER' | 'LEGGENDARIA'
  level: number;
}

export interface ZasaData {
  extractedAt: string;
  source: string;
  count: number;
  charts: ZasaChart[];
}

function dataPath(): string {
  return join(app.getPath('userData'), 'zasa-data.json');
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'INFOhSorry (+https://github.com/OhSorry-DP/INFOhSorry)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 1순위: zasa.sakura.ne.jp 직접 HTML scraping (authoritative)
async function parsePage(): Promise<ZasaChart[]> {
  const html = await fetchHtml(ZASA_URL);
  const root = parse(html);
  const table = root.querySelector('table.run');
  if (!table) throw new Error('table.run 못 찾음 (페이지 구조 변경?)');

  const charts: ZasaChart[] = [];
  const rows = table.querySelectorAll('tr');
  for (const tr of rows) {
    const tds = tr.querySelectorAll('td');
    if (tds.length !== 4) continue;
    const titleCell = tds[3];
    if (!titleCell.classNames.includes('music')) continue;
    const title = titleCell.text.trim();
    if (!title) continue;

    for (let i = 0; i < 3; i++) {
      const a = tds[i].querySelector('a.music');
      if (!a) continue;
      const span = a.querySelector('span');
      if (!span) continue;
      const diff = SPAN_TO_DIFF[span.classNames || ''];
      if (!diff) continue;
      const m = span.text.trim().match(/☆12 \(([0-9]+\.[0-9]+)\)/);
      if (!m) continue;
      const level = parseFloat(m[1]);
      if (!Number.isFinite(level) || level < 11.6 || level > 12.7) continue;
      charts.push({ title, diff, level });
    }
  }
  return charts;
}

// 2순위: gist 의 zasa-data.json fallback (admin 수동 갱신본)
async function fetchFromGist(): Promise<ZasaData> {
  const url = `${ZASA_GIST_URL}?t=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'INFOhSorry (+https://github.com/OhSorry-DP/INFOhSorry)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as Partial<ZasaData>;
  if (!Array.isArray(json.charts)) throw new Error('gist JSON 의 charts 배열 없음');
  return {
    extractedAt: json.extractedAt || new Date().toISOString(),
    source: ZASA_GIST_URL,
    count: json.count ?? json.charts.length,
    charts: json.charts,
  };
}

// 캐시 + fetch — force=false 면 24h 안 캐시 우선.
// 폴백: zasa.sakura → gist → stale 캐시 → throw.
export async function getZasaData(force = false): Promise<ZasaData> {
  const path = dataPath();
  if (!force && existsSync(path)) {
    try {
      const text = await fsp.readFile(path, 'utf-8');
      const cached: ZasaData = JSON.parse(text);
      const age = Date.now() - new Date(cached.extractedAt).getTime();
      if (age < TTL_MS) return cached;
    } catch {
      // 손상된 캐시 — 다시 fetch
    }
  }
  // 1순위: zasa.sakura 직접 fetch
  let charts: ZasaChart[] | null = null;
  let fetchErr: Error | null = null;
  try {
    charts = await parsePage();
  } catch (e) {
    fetchErr = e as Error;
    console.warn(`[zasa] zasa.sakura fetch 실패 → gist fallback 시도: ${fetchErr.message}`);
  }
  // 2순위: gist fallback
  if (!charts) {
    try {
      const gistData = await fetchFromGist();
      console.warn(
        `[zasa] gist fallback 사용 (${gistData.extractedAt} 추출본). zasa.sakura 복구 시 다시 직접 fetch.`,
      );
      await fsp.writeFile(path, JSON.stringify(gistData), 'utf-8');
      return gistData;
    } catch (gistErr) {
      console.warn(`[zasa] gist fallback 도 실패: ${(gistErr as Error).message}`);
      // 3순위: stale 캐시
      if (existsSync(path)) {
        try {
          const text = await fsp.readFile(path, 'utf-8');
          const cached: ZasaData = JSON.parse(text);
          console.warn(`[zasa] stale 캐시 fallback (${cached.extractedAt} 추출본).`);
          return cached;
        } catch {
          /* 손상된 캐시 */
        }
      }
      throw fetchErr ?? (gistErr as Error);
    }
  }
  const data: ZasaData = {
    extractedAt: new Date().toISOString(),
    source: ZASA_URL,
    count: charts.length,
    charts,
  };
  await fsp.writeFile(path, JSON.stringify(data), 'utf-8');
  return data;
}

export interface ZasaCacheStatus {
  mtime: number | null;
  isStale: boolean;
  exists: boolean;
}
export function getCacheStatus(): ZasaCacheStatus {
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
