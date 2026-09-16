// 진단 로그(diagLog) 디스크 영속화 — renderer 의 addDiagLine 이 IPC 로 보낸 줄을
// userData/logs/diag.log 에 append. 실패해도 앱 동작에 영향 주면 안 된다(항상 삼킴).
import { app } from 'electron';
import { promises as fsp } from 'fs';
import { join } from 'path';

const MAX_BYTES = 2 * 1024 * 1024; // 2MB — 넘으면 diag.log -> diag.prev.log 1회 회전(2세대만 유지)

function logDir(): string {
  return join(app.getPath('userData'), 'logs');
}

export function diagLogPath(): string {
  return join(logDir(), 'diag.log');
}

function diagPrevLogPath(): string {
  return join(logDir(), 'diag.prev.log');
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, len = 2): string => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const st = await fsp.stat(diagLogPath());
    if (st.size <= MAX_BYTES) return;
    await fsp.rm(diagPrevLogPath(), { force: true });
    await fsp.rename(diagLogPath(), diagPrevLogPath());
  } catch {
    // 파일 없음(최초 실행) 등은 무시 — 회전 스킵하고 계속 진행
  }
}

let writeChain: Promise<void> = Promise.resolve();

async function appendNow(line: string): Promise<void> {
  try {
    await fsp.mkdir(logDir(), { recursive: true });
    await rotateIfNeeded();
    await fsp.appendFile(diagLogPath(), `[${timestamp()}] ${line}\n`, 'utf8');
  } catch (e) {
    console.warn('[diagLog] 파일 기록 실패(무시):', (e as Error).message);
  }
}

// fire-and-forget. 실패해도 절대 throw 하지 않는다. 호출 순서대로 직렬 기록한다.
export function appendDiagLine(line: string): void {
  if (!line) return;
  writeChain = writeChain.then(() => appendNow(line));
}

// 앱 시작 마커 — main 의 app.whenReady() 에서 1회 호출.
export function appStartMarkerLine(version: string): string {
  return `=== app start v${version} ${timestamp()} ===`;
}
