// 렌더러에서 window.infohsorry 의 타입 인식하도록 ambient declaration
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

declare global {
  interface Window {
    infohsorry: {
      readTsv: (path: string) => Promise<TsvReadResult>;
      reflux: {
        start: () => Promise<RefluxStartResult>;
        stop: () => Promise<{ ok: boolean }>;
        getState: () => Promise<RefluxState>;
        getTsvPath: () => Promise<string>;
        onState: (cb: (s: RefluxState) => void) => () => void;
      };
      ereter: {
        get: (force?: boolean) => Promise<EreterGetResult>;
        status: () => Promise<EreterCacheStatus>;
        dataPath: () => Promise<string>;
      };
      zasa: {
        get: (force?: boolean) => Promise<ZasaGetResult>;
        status: () => Promise<ZasaCacheStatus>;
      };
      saveImage: (
        data: ArrayBuffer | string,
        defaultName?: string,
      ) => Promise<{ ok: boolean; path?: string; error?: string }>;
      probe: (exeName: string) => Promise<ProbeResult>;
      shell: {
        showInFolder: (path: string) => Promise<{ ok: boolean }>;
      };
      window: {
        minimize: () => Promise<{ ok: boolean }>;
        maximizeToggle: () => Promise<{ ok: boolean; maximized?: boolean }>;
        close: () => Promise<{ ok: boolean }>;
        isMaximized: () => Promise<boolean>;
        onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
      };
    };
  }
}

export {};
