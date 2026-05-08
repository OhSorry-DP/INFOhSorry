import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join } from 'path';
import { readTsv } from './tsv';
import { findInfinitas, closeHandle } from './memory';
import { RefluxManager } from './reflux';

let mainWindow: BrowserWindow | null = null;
const refluxManager = new RefluxManager();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'INFOhSorry',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Reflux manager 의 state 변경 → 모든 BrowserWindow 로 push
  refluxManager.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('reflux:state', state);
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 종료 전 Reflux child 정리
app.on('before-quit', async (e) => {
  if (refluxManager.getState().spawned) {
    e.preventDefault(); // 정리 끝까지 대기
    try {
      await refluxManager.stop();
    } catch {
      /* ignore */
    }
    app.exit(0);
  }
});

// ----- IPC: Reflux 설치 + spawn -----
// idempotent: 이미 설치/실행 중이면 그대로 둠
ipcMain.handle('reflux:start', async () => {
  try {
    await refluxManager.startAll();
    return { ok: true, state: refluxManager.getState() };
  } catch (e) {
    return { ok: false, error: (e as Error).message, state: refluxManager.getState() };
  }
});

ipcMain.handle('reflux:state', async () => refluxManager.getState());

ipcMain.handle('reflux:stop', async () => {
  await refluxManager.stop();
  return { ok: true };
});

// Reflux 가 만든 tracker.tsv 의 절대 경로 (UI 에서 표시용)
ipcMain.handle('reflux:tsvPath', async () => RefluxManager.tsvFilePath);

// Reflux 작업 폴더를 OS 의 파일 탐색기로 열기
ipcMain.handle('reflux:openDir', async () => {
  const dir = RefluxManager.workDirectory;
  await shell.openPath(dir);
  return dir;
});

// ----- IPC: TSV 파일 읽기 (Reflux 의 tracker.tsv 또는 사용자가 고른 파일) -----
ipcMain.handle('tsv:pick', async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Reflux TSV 파일 선택',
    properties: ['openFile'],
    filters: [
      { name: 'TSV 파일', extensions: ['tsv', 'txt'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0];
});

ipcMain.handle('tsv:read', async (_evt, path: string) => {
  try {
    const { rows, headerCols, mtime } = await readTsv(path);
    return { ok: true, rows, headerColCount: headerCols.length, mtime };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

// ----- IPC: INFINITAS 프로세스 탐색 (PoC, 게임 실행 감지에 활용 가능) -----
ipcMain.handle('memory:probe', async (_evt, exeName: string) => {
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
});
