import { app } from 'electron';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { readTsv } from './tsv';
import { findProcessId } from './memory';
import { mergeAccountMeta, type AccountMeta, type AccountSnapshotRequest, type AccountSnapshotResult } from '../shared/account';
import type { InfinitasSessionState } from '../shared/session';
import type { TsvReadResult } from '../shared/types';
import type { PlayCsvReadResult } from '../shared/uploadSnapshot';
import type { PlayDetail } from '../shared/uploadSnapshot';

const IIDX_RE = /^[A-Z]\d{12}$/;
// 기존 스냅샷 대비 허용하는 최소 행 수 비율
const MIN_ROW_RATIO = 0.5;
function usersRoot(): string { return join(app.getPath('userData'), 'users'); }
function accountDir(iidxId: string): string { return join(usersRoot(), iidxId); }
function viewerStatePath(): string { return join(app.getPath('userData'), 'viewer-state.json'); }

async function writeMeta(iidxId: string, profile: AccountSnapshotRequest['profile']): Promise<void> {
  let prev: Partial<AccountMeta> = {};
  try { prev = JSON.parse(await fsp.readFile(join(accountDir(iidxId), 'meta.json'), 'utf8')) as Partial<AccountMeta>; } catch { /* 신규/손상 메타 */ }
  const next = mergeAccountMeta(iidxId, prev, profile, Date.now());
  await fsp.writeFile(join(accountDir(iidxId), 'meta.json'), JSON.stringify(next), 'utf8');
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
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(deps.sourceTsvPath, tmp);
    const st2 = await fsp.stat(deps.sourceTsvPath);
    if (st2.mtimeMs !== st.mtimeMs || st2.size !== st.size) { await fsp.unlink(tmp).catch(() => {}); return { ok: false, reason: 'source-changed' }; }
    const s2 = deps.getSession();
    if (s2.pid == null || s2.generation !== req.expect.generation) { await fsp.unlink(tmp).catch(() => {}); return { ok: false, reason: 'generation-changed' }; }
    if (s2.pid !== req.expect.pid) { await fsp.unlink(tmp).catch(() => {}); return { ok: false, reason: 'pid-mismatch' }; }
    // rename 직전 라이브 PID 최종 확인 — 폴링 캐시(getSession)가 아직 못 본 A→B 전환을 즉시 차단.
    //   tmp 는 위 st2 검증을 이미 통과한 안정 사본이므로 재복사하지 않는다.
    if (findProcessId('bm2dx.exe') !== req.expect.pid) { await fsp.unlink(tmp).catch(() => {}); return { ok: false, reason: 'pid-mismatch' }; }
    try {
      await fsp.stat(finalPath);
      try {
        const [existingText, newText] = await Promise.all([
          fsp.readFile(finalPath, 'utf8'),
          fsp.readFile(tmp, 'utf8'),
        ]);
        const countRows = (text: string): number => text.split(/\r?\n/).filter((l) => l.length > 0).length;
        const existingRows = countRows(existingText);
        const newRows = countRows(newText);
        if (newRows < existingRows * MIN_ROW_RATIO) {
          console.warn('[account:snapshot] 행 수 부족:', { existingRows, newRows });
          await fsp.unlink(tmp).catch(() => {});
          return { ok: false, reason: 'source-empty' };
        }
      } catch (e) {
        console.warn('[account:snapshot] 행 수 검사 실패:', e);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[account:snapshot] 행 수 검사 실패:', e);
      }
    }
    await fsp.rename(tmp, finalPath); await writeMeta(req.iidxId, req.profile);
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
    try { const meta = JSON.parse(await fsp.readFile(join(accountDir(entry.name), 'meta.json'), 'utf8')) as Partial<AccountMeta>; await fsp.stat(join(accountDir(entry.name), 'tracker.tsv')); if (meta.iidxId !== entry.name) continue; out.push({ iidxId: entry.name, djName: meta.djName ?? null, lastUpdatedAt: meta.lastUpdatedAt ?? 0, spRank: meta.spRank, dpRank: meta.dpRank, spRankInt: meta.spRankInt, dpRankInt: meta.dpRankInt, spRadar: meta.spRadar, dpRadar: meta.dpRadar, profileCapturedAt: meta.profileCapturedAt }); } catch { /* 유효하지 않은 계정은 제외 */ }
  }
  return out.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
}

export async function readAccountTsv(iidxId: string): Promise<TsvReadResult> {
  if (!IIDX_RE.test(iidxId)) return { ok: false, error: 'invalid id' };
  try { const r = await readTsv(join(accountDir(iidxId), 'tracker.tsv')); return { ok: true, rows: r.rows, headerColCount: r.headerCols.length, mtime: r.mtime }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, rows: [], headerColCount: 0, mtime: 0 }; return { ok: false, error: (e as Error).message }; }
}
export async function getLastSelected(): Promise<string | null> { try { const x = JSON.parse(await fsp.readFile(viewerStatePath(), 'utf8')) as { selectedViewerId?: string | null }; return x.selectedViewerId ?? null; } catch { return null; } }
export async function setLastSelected(iidxId: string | null): Promise<void> { const tmp = viewerStatePath() + '.tmp'; await fsp.writeFile(tmp, JSON.stringify({ selectedViewerId: iidxId }), 'utf8'); await fsp.rename(tmp, viewerStatePath()); }

// 계정 CSV 접근은 기존 계정 저장소에 모은다.
export function accountPlayCsvPath(iidxId: string): string | null {
  return IIDX_RE.test(iidxId) ? join(accountDir(iidxId), 'plays.csv') : null;
}
// 플레이 상세(등급별 FAST/SLOW · 레인별 카운터). plays.csv 와 같은 폴더의 JSON Lines. 업로드 대상이 아니다.
export function accountPlayDetailPath(iidxId: string): string | null {
  return IIDX_RE.test(iidxId) ? join(accountDir(iidxId), 'plays_detail.jsonl') : null;
}

function isPlayDetail(value: unknown): value is PlayDetail {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  const counts = (v: unknown, length: number): v is number[] => Array.isArray(v) && v.length === length && v.every(count);
  const side = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    const s = v as Record<string, unknown>;
    const fs = s.fs === null || (s.fs !== null && typeof s.fs === 'object'
      && ['fast_great', 'fast_good', 'slow_great', 'slow_good'].every(k => count((s.fs as Record<string, unknown>)[k])));
    const lanes = Array.isArray(s.lanes) && s.lanes.length === 8 && s.lanes.every(row => counts(row, 6));
    const laneFs = s.lane_fs === null || (Array.isArray(s.lane_fs) && s.lane_fs.length === 8 && s.lane_fs.every(row => counts(row, 4)));
    if (typeof s.fs_ok !== 'boolean' || typeof s.lanes_ok !== 'boolean' || !count(s.fs_unresolved)
      || !count(s.lane_fs_unresolved) || !lanes || !fs || !laneFs) return false;
    return d.complete !== false || (s.fs === null && s.lane_fs === null);
  };
  return d.v === 1 && typeof d.timestamp === 'string' && typeof d.complete === 'boolean'
    && count(d.samples) && typeof d.dt_ms === 'number' && Number.isFinite(d.dt_ms) && d.dt_ms >= 0
    && side(d.p1) && side(d.p2);
}

export async function readAccountPlayCsv(iidxId: string): Promise<PlayCsvReadResult> {
  const path = accountPlayCsvPath(iidxId);
  if (!path) return { ok: false, error: 'invalid id' };
  try {
    const csv = await fsp.readFile(path, 'utf8');
    const detailsPath = accountPlayDetailPath(iidxId)!;
    let details: PlayDetail[] = [];
    try {
      const text = await fsp.readFile(detailsPath, 'utf8');
      const byTimestamp = new Map<string, PlayDetail>();
      for (const line of text.split(/\r?\n/)) {
        try {
          const value: unknown = JSON.parse(line);
          if (isPlayDetail(value)) byTimestamp.set(value.timestamp, value);
        } catch { /* invalid or incomplete JSONL line */ }
      }
      details = [...byTimestamp.values()];
    } catch { /* detail data is optional and must not affect CSV reads */ }
    return details.length > 0 ? { ok: true, csv, details } : { ok: true, csv };
  }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, found: false, csv: '' };
    return { ok: false, error: (e as Error).message };
  }
}
