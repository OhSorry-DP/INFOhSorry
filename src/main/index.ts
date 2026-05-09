import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import { join } from 'path';
import { readTsv } from './tsv';
import { findInfinitas, closeHandle } from './memory';
import { RefluxManager } from './reflux';
import {
  getEreterData,
  getCacheStatus as getEreterCacheStatus,
  getDataPath as getEreterDataPath,
} from './ereter';
import { getZasaData, getCacheStatus as getZasaCacheStatus } from './zasa';
import { startHttpServer } from './http-server';

let mainWindow: BrowserWindow | null = null;
const refluxManager = new RefluxManager();

// 모든 IPC handler 를 단일 map 에. ipcMain.handle + HTTP /api/ipc 둘 다 같은 함수.
// 시그니처: (...args) → Promise<any> | any. event 파라미터는 ipcMain.handle wrapper 에서 제거.
export const ipcHandlers: Record<string, (...args: never[]) => unknown> = {
  // Reflux
  'reflux:start': async () => {
    try {
      await refluxManager.startAll();
      return { ok: true, state: refluxManager.getState() };
    } catch (e) {
      return { ok: false, error: (e as Error).message, state: refluxManager.getState() };
    }
  },
  'reflux:state': async () => refluxManager.getState(),
  'reflux:stop': async () => {
    await refluxManager.stop();
    return { ok: true };
  },
  'reflux:tsvPath': async () => RefluxManager.tsvFilePath,

  // Image (캡처)
  'image:save': async (...args: never[]) => {
    const data = args[0] as ArrayBuffer | string;
    const defaultName = args[1] as string | undefined;
    try {
      const fs = await import('fs');
      const path = await import('path');
      const dir = app.getPath('downloads');
      await fs.promises.mkdir(dir, { recursive: true });
      const fileName = defaultName || `capture-${Date.now()}.png`;
      const filePath = path.join(dir, fileName);
      let buf: Buffer;
      if (typeof data === 'string') {
        const base64 = data.replace(/^data:image\/png;base64,/, '');
        buf = Buffer.from(base64, 'base64');
      } else {
        buf = Buffer.from(data);
      }
      await fs.promises.writeFile(filePath, buf);
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // ereter
  'ereter:get': async (...args: never[]) => {
    const force = (args[0] as boolean | undefined) ?? false;
    try {
      const data = await getEreterData(force);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  'ereter:status': async () => getEreterCacheStatus(),
  'ereter:dataPath': async () => getEreterDataPath(),

  // zasa (보충용 ☆12 난이도표 — DP12 격자 표 미분류 곡 fallback 매칭)
  'zasa:get': async (...args: never[]) => {
    const force = (args[0] as boolean | undefined) ?? false;
    try {
      const data = await getZasaData(force);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  'zasa:status': async () => getZasaCacheStatus(),

  // TSV
  'tsv:read': async (...args: never[]) => {
    const path = args[0] as string;
    try {
      const { rows, headerCols, mtime } = await readTsv(path);
      return { ok: true, rows, headerColCount: headerCols.length, mtime };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // 창 컨트롤 (frameless 모드 — 커스텀 헤더 버튼에서 호출)
  'window:minimize': async () => {
    mainWindow?.minimize();
    return { ok: true };
  },
  'window:maximize-toggle': async () => {
    if (!mainWindow) return { ok: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  },
  'window:close': async () => {
    mainWindow?.close();
    return { ok: true };
  },
  'window:isMaximized': async () => mainWindow?.isMaximized() ?? false,

  // 폴더 열기 (저장된 캡처 파일 위치 보여주기)
  'shell:showInFolder': async (...args: never[]) => {
    const path = args[0] as string;
    if (!path) return { ok: false };
    shell.showItemInFolder(path);
    return { ok: true };
  },

  // 진단
  'memory:probe': async (...args: never[]) => {
    const exeName = args[0] as string;
    try {
      const found = findInfinitas(exeName);
      if (!found) {
        return { ok: false, error: `프로세스 "${exeName}" 못 찾음 (게임 실행 중인지 확인)` };
      }
      try {
        return {
          ok: true,
          pid: found.pid,
          modBaseAddr: '0x' + found.modBaseAddr.toString(16),
          modBaseSize: found.modBaseSize,
          modName: found.modName,
        };
      } finally {
        closeHandle(found.handle);
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};

// ipcMain 등록 (electron renderer 용)
for (const [channel, fn] of Object.entries(ipcHandlers)) {
  ipcMain.handle(channel, async (_evt, ...args) => (fn as (...a: unknown[]) => unknown)(...args));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 520, // 그 이하에선 헤더 / 탭 / 추천 패널 레이아웃이 깨짐
    minHeight: 400,
    title: 'ohSorryScoreINF',
    icon: join(__dirname, '../../ohsorry.ico'),
    frame: false,  // 프레임리스 — 헤더에 커스텀 close/min/max 버튼 사용
    roundedCorners: false,  // Windows 11 기본 라운드 코너 비활성
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  // 창 상태 변화 → renderer 에 알림 (max ↔ restore 아이콘 토글용)
  const emitMaxState = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', emitMaxState);
  mainWindow.on('unmaximize', emitMaxState);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  refluxManager.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('reflux:state', state);
    }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  // production 빌드에서만 HTTP 서버 시작 (LAN 모드 — 다른 PC 의 Chrome 으로 접속해서 동일 화면 + 원격 제어)
  if (!process.env.ELECTRON_RENDERER_URL) {
    const rendererDir = join(__dirname, '../renderer');
    try {
      startHttpServer(refluxManager, rendererDir, ipcHandlers);
    } catch (e) {
      console.warn('[http] 서버 시작 실패:', (e as Error).message);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  void (async () => {
    const status = getEreterCacheStatus();
    if (status.isStale) {
      try {
        await getEreterData(false);
        console.log('[ereter] 자동 갱신 완료');
      } catch (e) {
        console.warn('[ereter] 자동 갱신 실패:', (e as Error).message);
      }
    }
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (refluxManager.getState().spawned) {
    e.preventDefault();
    try {
      await refluxManager.stop();
    } catch {
      /* ignore */
    }
    app.exit(0);
  }
});
