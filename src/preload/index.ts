import { contextBridge, ipcRenderer } from 'electron';
import type { ProbeResult, TsvReadResult } from '../shared/types';

const api = {
  pickTsv: (): Promise<string | null> => ipcRenderer.invoke('tsv:pick'),
  readTsv: (path: string): Promise<TsvReadResult> => ipcRenderer.invoke('tsv:read', path),
  probe: (exeName: string): Promise<ProbeResult> => ipcRenderer.invoke('memory:probe', exeName),
};

contextBridge.exposeInMainWorld('infohsorry', api);
