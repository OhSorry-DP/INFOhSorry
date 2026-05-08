import { contextBridge, ipcRenderer } from 'electron';
import type {
  ProbeResult,
  TsvReadResult,
  RefluxState,
  RefluxStartResult,
  EreterGetResult,
  EreterCacheStatus,
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

  // ereter.net 데이터 (perlevel ★ 값) 캐시 + 24h TTL
  ereter: {
    get: (force = false): Promise<EreterGetResult> => ipcRenderer.invoke('ereter:get', force),
    status: (): Promise<EreterCacheStatus> => ipcRenderer.invoke('ereter:status'),
    dataPath: (): Promise<string> => ipcRenderer.invoke('ereter:dataPath'),
  },

  // 캡처 이미지 자동 저장 (사진 폴더 / INFOhSorry / *.png)
  saveImage: (
    data: ArrayBuffer | string,
    defaultName?: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('image:save', data, defaultName),

  // 진단용 (현재 미사용, 나중에 INFINITAS 실행 감지에 활용)
  probe: (exeName: string): Promise<ProbeResult> => ipcRenderer.invoke('memory:probe', exeName),
};

contextBridge.exposeInMainWorld('infohsorry', api);
