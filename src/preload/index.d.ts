// 렌더러에서 window.infohsorry 의 타입 인식하도록 ambient declaration
import type {
  ProbeResult,
  TsvReadResult,
  RefluxState,
  RefluxStartResult,
  EreterGetResult,
  EreterCacheStatus,
} from '../shared/types';

declare global {
  interface Window {
    infohsorry: {
      pickTsv: () => Promise<string | null>;
      readTsv: (path: string) => Promise<TsvReadResult>;
      reflux: {
        start: () => Promise<RefluxStartResult>;
        stop: () => Promise<{ ok: boolean }>;
        getState: () => Promise<RefluxState>;
        getTsvPath: () => Promise<string>;
        openDir: () => Promise<string>;
        onState: (cb: (s: RefluxState) => void) => () => void;
      };
      ereter: {
        get: (force?: boolean) => Promise<EreterGetResult>;
        status: () => Promise<EreterCacheStatus>;
        dataPath: () => Promise<string>;
      };
      saveImage: (
        data: ArrayBuffer | string,
        defaultName?: string,
      ) => Promise<{ ok: boolean; path?: string; error?: string }>;
      probe: (exeName: string) => Promise<ProbeResult>;
    };
  }
}

export {};
