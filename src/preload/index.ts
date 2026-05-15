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
  RatingGetResult,
  RatingCacheStatus,
  UpdateInfo,
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
    // offsets.txt 파싱 — anchor 절대주소 + module-base 기준 상대 offset
    getOffsets: (): Promise<{
      ok: boolean;
      error?: string;
      version?: string;
      entries?: Record<string, string>;
      relative?: Record<string, string>;
      mtime?: number;
    }> => ipcRenderer.invoke('reflux:offsets'),
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

  // ohSorryRating (ereter 미등록 lv11/lv12 차트 추정값 — 추천 풀 fallback)
  // 우선순위: ereter > rating. rating 은 ereter 매칭 실패 시에만 사용.
  rating: {
    get: (force = false): Promise<RatingGetResult> => ipcRenderer.invoke('rating:get', force),
    status: (): Promise<RatingCacheStatus> => ipcRenderer.invoke('rating:status'),
  },

  // osr.js auto-update — gist 의 최신 lib 가 있으면 cache, renderer 가 eval 해서 사용
  osrLib: {
    get: (): Promise<{ code: string; version: string | null } | null> => ipcRenderer.invoke('osrLib:get'),
    checkUpdate: (): Promise<{ updated: boolean; version: string | null; source: 'fetch' | 'cache' | 'none'; error?: string }> =>
      ipcRenderer.invoke('osrLib:checkUpdate'),
  },

  // OSR13.5+.js auto-update (v3.3.5)
  osrLib135: {
    get: (): Promise<{ code: string; version: string | null } | null> => ipcRenderer.invoke('osrLib135:get'),
    checkUpdate: (): Promise<{ updated: boolean; version: string | null; source: 'fetch' | 'cache' | 'none'; error?: string }> =>
      ipcRenderer.invoke('osrLib135:checkUpdate'),
  },

  // 포터블 자동 다운로드 + 실행 (v0.0.19+)
  portable: {
    download: (url: string, fileName: string): Promise<string> =>
      ipcRenderer.invoke('portable:download', { url, fileName }),
    run: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('portable:run', filePath),
    onProgress: (cb: (p: { downloaded: number; total: number }) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, p: { downloaded: number; total: number }) => cb(p);
      ipcRenderer.on('portable:progress', listener);
      return () => ipcRenderer.removeListener('portable:progress', listener);
    },
  },

  // GitHub 최신 릴리즈 체크 — 알림 전용 (자동 다운로드 X)
  update: {
    check: (): Promise<UpdateInfo> => ipcRenderer.invoke('update:check'),
  },

  // 캡처 이미지 자동 저장 (사진 폴더 / INFOhSorry / *.png)
  saveImage: (
    data: ArrayBuffer | string,
    defaultName?: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('image:save', data, defaultName),

  // 진단용 (현재 미사용, 나중에 INFINITAS 실행 감지에 활용)
  probe: (exeName: string): Promise<ProbeResult> => ipcRenderer.invoke('memory:probe', exeName),

  // 메모리 스캐너 (DJ NAME / IIDX ID offset 찾기 + 저장된 offset 으로 읽기)
  memory: {
    scan: (
      exeName: string,
      text: string,
    ): Promise<{
      ok: boolean;
      error?: string;
      modBase?: string;
      modSize?: number;
      results?: { encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'; absolute: string; relative: string; relativeRaw: string }[];
    }> => ipcRenderer.invoke('memory:scan', exeName, text),
    // refine scan — 이전 매치 목록의 각 주소에서 새 값과 일치하는 것만 keep (Cheat Engine 의 next scan)
    refineScan: (
      exeName: string,
      text: string,
      prev: { encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'; absolute: string }[],
    ): Promise<{
      ok: boolean;
      error?: string;
      modBase?: string;
      modSize?: number;
      results?: { encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'; absolute: string; relative: string; relativeRaw: string }[];
    }> => ipcRenderer.invoke('memory:refine-scan', exeName, text, prev),
    readString: (
      exeName: string,
      relativeOffset: string,
      encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis',
      maxBytes?: number,
    ): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke('memory:read-string', exeName, relativeOffset, encoding, maxBytes),
    findAnchor: (
      exeName: string,
      heapAddr: string,
    ): Promise<{
      ok: boolean;
      error?: string;
      modBase?: string;
      candidates?: {
        pointerAbs: string;
        pointerRel: string;
        anchorName: string | null;
        anchorDelta: string | null;
        valueOffset: string;
      }[];
      refluxVersion?: string | null;
      directHits?: number;
    }> => ipcRenderer.invoke('memory:find-anchor', exeName, heapAddr),
    readViaAnchor: (
      exeName: string,
      anchorName: string,
      delta: string,
      encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis',
      maxBytes?: number,
      valueOffset?: string,
    ): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke(
        'memory:read-via-anchor',
        exeName,
        anchorName,
        delta,
        encoding,
        maxBytes,
        valueOffset,
      ),
  },

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
