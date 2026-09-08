import { app } from 'electron';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { readTsv } from './tsv';
import { findProcessId } from './memory';
import type { AccountMeta, AccountSnapshotRequest, AccountSnapshotResult } from '../shared/account';
import type { InfinitasSessionState } from '../shared/session';
import type { TsvReadResult } from '../shared/types';

const IIDX_RE = /^[A-Z]\d{12}$/;
function usersRoot(): string { return join(app.getPath('userData'), 'users'); }
function accountDir(iidxId: string): string { return join(usersRoot(), iidxId); }
function viewerStatePath(): string { return join(app.getPath('userData'), 'viewer-state.json'); }

async function writeMeta(iidxId: string, djName: string | null): Promise<void> {
  let prev: Partial<AccountMeta> = {};
  try { prev = JSON.parse(await fsp.readFile(join(accountDir(iidxId), 'meta.json'), 'utf8')) as Partial<AccountMeta>; } catch { /* 신규/손상 메타 */ }
  await fsp.writeFile(join(accountDir(iidxId), 'meta.json'), JSON.stringify({ iidxId, djName: djName ?? prev.djName ?? null, lastUpdatedAt: Date.now() }), 'utf8');
}

export async function snapshotTsv(req: AccountSnapshotRequest, deps: { sourceTsvPath: string; getSession: () => InfinitasSessionState }): Promise<AccountSnapshotResult> {
  if (!IIDX_RE.test(req.iidxId)) return { ok: false, reason: 'id-format' };
  const s = deps.getSession();
  if (s.pid == null) return { ok: false, reason: 'no-live-session' };
  if (s.generation !== req.expect.generation) return { ok: false, reason: 'generation-changed' };
  if (s.pid !== req.expect.pid) return { ok: false, reason: 'pid-mismatch' };
  if (findProcessId('bm2dx.exe') !== req.expect.pid) return { ok: false, reason: 'pid-mismatch' };
  const dir = accountDir(req.iidxId); const tmp = join(dir, 'tracker.tsv.tmp'); const finalPath = join(dir, 'tracker.tsv');
  try {
    const st = await fsp.stat(deps.sourceTsvPath);
    if (st.size === 0) return { ok: false, reason: 'source-empty' };
    if (st.mtimeMs !== req.expect.mtime || st.size !== req.expect.size) return { ok: false, reason: 'source-changed' };
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(deps.sourceTsvPath, tmp);
    const st2 = await fsp.stat(deps.sourceTsvPath);
    if (st2.mtimeMs !== req.expect.mtime || st2.size !== req.expect.size) { await fsp.unlink(tmp).catch(() => {}); return { ok: false, reason: 'source-changed' }; }
    const s2 = deps.getSession();
    if (s2.pid == null || s2.generation !== req.expect.generation) { await fsp.unlink(tmp).catch(() => {}); return { ok: false, reason: 'generation-changed' }; }
    if (s2.pid !== req.expect.pid) { await fsp.unlink(tmp).catch(() => {}); return { ok: false, reason: 'pid-mismatch' }; }
    // rename 직전 라이브 PID 최종 확인 — 폴링 캐시(getSession)가 아직 못 본 A→B 전환을 즉시 차단.
    //   tmp 는 위 st2 검증을 이미 통과한 안정 사본이므로 재복사하지 않는다.
    if (findProcessId('bm2dx.exe') !== req.expect.pid) { await fsp.unlink(tmp).catch(() => {}); return { ok: false, reason: 'pid-mismatch' }; }
    await fsp.rename(tmp, finalPath); await writeMeta(req.iidxId, req.djName);
    return { ok: true, iidxId: req.iidxId, tsvMtime: st.mtimeMs, generation: s.generation };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'source-empty' };
    await fsp.unlink(tmp).catch(() => {}); console.warn('[account:snapshot] write-failed', e);
    return { ok: false, reason: 'write-failed' };
  }
}

export async function listAccounts(): Promise<AccountMeta[]> {
  let entries; try { entries = await fsp.readdir(usersRoot(), { withFileTypes: true }); } catch { return []; }
  const out: AccountMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !IIDX_RE.test(entry.name)) continue;
    try { const meta = JSON.parse(await fsp.readFile(join(accountDir(entry.name), 'meta.json'), 'utf8')) as Partial<AccountMeta>; await fsp.stat(join(accountDir(entry.name), 'tracker.tsv')); if (meta.iidxId !== entry.name) continue; out.push({ iidxId: entry.name, djName: meta.djName ?? null, lastUpdatedAt: meta.lastUpdatedAt ?? 0 }); } catch { /* 유효하지 않은 계정은 제외 */ }
  }
  return out.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
}

export async function readAccountTsv(iidxId: string): Promise<TsvReadResult> {
  if (!IIDX_RE.test(iidxId)) return { ok: false, error: 'invalid id' };
  try { const r = await readTsv(join(accountDir(iidxId), 'tracker.tsv')); return { ok: true, rows: r.rows, headerColCount: r.headerCols.length, mtime: r.mtime }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, rows: [], headerColCount: 0, mtime: 0 }; return { ok: false, error: (e as Error).message }; }
}
export async function getLastSelected(): Promise<string | null> { try { const x = JSON.parse(await fsp.readFile(viewerStatePath(), 'utf8')) as { selectedViewerId?: string | null }; return x.selectedViewerId ?? null; } catch { return null; } }
export async function setLastSelected(iidxId: string | null): Promise<void> { const tmp = viewerStatePath() + '.tmp'; await fsp.writeFile(tmp, JSON.stringify({ selectedViewerId: iidxId }), 'utf8'); await fsp.rename(tmp, viewerStatePath()); }
