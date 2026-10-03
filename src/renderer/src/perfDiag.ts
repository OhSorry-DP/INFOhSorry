type DiagWindow = Window & { infohsorry?: { diag?: { append?: (line: string) => void } } };
type DiagValue = string | number | boolean | null | undefined;
export type PerfContextRecord = { kind: 'perf'; monoMs: number; seq: number; phase: string; calc?: string; fields: Record<string, string | number | boolean | null> };
export type LongTaskContextRecord = { kind: 'longtask'; startMonoMs: number; endMonoMs: number; durMs: number; name: string; attribution: Array<{ containerType: string; containerName: string; containerSrc: string }> };
export type StallContextRecord = PerfContextRecord | LongTaskContextRecord;

const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const seqs = new Map<string, number>();
const accountAliases = new Map<string, string>();
let nextAccountAlias = 1;
const perfRing: PerfContextRecord[] = [];
const PERF_LIMIT = 64;

function append(fields: string): void {
  try { (window as DiagWindow).infohsorry?.diag?.append?.(`PERF ${fields}`); } catch { /* diagnostics must never affect rendering */ }
}
function safeFields(fields: Record<string, DiagValue>): Record<string, string | number | boolean | null> {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || /^(account|accountId|iidxId|rows|payload|token)$/i.test(key)) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, 160);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) clean[key] = value;
  }
  return clean;
}
function remember(record: PerfContextRecord): void {
  perfRing.push(record);
  if (perfRing.length > PERF_LIMIT) perfRing.splice(0, perfRing.length - PERF_LIMIT);
}
function stringify(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields).map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`).join(' ');
}
export function perfScopeId(accountId: string | null): string {
  if (!accountId) return 'none';
  let alias = accountAliases.get(accountId);
  if (!alias) { alias = `acct${nextAccountAlias++}`; accountAliases.set(accountId, alias); }
  return alias;
}

export function perfEvent(event: string, fields: Record<string, DiagValue> = {}): void {
  const monoMs = performance.now();
  const clean = safeFields(fields);
  const seq = (seqs.get(`event:${event}`) ?? 0) + 1;
  seqs.set(`event:${event}`, seq);
  remember({ kind: 'perf', monoMs, seq, phase: 'event', calc: event.slice(0, 80), fields: clean });
  const suffix = stringify(clean);
  append(`run=${run} event=${event}${suffix ? ` ${suffix}` : ''}`);
}

export function beginPerf(calc: string, rowsRev: number, epoch: number, accountId: string | null, extra: Record<string, DiagValue> = {}): { seq: number; start: number } {
  const seq = (seqs.get(calc) ?? 0) + 1;
  seqs.set(calc, seq);
  const start = performance.now();
  const fields = safeFields({ rowsRev, scopeId: perfScopeId(accountId), epoch, ...extra });
  remember({ kind: 'perf', monoMs: start, seq, phase: 'begin', calc: calc.slice(0, 80), fields });
  append(`run=${run} phase=begin calc=${calc} seq=${seq} wallMs=${Date.now()} monoMs=${start.toFixed(3)} ${stringify(fields)}`);
  return { seq, start };
}

export function endPerf(calc: string, span: { seq: number; start: number }, rowsRev: number, epoch: number, accountId: string | null, status: 'ok' | 'error', extra: Record<string, DiagValue> = {}): void {
  const monoMs = performance.now();
  const fields = safeFields({ durMs: (monoMs - span.start).toFixed(3), rowsRev, scopeId: perfScopeId(accountId), epoch, status, ...extra });
  remember({ kind: 'perf', monoMs, seq: span.seq, phase: 'end', calc: calc.slice(0, 80), fields });
  append(`run=${run} phase=end calc=${calc} seq=${span.seq} wallMs=${Date.now()} monoMs=${monoMs.toFixed(3)} ${stringify(fields)}`);
}

export function recordLongTask(record: LongTaskContextRecord): void {
  longTaskRing.push({ ...record, attribution: record.attribution.slice(0, 8).map((item) => ({
    containerType: item.containerType.slice(0, 40), containerName: item.containerName.slice(0, 80), containerSrc: item.containerSrc.slice(0, 160),
  })) });
  if (longTaskRing.length > LONGTASK_LIMIT) longTaskRing.splice(0, longTaskRing.length - LONGTASK_LIMIT);
}
const longTaskRing: LongTaskContextRecord[] = [];
const LONGTASK_LIMIT = 32;
export function snapshotPerfContext(startMs: number, endMs: number): StallContextRecord[] {
  const perf = perfRing.filter((record) => record.monoMs >= startMs && record.monoMs <= endMs).map((record) => ({ ...record, fields: { ...record.fields } }));
  const tasks = longTaskRing.filter((record) => record.startMonoMs <= endMs && record.endMonoMs >= startMs)
    .map((record) => ({ ...record, attribution: record.attribution.map((item) => ({ ...item })) }));
  return [...perf, ...tasks].sort((a, b) => (a.kind === 'perf' ? a.monoMs : a.startMonoMs) - (b.kind === 'perf' ? b.monoMs : b.startMonoMs));
}
export function flushStallContext(startMs: number, endMs: number, stallId = 'unknown'): void {
  const records = snapshotPerfContext(startMs, endMs);
  const perf = records.filter((record): record is PerfContextRecord => record.kind === 'perf').slice(-8);
  const tasks = records.filter((record): record is LongTaskContextRecord => record.kind === 'longtask').slice(-8);
  for (const record of perf) {
    append(`run=${run} event=renderer-stall-context stallId=${stallId} kind=perf monoMs=${record.monoMs.toFixed(3)} phase=${record.phase} seq=${record.seq}${record.calc ? ` calc=${record.calc}` : ''} ${stringify(record.fields)}`);
  }
  for (const record of tasks) {
    const attribution = record.attribution.map((item) => `${item.containerType}:${item.containerName}:${item.containerSrc}`).join(',') || 'unknown';
    append(`run=${run} event=renderer-stall-context stallId=${stallId} kind=longtask startMonoMs=${record.startMonoMs.toFixed(3)} durMs=${record.durMs.toFixed(3)} source=${attribution}`);
  }
}
