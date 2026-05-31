// SP ☆12 서열표 — 외부 구글 시트 "☆12参考表" 의 하드/노마게 간이표(簡易) 를
// published HTML 로 fetch → 파싱 → userData 캐시.
//
// 폴백 체인:
//   1. 구글 시트 published HTML 직접 fetch + 파싱 (authoritative)
//   2. 로컬 캐시 (fetch 실패 / 네트워크 끊김 시 — TTL 무관 최후 수단)
//
// 캐시: userData/sp-tier-12.json, TTL 24h.
//
// 시트 구조 (간이표):
//   row1 = 헤더 (tier F E D C B B＋ A A＋ S S＋, 왼쪽=쉬움 → 오른쪽=어려움)
//   row2 = 곡셀 10개 (tier 별, <br> 로 곡 구분)
//   곡 표기: 접미사 없음=ANOTHER / [N]=NORMAL / [H]=HYPER / [L]=LEGGENDARIA
//   곡 제목이 빨강(#ff0000) = 개인차 / 주의곡
import { app } from 'electron';
import { promises as fsp, existsSync, statSync } from 'fs';
import { join } from 'path';
import { parse } from 'node-html-parser';
import type {
  SpTierData,
  SpTierEntry,
  SpTierGauge,
  SpTierRank,
  SpTierTable,
} from '../shared/types';

export const TTL_MS = 24 * 60 * 60 * 1000;

// published 스프레드시트 (☆12参考表) — 간이표 탭 gid
const PUB_BASE =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSUdp6iuEzE8Z5AL1hkoxzLexp89nJnLQMmICm6_MC0_UjCp1ImZFzabcZkvCpK7mcWvm_2t6iYoJRg/pubhtml/sheet?headers=false&gid=';
const GID: Record<SpTierGauge, string> = {
  hard: '1277599511', // ハード表(簡易)
  normal: '1184656976', // ノマゲ表(簡易)
};

// tier rank — 표시 순서 (어려운 → 쉬운). 헤더에서 읽되, 누락 대비 기본 순서 보유.
const RANK_DISPLAY_ORDER: SpTierRank[] = ['S＋', 'S', 'A＋', 'A', 'B＋', 'B', 'C', 'D', 'E', 'F'];
const TIER_SET = new Set<string>(RANK_DISPLAY_ORDER);

// [X] 마커 → 차트 표기. 접미사 없으면 ANOTHER.
const MARKER_TO_DIFF: Record<string, SpTierEntry['diff']> = {
  N: 'NORMAL',
  H: 'HYPER',
  L: 'LEGGENDARIA',
  A: 'ANOTHER',
};

function dataPath(): string {
  return join(app.getPath('userData'), 'sp-tier-12.json');
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'INFOhSorry (+https://github.com/OhSorry-DP/INFOhSorry)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// <br> 로 나뉜 곡 한 줄(HTML) → 파싱된 entry (빈 줄이면 null).
function parseSongLine(segHtml: string, rank: SpTierRank): SpTierEntry | null {
  // 제목 빨강(#ff0000) = 주의곡. ([L]/[H] 마커는 마젠타/주황 — 별개.)
  const caution = /color:\s*#ff0000/i.test(segHtml);
  const plain = decodeEntities(segHtml.replace(/<[^>]+>/g, '')).trim();
  if (!plain) return null;
  // 끝의 [N]/[H]/[L]/[A] 마커 추출
  const m = plain.match(/\[([NHLA])\]\s*$/);
  let diff: SpTierEntry['diff'] = 'ANOTHER';
  let title = plain;
  if (m) {
    diff = MARKER_TO_DIFF[m[1]] ?? 'ANOTHER';
    title = plain.slice(0, m.index).trim();
  }
  if (!title) return null;
  return { title, diff, rank, caution };
}

// 한 게이지 표(HTML) → SpTierTable
function parseTable(html: string, gauge: SpTierGauge): SpTierTable {
  const root = parse(html);
  const table = root.querySelector('table');
  if (!table) throw new Error('table 못 찾음 (시트 구조 변경?)');
  const trs = table.querySelectorAll('tr');

  // 헤더 행 = tier 토큰이 다수인 첫 행. 그 다음 행 = 곡셀.
  let headerIdx = -1;
  let ranks: SpTierRank[] = [];
  for (let i = 0; i < trs.length; i++) {
    const cells = trs[i].querySelectorAll('td');
    const texts = cells.map((c) => c.text.trim());
    const tierCells = texts.filter((t) => TIER_SET.has(t));
    if (tierCells.length >= 8) {
      headerIdx = i;
      ranks = texts.map((t) => (TIER_SET.has(t) ? (t as SpTierRank) : null)).filter(
        (r): r is SpTierRank => r !== null,
      );
      break;
    }
  }
  if (headerIdx < 0) throw new Error('tier 헤더 행 못 찾음');

  // 곡셀 행 = 헤더 다음, tier 헤더가 아닌 첫 행
  let songRow = null as ReturnType<typeof table.querySelectorAll>[number] | null;
  for (let i = headerIdx + 1; i < trs.length; i++) {
    const cells = trs[i].querySelectorAll('td');
    if (cells.length < ranks.length) continue;
    const texts = cells.map((c) => c.text.trim());
    const tierCells = texts.filter((t) => TIER_SET.has(t));
    if (tierCells.length >= 8) continue; // 중복 헤더 skip
    songRow = trs[i];
    break;
  }
  if (!songRow) throw new Error('곡셀 행 못 찾음');

  // 헤더 tier 셀의 td 인덱스 ↔ rank 매핑 후, 곡셀 행의 같은 인덱스 셀 파싱
  const headerCells = trs[headerIdx].querySelectorAll('td');
  const songCells = songRow.querySelectorAll('td');
  const entries: SpTierEntry[] = [];
  for (let col = 0; col < headerCells.length; col++) {
    const t = headerCells[col].text.trim();
    if (!TIER_SET.has(t)) continue;
    const rank = t as SpTierRank;
    const cell = songCells[col];
    if (!cell) continue;
    const segs = cell.innerHTML.split(/<br\s*\/?>/i);
    for (const seg of segs) {
      const e = parseSongLine(seg, rank);
      if (e) entries.push(e);
    }
  }
  if (entries.length === 0) throw new Error('곡 entry 0개 (파싱 실패)');

  // 표시 순서 (S＋ → F) 로 정렬된 rank 목록 — 실제 등장한 rank 만
  const present = new Set(entries.map((e) => e.rank));
  const orderedRanks = RANK_DISPLAY_ORDER.filter((r) => present.has(r));

  return { gauge, ranks: orderedRanks, entries };
}

async function fetchAndParse(): Promise<SpTierData> {
  const [hardHtml, normalHtml] = await Promise.all([
    fetchHtml(`${PUB_BASE}${GID.hard}`),
    fetchHtml(`${PUB_BASE}${GID.normal}`),
  ]);
  const hard = parseTable(hardHtml, 'hard');
  const normal = parseTable(normalHtml, 'normal');
  return {
    extractedAt: new Date().toISOString(),
    source: 'docs.google.com ☆12参考表 (簡易 ハード/ノマゲ)',
    level: 12,
    hard,
    normal,
  };
}

// 캐시 + fetch — force=false 면 24h 안 캐시 우선.
// 폴백: published fetch 성공 → 캐시 갱신 / 실패 → stale 캐시 → throw.
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
    const data = await fetchAndParse();
    await fsp.writeFile(path, JSON.stringify(data), 'utf-8');
    return data;
  } catch (e) {
    console.warn(`[spTier] published fetch 실패: ${(e as Error).message}`);
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
  const path = dataPath();
  if (!existsSync(path)) return { mtime: null, isStale: true, exists: false };
  try {
    const st = statSync(path);
    return { mtime: st.mtimeMs, isStale: Date.now() - st.mtimeMs > TTL_MS, exists: true };
  } catch {
    return { mtime: null, isStale: true, exists: false };
  }
}
