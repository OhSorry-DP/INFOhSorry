// ereter.net 의 perlevel 페이지 (★ EC/HC/EXH diff 값) 를 fetch + 파싱 + 캐시
//
// ohSorry 의 1-fetch-ereter.js 를 main process Node 환경으로 포팅.
// 출력 형식은 ohSorry 의 ereter-data.json 과 동일 — 향후 ohSorry 의 별값 추정 모델
// 그대로 적용 가능.
//
// 폴백 체인 (우선순위):
//   1. ereter.net 직접 HTML scraping (authoritative)
//   2. ohSorry gist 의 ereter-data.json (admin 수동 갱신본 — ereter.net 다운 대응)
//   3. 로컬 stale 캐시 (네트워크 자체 안 될 때 최후)
//
// 캐시: userData/ereter-data.json, TTL 24h.
import { app } from 'electron';
import { promises as fsp, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parse } from 'node-html-parser';

export const TTL_MS = 24 * 60 * 60 * 1000;
const PERLEVEL_URL = 'https://ereter.net/iidxsongs/analytics/perlevel/';
const ERETER_GIST_URL =
  'https://gist.githubusercontent.com/OhSorry-DP/c3da608194c44f431abd2f1a7a4a9f5e/raw/ereter-data.json';

export interface EreterChart {
  title: string;
  diff: string; // 'ANOTHER' | 'HYPER' | 'LEGGENDARIA' | ... (ereter 의 차트 종류 표기)
  level: number; // ereter 의 ★ 값 (소수, 예: 11.6, 12.3)
  ec: number | null;
  hc: number | null;
  exh: number | null;
  ec_n: number | null;
  hc_n: number | null;
  exh_n: number | null;
}

export interface EreterData {
  extractedAt: string;
  source: string;
  count: number;
  charts: EreterChart[];
}

function dataPath(): string {
  return join(app.getPath('userData'), 'ereter-data.json');
}

// HTTPS GET 헬퍼 (Node 18+ global fetch 사용)
async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'INFOhSorry (+https://github.com/OhSorry-DP/INFOhSorry)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// perlevel 페이지에서 차트별 EC/HC/EXH ★ diff 추출 (1순위 — authoritative)
async function fetchPerlevel(): Promise<EreterChart[]> {
  const html = await fetchHtml(PERLEVEL_URL);
  const root = parse(html);

  // 1순위: table.tablesorter (클라이언트 JS 가 추가하므로 SSR 에는 없을 수도)
  // 2순위: 첫 th 가 ☆ 인 table
  let table = root.querySelector('table.tablesorter');
  if (!table) {
    for (const t of root.querySelectorAll('table')) {
      const th = t.querySelector('thead th');
      if (th && th.text.trim() === '☆') {
        table = t;
        break;
      }
    }
  }
  if (!table) throw new Error('perlevel table 못 찾음 (페이지 구조 변경?)');

  const charts: EreterChart[] = [];
  const rows = table.querySelectorAll('tbody tr');
  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 5) continue;

    const level = parseFloat(cells[0].text.trim().replace(/[☆\s]/g, ''));
    if (!Number.isFinite(level)) continue;

    const titleCell = cells[1];
    const chartSpan = titleCell.querySelector('span');
    let chartType = '';
    if (chartSpan) chartType = chartSpan.text.trim().replace(/[()]/g, '');
    let title = titleCell.text;
    if (chartSpan) title = title.replace(chartSpan.text, '');
    title = title.trim();

    const getDiff = (idx: number): number | null => {
      const sv = cells[idx]?.getAttribute('sort-value');
      const v = sv != null ? parseFloat(sv) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    const ec = getDiff(2);
    const hc = getDiff(3);
    const exh = getDiff(4);

    const getCount = (idx: number): number | null => {
      const t = cells[idx]?.text.trim();
      const v = parseInt(t || '', 10);
      return Number.isFinite(v) ? v : null;
    };

    if (!title || (ec == null && hc == null && exh == null)) continue;
    charts.push({
      title,
      diff: chartType,
      level,
      ec,
      hc,
      exh,
      ec_n: getCount(5),
      hc_n: getCount(6),
      exh_n: getCount(7),
    });
  }
  return charts;
}

// gist fallback — admin 이 이미 정제해서 push 한 JSON. ereter.net 다운 시 사용.
// 반환은 EreterData 통째 (extractedAt 도 gist 의 것 사용).
async function fetchFromGist(): Promise<EreterData> {
  const url = `${ERETER_GIST_URL}?t=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'INFOhSorry (+https://github.com/OhSorry-DP/INFOhSorry)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as Partial<EreterData>;
  if (!Array.isArray(json.charts)) throw new Error('gist JSON 의 charts 배열 없음');
  return {
    extractedAt: json.extractedAt || new Date().toISOString(),
    source: ERETER_GIST_URL,
    count: json.count ?? json.charts.length,
    charts: json.charts,
  };
}

// 캐시 + fetch — force=false 면 24h 안 캐시 우선, force=true 면 무조건 fetch.
// 폴백: ereter.net 실패 → gist → stale 캐시 → throw.
export async function getEreterData(force = false): Promise<EreterData> {
  const path = dataPath();
  if (!force && existsSync(path)) {
    try {
      const text = await fsp.readFile(path, 'utf-8');
      const cached: EreterData = JSON.parse(text);
      const age = Date.now() - new Date(cached.extractedAt).getTime();
      if (age < TTL_MS) return cached;
    } catch {
      // 손상된 캐시 — 다시 fetch
    }
  }
  // 1순위: ereter.net 직접 fetch
  let charts: EreterChart[] | null = null;
  let fetchErr: Error | null = null;
  try {
    charts = await fetchPerlevel();
  } catch (e) {
    fetchErr = e as Error;
    console.warn(`[ereter] ereter.net fetch 실패 → gist fallback 시도: ${fetchErr.message}`);
  }
  // 2순위: ereter.net 실패면 gist fallback
  if (!charts) {
    try {
      const gistData = await fetchFromGist();
      console.warn(
        `[ereter] gist fallback 사용 (${gistData.extractedAt} 추출본). ereter.net 복구 시 다시 직접 fetch.`,
      );
      await fsp.writeFile(path, JSON.stringify(gistData), 'utf-8');
      return gistData;
    } catch (gistErr) {
      console.warn(`[ereter] gist fallback 도 실패: ${(gistErr as Error).message}`);
      // 3순위: stale 캐시
      if (existsSync(path)) {
        try {
          const text = await fsp.readFile(path, 'utf-8');
          const cached: EreterData = JSON.parse(text);
          console.warn(
            `[ereter] stale 캐시 fallback (${cached.extractedAt} 추출본).`,
          );
          return cached;
        } catch {
          /* 손상된 캐시 */
        }
      }
      throw fetchErr ?? (gistErr as Error);
    }
  }
  const data: EreterData = {
    extractedAt: new Date().toISOString(),
    source: PERLEVEL_URL,
    count: charts.length,
    charts,
  };
  await fsp.writeFile(path, JSON.stringify(data), 'utf-8');
  return data;
}

// 캐시 상태만 반환 (UI 표시용 — 마지막 갱신 시각, stale 여부)
export interface EreterCacheStatus {
  mtime: number | null; // 파일 mtime epoch ms (없으면 null)
  isStale: boolean; // 24h 초과 또는 파일 없음
  exists: boolean;
}
export function getCacheStatus(): EreterCacheStatus {
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

export function getDataPath(): string {
  return dataPath();
}
