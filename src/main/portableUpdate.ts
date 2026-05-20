// 포터블 exe 자동 다운로드 + 실행 (v0.0.20+)
//
// 흐름:
//   1. renderer 가 download(url, fileName) 호출
//   2. main 이 net.request 로 다운로드, chunk 단위로 progress 이벤트 전송
//   3. **Windows 기본 다운로드 폴더** 에 저장 (사용자가 영구 보관 가능)
//   4. 동일 파일명 존재 시 (N) 접미사 자동 추가
//   5. 완료 시 파일 경로 반환
//   6. renderer 가 run(path) 호출 → spawn detached + app.quit()
import { app, net } from 'electron';
import { createWriteStream, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, parse, basename, dirname } from 'path';
import { spawn } from 'child_process';

// portable 파일명 패턴 — `ohSorryScoreINF-0.0.28-portable.exe` / `ohSorryScoreINF-0.0.28-portable (1).exe`
// uniqueFilePath 의 ` (N)` 접미사 / 대소문자 변형 모두 허용. 이 패턴 외 파일은 절대 건드리지 않음.
const PORTABLE_NAME_RE = /^ohSorryScoreINF-\d+\.\d+\.\d+-portable(?: \(\d+\))?\.exe$/i;

// 자기 실행 파일이 portable 패턴이면 같은 폴더의 다른 portable 들 정리. 설치형 / 패턴
// 비매칭 파일은 안 건드림. 0.0.21 의 cleanupOldUpdates 제거 결정을 portable-only 로 다시 활성화.
//
// 주의: electron-builder portable 은 실행 시 임시 폴더에 unpack 됨 → process.execPath 는 임시
// 폴더의 'app.exe' 등을 가리킴. 사용자가 더블클릭한 진짜 portable 파일 경로는
// process.env.PORTABLE_EXECUTABLE_FILE / PORTABLE_EXECUTABLE_DIR 로만 알 수 있음.
export function cleanupOldPortables(): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];
  try {
    const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (!portableFile || !portableDir) return { removed, errors }; // 설치형 / dev — skip
    const myName = basename(portableFile);
    if (!PORTABLE_NAME_RE.test(myName)) return { removed, errors }; // 다른 이름의 portable — skip
    for (const entry of readdirSync(portableDir)) {
      if (entry === myName) continue;
      if (!PORTABLE_NAME_RE.test(entry)) continue;
      try {
        unlinkSync(join(portableDir, entry));
        removed.push(entry);
      } catch (e) {
        errors.push(`${entry}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    errors.push((e as Error).message);
  }
  return { removed, errors };
}

function updatesDir(): string {
  // 사용자 Downloads 폴더 (Windows: %USERPROFILE%\Downloads)
  return app.getPath('downloads');
}

// 동일 파일명 있으면 " (1)", " (2)" 식으로 unique 생성
function uniqueFilePath(dir: string, fileName: string): string {
  const target = join(dir, fileName);
  if (!existsSync(target)) return target;
  const { name, ext } = parse(fileName);
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, `${name} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return target; // overwrite (1000번 다 중복은 사실상 X)
}

// 다운로드 — 진행률은 'portable:progress' IPC 이벤트로 sender 에 보냄
export async function downloadPortable(url: string, fileName: string, sender: Electron.WebContents): Promise<string> {
  // Downloads 폴더는 항상 존재 — mkdir 불필요
  const filePath = uniqueFilePath(updatesDir(), fileName);

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
      response.on('error', (e: Error) => {
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
