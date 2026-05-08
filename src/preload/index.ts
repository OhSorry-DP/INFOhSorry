import { contextBridge, ipcRenderer } from 'electron';
import type {
  ProbeResult,
  TsvReadResult,
  RefluxState,
  RefluxStartResult,
} from '../shared/types';

const api = {
  // TSV (수동 파일 선택 / 직접 읽기 — Reflux 외 다른 TSV 도 OK)
  pickTsv: (): Promise<string | null> => ipcRenderer.invoke('tsv:pick'),
  readTsv: (path: string): Promise<TsvReadResult> => ipcRenderer.invoke('tsv:read', path),

  // Reflux 관리
  reflux: {
    start: (): Promise<RefluxStartResult> => ipcRenderer.invoke('reflux:start'),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('reflux:stop'),
    getState: (): Promise<RefluxState> => ipcRenderer.invoke('reflux:state'),
    getTsvPath: (): Promise<string> => ipcRenderer.invoke('reflux:tsvPath'),
    openDir: (): Promise<string> => ipcRenderer.invoke('reflux:openDir'),
    onState: (cb: (s: RefluxState) => void): (() => void) => {
      const listener = (_evt: unknown, state: RefluxState): void => cb(state);
      ipcRenderer.on('reflux:state', listener);
      return (): void => {
        ipcRenderer.off('reflux:state', listener);
      };
    },
  },

  // 진단용 (현재 미사용, 나중에 INFINITAS 실행 감지에 활용)
  probe: (exeName: string): Promise<ProbeResult> => ipcRenderer.invoke('memory:probe', exeName),
};

contextBridge.exposeInMainWorld('infohsorry', api);
