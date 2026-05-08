// Reflux (olji/Reflux) 의 .exe 를 자동 다운로드 + spawn + tracker.tsv watch 까지 관리하는 매니저
//
// 흐름:
//   1. ensureInstalled()  — userData/Reflux/Reflux.exe 가 없으면 GitHub release 에서 다운로드
//   2. ensureConfig()     — config.ini 가 없으면 기본 설정으로 생성
//   3. start()            — child_process spawn + stdout 감시 (hook 됐는지 등)
//   4. watchTsv()         — tracker.tsv 변경 감지 → 콜백 호출
//   5. stop()             — child kill (앱 종료 시 호출)
//
// Reflux 는 daemon 으로 동작:
//   - INFINITAS 가 켜질 때까지 hook 시도 ("Trying to hook to INFINITAS...")
//   - hook 되면 곡 선택 화면 진입할 때마다 tracker.tsv dump
//   - INFINITAS 종료되면 다시 hook 대기
import { app } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import { promises as fsp, createWriteStream, existsSync, watch as fsWatch, FSWatcher } from 'fs';
import { join } from 'path';
import { request as httpsRequest } from 'https';
import { EventEmitter } from 'events';
import type { RefluxState } from '../shared/types';

const RELEASES_API = 'https://api.github.com/repos/olji/Reflux/releases/latest';

// userData 안의 Reflux 작업 디렉토리 — getter (app.getPath 는 ready 이후만 가능)
function workDir(): string {
  return join(app.getPath('userData'), 'Reflux');
}
function exePath(): string {
  return join(workDir(), 'Reflux.exe');
}
function configPath(): string {
  return join(workDir(), 'config.ini');
}
function tsvPath(): string {
  return join(workDir(), 'tracker.tsv');
}

// Reflux 가 처음 실행될 때 만들 기본 config — savelocal 필수, livestream 비활성, debug 비활성
const DEFAULT_CONFIG = `[Update]
updateFiles = true
updateserver = "https://raw.githubusercontent.com/olji/Reflux/master/Reflux/"

[Record]
saveremote = false
savelocal = true
savejson = false
savelatestjson = false
savelatesttxt = false

[LocalRecord]
songinfo = true
chartdetails = true
resultdetails = true
judge = true
settings = true
uselocaltime = true

[Livestream]
showplaystate = false
enablemarquee = false
enablefullsonginfo = false
marqueeidletext = ""

[Debug]
outputdb = false
`;

// 외부에 노출할 상태 타입은 shared/types.ts 의 RefluxState 사용

// ============================================================
// 다운로드
// ============================================================
interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

// HTTPS GET 헬퍼 — github API 는 User-Agent 필수, 리다이렉트 따라가기 필요 (release asset)
function httpsGet(url: string, headers: Record<string, string> = {}): Promise<{ statusCode: number; data: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': 'INFOhSorry', Accept: 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            data: Buffer.concat(chunks).toString('utf-8'),
            location: res.headers.location as string | undefined,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  let res = await httpsGet(url);
  // GitHub API 는 보통 200 직답, 리다이렉트 거의 없음
  if (res.statusCode >= 300 && res.statusCode < 400 && res.location) {
    res = await httpsGet(res.location);
  }
  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode}: ${res.data.slice(0, 200)}`);
  }
  return JSON.parse(res.data) as T;
}

// 파일 다운로드 (대용량 stream) — redirects 따라감 (release asset 은 S3 redirect)
function downloadFile(
  url: string,
  destPath: string,
  onProgress: (bytes: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = (currentUrl: string, redirectsLeft: number): void => {
      const req = httpsRequest(
        currentUrl,
        { method: 'GET', headers: { 'User-Agent': 'INFOhSorry' } },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
            return handle(res.headers.location, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let bytes = 0;
          const file = createWriteStream(destPath);
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            onProgress(bytes, total);
          });
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    };
    handle(url, 5);
  });
}

// ============================================================
// Manager
// ============================================================
export class RefluxManager extends EventEmitter {
  private state: RefluxState = { stage: 'idle', installed: false, spawned: false };
  private child: ChildProcess | null = null;
  private tsvWatcher: FSWatcher | null = null;
  private lastTsvMtime = 0;

  getState(): RefluxState {
    return { ...this.state };
  }

  private setState(patch: Partial<RefluxState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  // 한 번에 다 진행: 설치 (필요 시) → config 생성 → spawn → tsv watch
  async startAll(): Promise<void> {
    try {
      if (!existsSync(exePath())) {
        await this.install();
      } else {
        this.setState({ installed: true });
      }
      await this.ensureConfig();
      await this.spawnReflux();
      this.watchTsv();
    } catch (e) {
      this.setState({ stage: 'error', error: (e as Error).message });
      throw e;
    }
  }

  // GitHub release 에서 Reflux.exe 다운로드
  private async install(): Promise<void> {
    this.setState({ stage: 'downloading', download: { bytes: 0, total: 0 } });
    await fsp.mkdir(workDir(), { recursive: true });

    const release = await fetchJson<Release>(RELEASES_API);
    const exeAsset = release.assets.find((a) => a.name.toLowerCase() === 'reflux.exe');
    if (!exeAsset) throw new Error('Reflux.exe asset not found in latest release');

    const tmp = exePath() + '.partial';
    await downloadFile(exeAsset.browser_download_url, tmp, (bytes, total) => {
      this.setState({ download: { bytes, total: total || exeAsset.size } });
    });
    await fsp.rename(tmp, exePath());
    this.setState({ installed: true, download: undefined });
  }

  // config.ini 가 없으면 생성, 있으면 그대로 둠 (사용자가 수정했을 수 있으니 보존)
  private async ensureConfig(): Promise<void> {
    if (!existsSync(configPath())) {
      await fsp.mkdir(workDir(), { recursive: true });
      await fsp.writeFile(configPath(), DEFAULT_CONFIG, 'utf-8');
    }
  }

  // child_process spawn + stdout 으로 hook 상태 감지
  private async spawnReflux(): Promise<void> {
    if (this.child) return; // 이미 떠있으면 skip
    this.setState({ stage: 'starting', spawned: false });

    const child = spawn(exePath(), [], {
      cwd: workDir(),
      windowsHide: true, // 콘솔 창 숨김
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.setState({ spawned: true, stage: 'hooking' });

    // stdout 으로 단계 감지 — Reflux Program.cs 의 출력 메시지 매칭
    const onLine = (line: string): void => {
      // 주의: 메시지 문구는 Reflux 코드에 의존하므로 변경되면 같이 갱신
      if (/Trying to hook to INFINITAS/i.test(line)) {
        this.setState({ stage: 'hooking' });
      } else if (/Hooked to process/i.test(line)) {
        this.setState({ stage: 'hooked' });
      }
      // 첫 tracker.tsv dump 는 watcher 가 감지 → setState({ stage: 'ready' })
    };
    let buf = '';
    const handleData = (data: Buffer): void => {
      buf += data.toString('utf-8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
      }
    };
    child.stdout?.on('data', handleData);
    child.stderr?.on('data', handleData);

    child.on('exit', (code) => {
      this.child = null;
      this.setState({
        spawned: false,
        stage: code === 0 ? 'idle' : 'error',
        error: code !== 0 ? `Reflux 종료 코드 ${code}` : undefined,
      });
    });
    child.on('error', (e) => {
      this.child = null;
      this.setState({ spawned: false, stage: 'error', error: e.message });
    });
  }

  // tracker.tsv 변경 감지 — 처음 생성되거나 갱신될 때 'ready' 상태로 + lastTsvMtime 업데이트
  private watchTsv(): void {
    if (this.tsvWatcher) return;
    // 파일이 아직 없을 수 있으니 디렉토리를 watch
    try {
      this.tsvWatcher = fsWatch(workDir(), (event, filename) => {
        if (filename === 'tracker.tsv' && existsSync(tsvPath())) {
          fsp
            .stat(tsvPath())
            .then((st) => {
              const m = st.mtime.getTime();
              if (m !== this.lastTsvMtime) {
                this.lastTsvMtime = m;
                this.setState({ stage: 'ready', lastTsvMtime: m });
              }
            })
            .catch(() => {
              /* ignore — 파일이 잠시 사라질 수도 (atomic rename) */
            });
        }
      });
    } catch (e) {
      // watch 실패해도 Reflux 동작 자체는 OK — 사용자가 수동 reload 가능
      console.warn('[reflux] watch 실패:', e);
    }
  }

  // 자식 프로세스 종료 (앱 종료 전 호출)
  async stop(): Promise<void> {
    if (this.tsvWatcher) {
      this.tsvWatcher.close();
      this.tsvWatcher = null;
    }
    const child = this.child;
    if (!child) return;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  // 외부 노출 (renderer 가 tsv 직접 읽을 수 있게)
  static get tsvFilePath(): string {
    return tsvPath();
  }
  static get workDirectory(): string {
    return workDir();
  }
}
