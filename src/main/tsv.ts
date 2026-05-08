// Reflux 가 출력한 TSV 파일을 파싱해서 곡별 row 객체로 변환
//
// TSV 컬럼 구조 (Reflux Tracker.cs 기준):
//   title, Type, Label, Cost Normal/Hyper/Another, SP/DP DJ Points,
//   그리고 9개 차트 slot 각각에 8개 컬럼:
//     SPB / SPN / SPH / SPA / SPL / DPN / DPH / DPA / DPL
//   각 slot 컬럼: Unlocked, Rating, Lamp, Letter, EX Score, Miss Count, Note Count, DJ Points
import { promises as fs } from 'fs';
import type { ChartCell, ChartSlot, SongRow, Lamp } from '../shared/types';

const ALL_SLOTS: ChartSlot[] = ['SPB', 'SPN', 'SPH', 'SPA', 'SPL', 'DPN', 'DPH', 'DPA', 'DPL'];

function parseInt0(s: string): number {
  if (!s) return 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseBool(s: string): boolean {
  if (!s) return false;
  // Reflux 는 "TRUE" / "FALSE" (모두 대문자) 로 출력 — case-insensitive 처리
  const v = s.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function buildHeaderIndex(headerLine: string): Map<string, number> {
  const map = new Map<string, number>();
  const cols = headerLine.split('\t');
  cols.forEach((name, i) => map.set(name.trim(), i));
  return map;
}

function parseRow(idx: Map<string, number>, fields: string[]): SongRow | null {
  const get = (col: string): string => {
    const i = idx.get(col);
    return i != null && i < fields.length ? fields[i] : '';
  };
  const title = get('title');
  if (!title) return null;
  const charts: Partial<Record<ChartSlot, ChartCell>> = {};
  for (const slot of ALL_SLOTS) {
    const unlockedStr = get(`${slot} Unlocked`);
    if (unlockedStr === '') continue; // 컬럼 자체가 없으면 (구버전 TSV?) skip
    charts[slot] = {
      unlocked: parseBool(unlockedStr),
      rating: get(`${slot} Rating`),
      lamp: get(`${slot} Lamp`) as Lamp,
      letter: get(`${slot} Letter`),
      exScore: parseInt0(get(`${slot} EX Score`)),
      missCount: parseInt0(get(`${slot} Miss Count`)),
      noteCount: parseInt0(get(`${slot} Note Count`)),
      djPoints: parseInt0(get(`${slot} DJ Points`)),
    };
  }
  return { title, type: get('Type'), label: get('Label'), charts };
}

export async function readTsv(
  path: string,
): Promise<{ rows: SongRow[]; headerCols: string[]; mtime: number }> {
  const [text, st] = await Promise.all([fs.readFile(path, 'utf-8'), fs.stat(path)]);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 1) return { rows: [], headerCols: [], mtime: st.mtimeMs };
  const idx = buildHeaderIndex(lines[0]);
  const rows: SongRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split('\t');
    const row = parseRow(idx, fields);
    if (row) rows.push(row);
  }
  return { rows, headerCols: Array.from(idx.keys()), mtime: st.mtimeMs };
}
