// ereter.net 의 perlevel 페이지 (★ EC/HC/EXH diff 값) 를 fetch + 파싱 + 캐시
//
// ohSorry 의 1-fetch-ereter.js 를 main process Node 환경으로 포팅.
// 출력 형식은 ohSorry 의 ereter-data.json 과 동일 — 향후 ohSorry 의 별값 추정 모델
// 그대로 적용 가능.
//
// 캐시: userData/ereter-data.json, TTL 24h.
//   - 24h 안의 캐시면 그대로 반환
//   - 없거나 expired 면 fetch + 저장
//   - 사용자가 force=true 로 강제 새로고침 가능
import { app } from 'electron';
import { promises as fsp, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parse } from 'node-html-parser';

export const TTL_MS = 24 * 60 * 60 * 1000;
const PERLEVEL_URL = 'https://ereter.net/iidxsongs/analytics/perlevel/';

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
    headers: { 'User-Agent': 'INFOhSorry (+https://github.com/yenkara/INFOhSorry)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// perlevel 페이지에서 차트별 EC/HC/EXH ★ diff 추출
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

    // td[0]: ☆12.3 → 12.3
    const level = parseFloat(cells[0].text.trim().replace(/[☆\s]/g, ''));
    if (!Number.isFinite(level)) continue;

    // td[1]: 곡명 + <span> (차트 종류)
    const titleCell = cells[1];
    const chartSpan = titleCell.querySelector('span');
    let chartType = '';
    if (chartSpan) chartType = chartSpan.text.trim().replace(/[()]/g, '');
    let title = titleCell.text;
    if (chartSpan) title = title.replace(chartSpan.text, '');
    title = title.trim();

    // td[2,3,4]: EC/HC/EXH diff (sort-value 속성에 정확한 값)
    const getDiff = (idx: number): number | null => {
      const sv = cells[idx]?.getAttribute('sort-value');
      const v = sv != null ? parseFloat(sv) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    const ec = getDiff(2);
    const hc = getDiff(3);
    const exh = getDiff(4);

    // td[5,6,7]: 클리어 인구수 (정수)
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

// 캐시 + fetch — force=false 면 24h 안 캐시 우선, force=true 면 무조건 fetch
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
  const charts = await fetchPerlevel();
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
