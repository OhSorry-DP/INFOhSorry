import { contextBridge, ipcRenderer } from 'electron';
import type {
  ProbeResult,
  TsvReadResult,
  RefluxState,
  RefluxStartResult,
  EreterGetResult,
  EreterCacheStatus,
  ZasaGetResult,
  ZasaCacheStatus,
} from '../shared/types';

const api = {
  // TSV 직접 읽기
  readTsv: (path: string): Promise<TsvReadResult> => ipcRenderer.invoke('tsv:read', path),

  // Reflux 관리
  reflux: {
    start: (): Promise<RefluxStartResult> => ipcRenderer.invoke('reflux:start'),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('reflux:stop'),
    getState: (): Promise<RefluxState> => ipcRenderer.invoke('reflux:state'),
    getTsvPath: (): Promise<string> => ipcRenderer.invoke('reflux:tsvPath'),
    onState: (cb: (s: RefluxState) => void): (() => void) => {
      const listener = (_evt: unknown, state: RefluxState): void => cb(state);
      ipcRenderer.on('reflux:state', listener);
      return (): void => {
        ipcRenderer.off('reflux:state', listener);
      };
    },
  },

  // ereter.net 데이터 (perlevel ★ 값) 캐시 + 24h TTL
  ereter: {
    get: (force = false): Promise<EreterGetResult> => ipcRenderer.invoke('ereter:get', force),
    status: (): Promise<EreterCacheStatus> => ipcRenderer.invoke('ereter:status'),
    dataPath: (): Promise<string> => ipcRenderer.invoke('ereter:dataPath'),
  },

  // zasa.sakura.ne.jp 보충 데이터 (DP12 격자 미분류 곡 fallback)
  zasa: {
    get: (force = false): Promise<ZasaGetResult> => ipcRenderer.invoke('zasa:get', force),
    status: (): Promise<ZasaCacheStatus> => ipcRenderer.invoke('zasa:status'),
  },

  // 캡처 이미지 자동 저장 (사진 폴더 / INFOhSorry / *.png)
  saveImage: (
    data: ArrayBuffer | string,
    defaultName?: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('image:save', data, defaultName),

  // 진단용 (현재 미사용, 나중에 INFINITAS 실행 감지에 활용)
  probe: (exeName: string): Promise<ProbeResult> => ipcRenderer.invoke('memory:probe', exeName),

  // 셸 액션
  shell: {
    showInFolder: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shell:showInFolder', path),
  },

  // 창 컨트롤 (frameless 모드)
  window: {
    minimize: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: (): Promise<{ ok: boolean; maximized?: boolean }> =>
      ipcRenderer.invoke('window:maximize-toggle'),
    close: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_evt: unknown, m: boolean): void => cb(m);
      ipcRenderer.on('window:maximized', listener);
      return (): void => {
        ipcRenderer.off('window:maximized', listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('infohsorry', api);
