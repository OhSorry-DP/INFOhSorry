// 포터블 exe 자동 다운로드 + 실행 (v0.0.19 / v3.3.5)
//
// 흐름:
//   1. renderer 가 download(url, fileName) 호출
//   2. main 이 net.request 로 다운로드, chunk 단위로 progress 이벤트 전송
//   3. userData/updates/{fileName} 에 저장 (다음 실행 때 정리)
//   4. 완료 시 파일 경로 반환
//   5. renderer 가 run(path) 호출 → spawn detached + app.quit()
import { app, net, BrowserWindow } from 'electron';
import { promises as fsp, createWriteStream, existsSync } from 'fs';
import { join, dirname } from 'path';
import { spawn } from 'child_process';

function updatesDir(): string {
  return join(app.getPath('userData'), 'updates');
}

// 이전 다운로드 정리 — 부팅 시 호출
export async function cleanupOldUpdates(): Promise<void> {
  const dir = updatesDir();
  if (!existsSync(dir)) return;
  try {
    const files = await fsp.readdir(dir);
    for (const f of files) {
      try {
        await fsp.unlink(join(dir, f));
      } catch {}
    }
  } catch {}
}

// 다운로드 — 진행률은 'portable:progress' IPC 이벤트로 sender 에 보냄
export async function downloadPortable(url: string, fileName: string, sender: Electron.WebContents): Promise<string> {
  const dir = updatesDir();
  await fsp.mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);

  return new Promise<string>((resolve, reject) => {
    const request = net.request(url);
    let total = 0;
    let downloaded = 0;
    let writer: ReturnType<typeof createWriteStream> | null = null;
    let lastEmit = 0;

    request.on('response', (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // GitHub release asset 은 redirect 됨 — net 모듈은 자동 follow 함, 보통 도달 X
        const loc = response.headers['location'];
        const target = Array.isArray(loc) ? loc[0] : loc;
        if (target) {
          request.abort();
          downloadPortable(target, fileName, sender).then(resolve).catch(reject);
        }
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const contentLength = response.headers['content-length'];
      const cl = Array.isArray(contentLength) ? contentLength[0] : contentLength;
      total = cl ? parseInt(cl as string, 10) : 0;
      writer = createWriteStream(filePath);

      response.on('data', (chunk: Buffer) => {
        writer!.write(chunk);
        downloaded += chunk.byteLength;
        // 100ms 마다 progress 보냄 (renderer 부담 줄임)
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          if (!sender.isDestroyed()) {
            sender.send('portable:progress', { downloaded, total });
          }
        }
      });
      response.on('end', () => {
        writer!.end(() => {
          if (!sender.isDestroyed()) {
            sender.send('portable:progress', { downloaded, total });
          }
          resolve(filePath);
        });
      });
      response.on('error', (e) => {
        writer?.end();
        reject(e);
      });
    });
    request.on('error', reject);
    request.end();
  });
}

// 다운로드된 portable exe 실행 + 현재 앱 종료
export function runPortable(filePath: string): { ok: boolean; error?: string } {
  if (!existsSync(filePath)) return { ok: false, error: '파일 없음' };
  try {
    const child = spawn(filePath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    // 현재 앱 종료 — 새 portable 이 시작될 시간 잠시 주고 quit
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
