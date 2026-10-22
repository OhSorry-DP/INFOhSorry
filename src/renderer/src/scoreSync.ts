import type { ChartSlot, SongRow } from '../../shared/types';
import { norm, slotToDiff } from '../../shared/match';
import {
  DIFF_MAP,
  LAMP_MAP,
  getSongsById,
  getSongsCache,
  pickSongId,
} from './supabaseSync';
import { DATA_BASE } from '../../shared/dataSource';

const MAX_DELETE_RATIO = 0.3;

type TsvIndexValue = { title: string; slot: ChartSlot; exScore: number; lamp: number | null };
type DbScore = {
  histIndex: number;
  song_id: number;
  diff: number;
  lamp: number | null;
  ex_score: number | null;
  played_version: number;
  play_style: number;
  date_kst: string;
  score_id: null;
};
type DeletionCategory = 'ac-on-inf' | 'noplay-but-db' | 'exceeds-tsv';

export interface ScoreSyncPlan {
  iidxId: string;
  counts: Record<string, number>;
  tsvStats: { charts: number; played: number; unmatched: number };
  deletions: Array<{
    scoreId: number | null;
    histIndex: number;
    songId: number;
    dateKst: string;
    playStyle: number;
    diff: number;
    playedVersion: number;
    category: DeletionCategory;
    title: string | null;
    slot: string | null;
    db: { exScore: number; lamp: number; playedVersion: number; playStyle: number; diff: number };
    tsv: { exScore: number; lamp: number | null } | null;
  }>;
  ambiguousSamples: Array<{ title: string; slot: string; exScore: number; lamp: number | null }>;
  blockedByRatio: boolean;
  sql: string | null;
}

function emptyCounts(): Record<string, number> {
  return {
    dbr: 0,
    'ac-on-inf': 0,
    'other-version': 0,
    'not-in-tsv': 0,
    'noplay-but-db': 0,
    ambiguous: 0,
    'exceeds-tsv': 0,
    ok: 0,
  };
}

function betterTsvCell(a: TsvIndexValue, b: TsvIndexValue): TsvIndexValue {
  if (b.exScore > a.exScore) return b;
  if (b.exScore === a.exScore && (b.lamp ?? -1) > (a.lamp ?? -1)) return b;
  return a;
}

function dbValue(v: number | null): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

async function fetchHist(iidxId: string): Promise<DbScore[]> {
  const response = await fetch(`${DATA_BASE}/hist/${encodeURIComponent(iidxId)}.json`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`R2 hist HTTP ${response.status}`);
  let document: unknown;
  try { document = await response.json(); } catch { throw new Error('R2 hist: invalid JSON'); }
  if (!Array.isArray(document)) throw new Error('R2 hist: invalid format');
  return document.map((raw, histIndex) => {
    if (!Array.isArray(raw) || (raw.length !== 8 && raw.length !== 10)) throw new Error(`R2 hist: invalid row at ${histIndex}`);
    const [song_id, diff, lamp, ex_score, played_version, date, date_kst, play_style] = raw;
    if (![song_id, diff, lamp, ex_score, played_version, play_style].every(v => typeof v === 'number' && Number.isFinite(v))
      || typeof date_kst !== 'string') throw new Error(`R2 hist: invalid row at ${histIndex}`);
    return { histIndex, song_id, diff, lamp, ex_score, played_version, date_kst, play_style, score_id: null };
  });
}

export async function planScoreSync(
  iidxId: string,
  rows: SongRow[],
  opts?: { force?: boolean },
): Promise<ScoreSyncPlan> {
  if (!/^[A-Z]\d{12}$/.test(iidxId)) throw new Error(`invalid IIDX ID: ${iidxId}`);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('tracker.tsv is empty');

  const songMap = await getSongsCache();
  const tsvIndex = new Map<string, TsvIndexValue>();
  let charts = 0;
  let played = 0;
  let unmatched = 0;
  for (const row of rows) {
    for (const slot of Object.keys(row.charts) as ChartSlot[]) {
      const cell = row.charts[slot];
      if (!cell) continue;
      charts++;
      const exScore = typeof cell.exScore === 'number' && Number.isFinite(cell.exScore) ? cell.exScore : 0;
      const lamp = Object.prototype.hasOwnProperty.call(LAMP_MAP, cell.lamp)
        ? LAMP_MAP[cell.lamp]
        : null;
      if (exScore > 0) played++;
      const songId = pickSongId(songMap.get(norm(row.title)), 0);
      if (songId == null) {
        unmatched++;
        continue;
      }
      const diff = DIFF_MAP[slotToDiff(slot)];
      const playStyle = slot.startsWith('SP') ? 0 : 1;
      const key = `${songId}|${diff}|${playStyle}`;
      const value = { title: row.title, slot, exScore, lamp };
      const previous = tsvIndex.get(key);
      tsvIndex.set(key, previous ? betterTsvCell(previous, value) : value);
    }
  }
  if (played === 0) throw new Error('tracker.tsv has no played charts');

  const dbRows = await fetchHist(iidxId);
  const counts = emptyCounts();
  const deletions: ScoreSyncPlan['deletions'] = [];
  const ambiguousSamples: ScoreSyncPlan['ambiguousSamples'] = [];
  const songsById = await getSongsById();

  for (const db of dbRows) {
    const dbExScore = dbValue(db.ex_score);
    const dbLamp = dbValue(db.lamp);
    if (db.played_version === -10) {
      counts.dbr++;
      continue;
    }
    if (db.played_version > 0) {
      counts['ac-on-inf']++;
      deletions.push({
        scoreId: null,
        histIndex: db.histIndex, songId: db.song_id, playStyle: db.play_style, diff: db.diff, playedVersion: db.played_version,
        category: 'ac-on-inf',
        title: songsById.get(db.song_id)?.title ?? null,
        slot: null,
        dateKst: db.date_kst,
        db: { exScore: dbExScore, lamp: dbLamp, playedVersion: db.played_version, playStyle: db.play_style, diff: db.diff },
        tsv: null,
      });
      continue;
    }
    if (db.played_version !== 0) {
      counts['other-version']++;
      continue;
    }
    const key = `${db.song_id}|${db.diff}|${db.play_style}`;
    const tsv = tsvIndex.get(key);
    if (!tsv) {
      counts['not-in-tsv']++;
      continue;
    }
    if (tsv.exScore <= 0 && (tsv.lamp === 0 || tsv.lamp === null)) {
      counts['noplay-but-db']++;
      deletions.push({
        scoreId: null,
        histIndex: db.histIndex, songId: db.song_id, playStyle: db.play_style, diff: db.diff, playedVersion: db.played_version,
        category: 'noplay-but-db',
        title: tsv.title,
        slot: tsv.slot,
        dateKst: db.date_kst,
        db: { exScore: dbExScore, lamp: dbLamp, playedVersion: db.played_version, playStyle: db.play_style, diff: db.diff },
        tsv: { exScore: tsv.exScore, lamp: tsv.lamp },
      });
      continue;
    }
    if (tsv.exScore <= 0 && tsv.lamp !== null && tsv.lamp > 0) {
      counts.ambiguous++;
      if (ambiguousSamples.length < 20) ambiguousSamples.push({ title: tsv.title, slot: tsv.slot, exScore: tsv.exScore, lamp: tsv.lamp });
      continue;
    }
    // TSV의 exScore와 lamp는 게임이 기억하는 역대 최고값이므로 hist 행 값과 비교한다.
    if (dbExScore > tsv.exScore || (tsv.lamp !== null && dbLamp > tsv.lamp)) {
      counts['exceeds-tsv']++;
      deletions.push({
        scoreId: null,
        histIndex: db.histIndex, songId: db.song_id, playStyle: db.play_style, diff: db.diff, playedVersion: db.played_version,
        category: 'exceeds-tsv',
        title: tsv.title,
        slot: tsv.slot,
        dateKst: db.date_kst,
        db: { exScore: dbExScore, lamp: dbLamp, playedVersion: db.played_version, playStyle: db.play_style, diff: db.diff },
        tsv: { exScore: tsv.exScore, lamp: tsv.lamp },
      });
      continue;
    }
    counts.ok++;
  }

  // 비율 가드는 「tsv 가 오염/부분 파일인가」를 보는 장치라, tsv 판정으로 나온 삭제분만 INF 행 수와 비교한다.
  //   ac-on-inf 는 tsv 와 무관한 오류라 분자에 넣으면 가드가 흐려진다.
  const infRows = dbRows.filter((row) => row.played_version === 0).length;
  const tsvJudgedDeletions = counts['noplay-but-db'] + counts['exceeds-tsv'];
  const blockedByRatio = !opts?.force && infRows > 0 && tsvJudgedDeletions > infRows * MAX_DELETE_RATIO;
  return {
    iidxId,
    counts,
    tsvStats: { charts, played, unmatched },
    deletions,
    ambiguousSamples,
    blockedByRatio,
    sql: null,
  };
}
