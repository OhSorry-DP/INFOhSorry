import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join } from 'path';
import { readTsv } from './tsv';
import { findInfinitas, closeHandle } from './memory';

let mainWindow: BrowserWindow | null = null;

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

// ----- IPC: TSV 파일 선택 다이얼로그 -----
// 사용자가 Reflux 출력 TSV 의 경로를 선택. 취소 시 null 반환.
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

// ----- IPC: TSV 파일 읽기 + 파싱 -----
ipcMain.handle('tsv:read', async (_evt, path: string) => {
  try {
    const { rows, headerCols } = await readTsv(path);
    return { ok: true, rows, headerColCount: headerCols.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});

// ----- IPC: INFINITAS 프로세스 탐색 (PoC, 나중에 게임 실행 감지에 활용) -----
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
