// zasa.sakura.ne.jp/dp/run.php 의 비공식 ☆12 난이도표 보충 — ereter 미등록 차트 검증용.
//
// 추천곡 / ★값 추정에는 사용 X. DP12 격자 표의 미분류 곡들을 ★ 단위로 분류해주는 용도만.
//
// 캐시: userData/zasa-data.json, TTL 24h.
import { app } from 'electron';
import { promises as fsp, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parse } from 'node-html-parser';

export const TTL_MS = 24 * 60 * 60 * 1000;
const ZASA_URL = 'https://zasa.sakura.ne.jp/dp/run.php';

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

async function parsePage(): Promise<ZasaChart[]> {
  const html = await fetchHtml(ZASA_URL);
  const root = parse(html);
  const table = root.querySelector('table.run');
  if (!table) throw new Error('table.run 못 찾음 (페이지 구조 변경?)');

  const charts: ZasaChart[] = [];
  const rows = table.querySelectorAll('tr');
  for (const tr of rows) {
    const tds = tr.querySelectorAll('td');
    if (tds.length !== 4) continue; // 헤더 row 등은 td 수 다름
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

// 캐시 + fetch — force=false 면 24h 안 캐시 우선
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
  const charts = await parsePage();
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
