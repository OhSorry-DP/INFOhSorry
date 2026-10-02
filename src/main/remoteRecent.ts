type MappedRow = {
  song_id: string | number;
  diff: number;
  play_style: number;
  lamp: number;
  ex_score: number;
  bp: number | null;
  note_count: number | null;
};

type CdnRow = { song_id: string | number; diff: number; played_version?: number; lamp?: number; ex_score?: number };
type CdnProfile = { dp?: CdnRow[]; sp?: CdnRow[] } | null;
type OutputRow = [string | number, number, number, number, 0, string, string, 0 | 1, number | null, number | null];

export function buildRemoteRecentRows(mappedRows: MappedRow[], cdn: CdnProfile, nowIso: string): OutputRow[] {
  const dateKst = new Date(Date.parse(nowIso) + 9 * 3600000).toISOString().slice(0, 10);
  const baseline = new Map<string, { lamp: number; ex: number }>();
  for (const [playStyle, rows] of [[1, cdn?.dp], [0, cdn?.sp]] as const) {
    for (const row of rows ?? []) {
      if ((row.played_version ?? 0) !== 0) continue;
      const key = `${String(row.song_id)}|${row.diff}|0|${playStyle}`;
      const old = baseline.get(key) ?? { lamp: -Infinity, ex: -Infinity };
      baseline.set(key, { lamp: Number.isFinite(row.lamp) ? Math.max(old.lamp, row.lamp!) : old.lamp,
        ex: Number.isFinite(row.ex_score) ? Math.max(old.ex, row.ex_score!) : old.ex });
    }
  }
  const merged = new Map<string, { songId: string | number; diff: number; playStyle: 0 | 1; lamp: number; ex: number; bp: number | null; noteCount: number | null }>();
  for (const row of mappedRows) {
    if (row.song_id === '' || row.song_id == null || ![0, 1].includes(row.play_style) ||
        !Number.isFinite(row.diff) || row.diff < 0 || row.diff > 4 ||
        !Number.isFinite(row.lamp) || !Number.isFinite(row.ex_score) || row.ex_score <= 0) continue;
    const playStyle = row.play_style as 0 | 1;
    const key = `${String(row.song_id)}|${row.diff}|0|${playStyle}`;
    const prior = merged.get(key);
    const old = baseline.get(key) ?? { lamp: -Infinity, ex: -Infinity };
    const lamp = Math.max(old.lamp, row.lamp, prior?.lamp ?? -Infinity);
    const ex = Math.max(old.ex, row.ex_score, prior?.ex ?? -Infinity);
    merged.set(key, { songId: row.song_id, diff: row.diff, playStyle, lamp, ex,
      bp: row.bp, noteCount: row.note_count });
  }
  return [...merged.entries()].filter(([key, row]) => {
    const old = baseline.get(key) ?? { lamp: -Infinity, ex: -Infinity };
    return row.lamp > old.lamp || row.ex > old.ex;
  }).map(([, row]) => [row.songId, row.diff, row.lamp, row.ex, 0, nowIso, dateKst, row.playStyle, row.bp, row.noteCount]);
}
