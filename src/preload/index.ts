import { contextBridge, ipcRenderer } from 'electron';

// 렌더러에 노출할 API — main 프로세스의 메모리 리딩 기능 호출
const api = {
  probe: (exeName: string): Promise<ProbeResult> => ipcRenderer.invoke('memory:probe', exeName),
};

contextBridge.exposeInMainWorld('infohsorry', api);

export interface ProbeResult {
  ok: boolean;
  error?: string;
  pid?: number;
  modBaseAddr?: string;
  modBaseSize?: number;
  modName?: string;
}
