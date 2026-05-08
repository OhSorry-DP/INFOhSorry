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
import { ChildProcess, spawn } from 'child_process';
import { promises as fsp, createWriteStream, existsSync, watch as fsWatch, FSWatcher } from 'fs';
import { join } from 'path';
import { request as httpsRequest } from 'https';
import { EventEmitter } from 'events';
import type { RefluxState } from '../shared/types';

const RELEASES_API = 'https://api.github.com/repos/olji/Reflux/releases/latest';

// 작업 디렉토리 — C:\ohsorry (Reflux.exe / config / tracker.tsv / sessions / ereter-data 모두 이 안)
function workDir(): string {
  return 'C:\\ohsorry';
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
  // Reflux 가 출력한 최근 stdout/stderr 라인 (디버깅용, UI 에도 노출)
  private recentLines: string[] = [];
  private static readonly MAX_RECENT = 30;

  getState(): RefluxState {
    return { ...this.state, recentLines: [...this.recentLines] };
  }

  private setState(patch: Partial<RefluxState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  private addLine(line: string): void {
    if (!line) return;
    // 콘솔에도 print — npm run dev 의 터미널에서 보임
    console.log('[reflux]', line);
    this.recentLines.push(line);
    if (this.recentLines.length > RefluxManager.MAX_RECENT) {
      this.recentLines.splice(0, this.recentLines.length - RefluxManager.MAX_RECENT);
    }
    // 라인이 추가됐으니 state push (UI 가 실시간으로 봄)
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
      await this.ensureOffsets();
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

  // Reflux 가 시작 직후 LoadOffsets() 에서 읽는 파일들. 자동 update (Update.updateFiles=true) 가
  // 동작하기 전에 먼저 필요해서, 우리가 GitHub raw 에서 미리 받아 둬야 첫 실행이 죽지 않음.
  // Reflux 가 자기 update 로 새로 받으면 그게 덮어쓰니 덮어쓰기 OK.
  private async ensureOffsets(): Promise<void> {
    const RAW_BASE = 'https://raw.githubusercontent.com/olji/Reflux/master/Reflux';
    // 핵심 파일들 — 없으면 Reflux 가 죽는 것들 + 보조 파일
    const files = [
      'offsets.txt',
      'customtypes.txt',
      'encodingfixes.txt',
      'beginners.txt',
    ];
    await fsp.mkdir(workDir(), { recursive: true });
    for (const name of files) {
      const dest = join(workDir(), name);
      if (existsSync(dest)) continue;
      try {
        await downloadFile(`${RAW_BASE}/${name}`, dest, () => {});
      } catch (e) {
        // 파일 못 받으면 일단 빈 파일이라도 만들어 둠 (Reflux 가 파일 없으면 죽으므로)
        await fsp.writeFile(dest, '', 'utf-8');
        console.warn(`[reflux] ${name} 다운로드 실패, 빈 파일 생성:`, (e as Error).message);
      }
    }
  }

  // Windows 의 `start` 명령으로 Reflux 를 띄움 (탐색기 더블클릭과 동일한 방식).
  //
  // 왜 이렇게: Node spawn 으로 Electron 자식 띄우면 콘솔 attach 가 안 되는데, Reflux 는
  // hook 직후 Console.Clear() 를 호출해서 콘솔 없으면 즉사 (IOException).
  // `cmd /c start "" "Reflux.exe"` 는 Windows 의 ShellExecute 같은 launch 라
  // 새 콘솔창을 자동 부여 → Console API 동작.
  //
  // 트레이드오프:
  //   - cmd 자체는 start 명령 후 즉시 종료. child 로는 cmd 만 잡고 있고 Reflux 본체의
  //     PID 를 직접 모름.
  //   - cleanup 은 image name 으로 taskkill /IM Reflux.exe (사용자가 다른 Reflux 인스턴스
  //     안 돌리는 가정).
  //   - stdout 도 캡처 안 됨. UI 의 recentLines / hooking stage 매칭 비활성.
  //   - 그래도 tracker.tsv watch 만으로 'ready' 신호 감지 가능 — 핵심 흐름은 동작.
  private async spawnReflux(): Promise<void> {
    if (this.child) return;
    this.setState({ stage: 'starting', spawned: false });

    // PowerShell Start-Process -WindowStyle Hidden 으로 띄움.
    //   - Reflux 가 콘솔 attach 받음 (Console.Clear 동작)
    //   - 콘솔창은 hidden — 작업표시줄에도 안 보임
    //
    // SystemRoot 절대경로로 ENOENT 방지. powershell.exe 자체도 windowsHide:true 로 invisible.
    const winDir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const psPath = `${winDir}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

    const child = spawn(
      psPath,
      [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `Start-Process -FilePath '${exePath()}' -WorkingDirectory '${workDir()}' -WindowStyle Hidden`,
      ],
      {
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    this.child = child;
    // cmd 가 곧 종료 → spawned=true 는 사용자가 뭔가 떠 있다는 신호. Reflux 는 별도로 살아있음.
    this.setState({ spawned: true, stage: 'hooking' });

    // cmd 종료는 무시 (Reflux 본체는 별도 프로세스로 떠 있음)
    child.on('exit', () => {
      this.child = null;
      // spawned 는 그대로 유지 — Reflux 본체는 살아있다고 가정
    });
    child.on('error', (e) => {
      this.child = null;
      this.addLine(`(spawn 에러: ${e.message})`);
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
  // `cmd /c start` 방식이라 child.pid 는 cmd 의 것. Reflux 본체는 별도 프로세스로 살아있음.
  // 이름으로 종료: taskkill /F /IM Reflux.exe /T (모든 Reflux.exe 인스턴스 종료)
  async stop(): Promise<void> {
    if (this.tsvWatcher) {
      this.tsvWatcher.close();
      this.tsvWatcher = null;
    }
    if (process.platform !== 'win32') return;
    return new Promise((resolve) => {
      // taskkill 도 PATH 의존 회피 — System32 절대경로로
      const winDir = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const taskkillExe = `${winDir}\\System32\\taskkill.exe`;
      const k = spawn(taskkillExe, ['/F', '/T', '/IM', 'Reflux.exe'], { windowsHide: true });
      const t = setTimeout(() => resolve(), 3000);
      k.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
      k.on('error', () => {
        clearTimeout(t);
        resolve();
      });
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
