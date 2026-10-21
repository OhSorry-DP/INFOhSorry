export const DBR_HISTORY_COLS = Object.freeze([
  'song_id', 'diff', 'lamp', 'ex_score', 'played_version', 'date',
  'date_kst', 'play_style', 'bp', 'note_count', 'score_id',
] as const);

export type DbrHistoryRow = [number, number, number | null, number | null, number, string,
  string, number, number | null, number | null, string | number];
export type DbrHistory = {
  schemaVersion: 1;
  complete: boolean;
  revision: number;
  cols: readonly string[];
  rows: DbrHistoryRow[];
};

function fail(message: string): never { throw new TypeError(`DBR history: ${message}`); }
function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) fail(`${name} must be a safe integer`);
  return value as number;
}
function scoreId(value: unknown): bigint {
  if (typeof value === 'number') integer(value, 'score_id');
  else if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) fail('invalid score_id');
  const id = BigInt(value as string | number);
  if (id <= 0n || id > 9223372036854775807n) fail('score_id outside positive SQL bigint');
  return id;
}
function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('invalid date_kst');
  return value;
}
function instant(value: unknown): bigint {
  const m = typeof value === 'string' && value.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/,
  );
  if (!m) fail('date requires a timestamp with timezone (up to 6 fractional digits)');
  day(m[1]);
  if (+m[2] > 23 || +m[3] > 59 || +m[4] > 59) fail('invalid timestamp time');
  const zone = m[6] === 'Z' ? 'Z' : m[6].length === 3 ? `${m[6]}:00`
    : m[6].includes(':') ? m[6] : `${m[6].slice(0, 3)}:${m[6].slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${zone}`);
  if (!Number.isFinite(ms)) fail('invalid timestamp timezone');
  return BigInt(ms) * 1000n + BigInt((m[5] || '').padEnd(6, '0'));
}
function naturalKey(r: DbrHistoryRow): string { return JSON.stringify([r[0], r[1], r[4], r[7], r[6]]); }
function chartKey(r: DbrHistoryRow): string { return JSON.stringify([r[0], r[1], r[4], r[7]]); }
function checkRow(value: unknown): asserts value is DbrHistoryRow {
  if (!Array.isArray(value) || value.length !== DBR_HISTORY_COLS.length) fail('row must have exactly 11 columns');
  const r = value as DbrHistoryRow;
  for (const i of [0, 1, 4, 7] as const) integer(r[i], DBR_HISTORY_COLS[i]);
  if (r[4] !== -10 || r[7] !== 1) fail('row must be DBR (-10, style 1)');
  for (const i of [2, 3, 8, 9] as const) if (r[i] !== null) integer(r[i], DBR_HISTORY_COLS[i]);
  const time = instant(r[5]);
  day(r[6]);
  const kst = new Date(Number(time / 1000n) + 9 * 3600000).toISOString().slice(0, 10);
  if (kst !== r[6]) fail('date_kst does not match date in KST');
  scoreId(r[10]);
}
function metadata(complete: unknown, revision: unknown): void {
  if (typeof complete !== 'boolean') fail('complete must be boolean');
  integer(revision, 'revision');
  if ((revision as number) < 0) fail('revision must be nonnegative');
}

/** 저장 계약을 검사한다. 유효하면 true, 잘못된 계약이면 TypeError. */
export function validateDbrHistory(history: unknown): true {
  if (!history || typeof history !== 'object' || (history as DbrHistory).schemaVersion !== 1) fail('unsupported schemaVersion');
  const h = history as DbrHistory;
  metadata(h.complete, h.revision);
  if (!Array.isArray(h.cols) || h.cols.length !== DBR_HISTORY_COLS.length
    || h.cols.some((col, i) => col !== DBR_HISTORY_COLS[i])) fail('cols order mismatch');
  if (!Array.isArray(h.rows)) fail('rows must be an array');
  const keys = new Set<string>(), ids = new Set<string>();
  for (const r of h.rows) {
    checkRow(r);
    const key = naturalKey(r), id = scoreId(r[10]).toString();
    if (keys.has(key)) fail('duplicate natural key');
    if (ids.has(id)) fail('duplicate score_id');
    keys.add(key); ids.add(id);
  }
  return true;
}

function visible(history: DbrHistory | null | undefined): DbrHistoryRow[] {
  if (history == null) return [];
  validateDbrHistory(history);
  return history.rows.filter(r => (r[3] ?? 0) > 0);
}
function result<T>(history: DbrHistory | null | undefined, values: T[], field: string) {
  const complete = history?.complete === true;
  return { status: !complete ? 'incomplete' as const : values.length ? 'ready' as const : 'empty' as const,
    complete, [field]: values };
}

/** make_recent_dates(p_dbr=true, p_play_style=1) 대응. */
export function getDbrRecentDates(history: DbrHistory | null | undefined) {
  const counts = new Map<string, number>();
  for (const r of visible(history)) counts.set(r[6], (counts.get(r[6]) ?? 0) + 1);
  const dates = [...counts].sort(([a], [b]) => b.localeCompare(a))
    .map(([date_kst, row_count]) => ({ date_kst, row_count }));
  return result(history, dates, 'dates');
}

/** make_recent_data의 DBR 부분. 직전값이 없으면 SQL처럼 null. */
export function getDbrRecentData(history: DbrHistory | null | undefined, dateKst: string) {
  day(dateKst);
  const rows = visible(history);
  const groups = new Map<string, { row: DbrHistoryRow; time: bigint }[]>();
  for (const r of rows) {
    const key = chartKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ row: r, time: instant(r[5]) });
  }
  for (const group of groups.values()) group.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  const output = rows.filter(r => r[6] === dateKst)
    .sort((a, b) => scoreId(a[10]) < scoreId(b[10]) ? -1 : scoreId(a[10]) > scoreId(b[10]) ? 1 : 0)
    .map(r => {
      const time = instant(r[5]), group = groups.get(chartKey(r))!;
      let low = 0, high = group.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (group[mid].time < time) low = mid + 1;
        else high = mid;
      }
      const prev = group[low - 1]?.row;
      return { ...Object.fromEntries(DBR_HISTORY_COLS.map((col, i) => [col, r[i]])),
        prev_lamp: prev?.[2] ?? null, prev_ex_score: prev?.[3] ?? null,
        prev_played_version: prev?.[4] ?? null, prev_bp: prev?.[8] ?? null };
    });
  return result(history, output, 'rows');
}
