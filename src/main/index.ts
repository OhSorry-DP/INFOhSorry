import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { findInfinitas, closeHandle } from './memory';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    title: 'INFOhSorry',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  // 개발 모드: vite dev server URL / 프로덕션: 빌드된 index.html
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

// PoC: INFINITAS 프로세스 탐색 IPC
// 프로세스 핸들 열고 base 주소 확인 후 즉시 닫음 (실제 read 단계는 다음에 추가)
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
