import { app } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { SNAPSHOT_VERSION, type UploadSnapshot } from '../shared/uploadSnapshot';

const RETRY_DELAYS_MS = [0, 100, 100];

export interface PendingResult {
  ok: boolean;
  error?: string;
  path?: string;
  bytes?: number;
}

function pendingDir(): string {
  return join(app.getPath('userData'), 'upload-pending');
}

function pendingPath(iidxId: string): string {
  return join(pendingDir(), `pending-${iidxId}.json`);
}

function retryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function savePending(snapshot: UploadSnapshot): Promise<PendingResult> {
  const finalPath = pendingPath(snapshot.iidxId);
  const tmpPath = `${finalPath}.tmp`;
  const body = JSON.stringify(snapshot);
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await delay(RETRY_DELAYS_MS[attempt]);
      await fs.mkdir(pendingDir(), { recursive: true });
      const fh = await fs.open(tmpPath, 'w');
      try {
        await fh.writeFile(body, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmpPath, finalPath);
      const bytes = Buffer.byteLength(body, 'utf8');
      console.log(`[upload] pending saved path=${finalPath} bytes=${bytes}`);
      return { ok: true, path: finalPath, bytes };
    } catch (e) {
      if (!retryable(e) || attempt === RETRY_DELAYS_MS.length - 1) {
        await fs.unlink(tmpPath).catch(() => undefined);
        const error = (e as Error).message;
        console.warn(`[upload] pending save failure path=${finalPath}: ${error}`);
        return { ok: false, error };
      }
    }
  }
  await fs.unlink(tmpPath).catch(() => undefined);
  return { ok: false, error: 'unreachable' };
}

export async function loadAllPending(): Promise<UploadSnapshot[]> {
  try {
    const dir = pendingDir();
    const names = await fs.readdir(dir);
    const snapshots: UploadSnapshot[] = [];
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        await fs.unlink(join(dir, name)).catch(() => undefined);
        continue;
      }
      if (!/^pending-[A-Z]\d{12}\.json$/.test(name)) continue;
      const filePath = join(dir, name);
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== SNAPSHOT_VERSION) {
          throw new Error('unsupported snapshot version');
        }
        snapshots.push(parsed as UploadSnapshot);
      } catch (e) {
        console.warn(`[upload] pending invalid; deleting path=${filePath}: ${(e as Error).message}`);
        await fs.unlink(filePath).catch(() => undefined);
      }
    }
    return snapshots;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.warn(`[upload] pending load failure: ${(e as Error).message}`);
    return [];
  }
}

export async function clearPending(iidxId: string): Promise<PendingResult> {
  const filePath = pendingPath(iidxId);
  try {
    await fs.unlink(filePath);
    return { ok: true, path: filePath };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, path: filePath };
    const error = (e as Error).message;
    console.warn(`[upload] pending clear failure path=${filePath}: ${error}`);
    return { ok: false, error, path: filePath };
  }
}
