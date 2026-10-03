type DiagWindow = Window & { infohsorry?: { diag?: { append?: (line: string) => void } } };

const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const seqs = new Map<string, number>();
const accountAliases = new Map<string, string>();
let nextAccountAlias = 1;

function append(fields: string): void {
  try { (window as DiagWindow).infohsorry?.diag?.append?.(`PERF ${fields}`); } catch { /* 진단 기록 실패가 계산에 영향을 주면 안 된다. */ }
}

export function perfScopeId(accountId: string | null): string {
  if (!accountId) return 'none';
  let alias = accountAliases.get(accountId);
  if (!alias) { alias = `acct${nextAccountAlias++}`; accountAliases.set(accountId, alias); }
  return alias;
}

export function perfEvent(event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  const suffix = Object.entries(fields).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v === null ? 'null' : String(v)}`).join(' ');
  append(`run=${run} event=${event}${suffix ? ` ${suffix}` : ''}`);
}

export function beginPerf(calc: string, rowsRev: number, epoch: number, accountId: string | null): { seq: number; start: number } {
  const seq = (seqs.get(calc) ?? 0) + 1;
  seqs.set(calc, seq);
  const start = performance.now();
  append(`run=${run} phase=begin calc=${calc} seq=${seq} wallMs=${Date.now()} monoMs=${start.toFixed(3)} rowsRev=${rowsRev} scopeId=${perfScopeId(accountId)} epoch=${epoch}`);
  return { seq, start };
}

export function endPerf(calc: string, span: { seq: number; start: number }, rowsRev: number, epoch: number, accountId: string | null, status: 'ok' | 'error'): void {
  const monoMs = performance.now();
  append(`run=${run} phase=end calc=${calc} seq=${span.seq} wallMs=${Date.now()} monoMs=${monoMs.toFixed(3)} durMs=${(monoMs - span.start).toFixed(3)} rowsRev=${rowsRev} scopeId=${perfScopeId(accountId)} epoch=${epoch} status=${status}`);
}
