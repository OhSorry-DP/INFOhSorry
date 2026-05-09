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
        getOffsets: () => Promise<{
          ok: boolean;
          error?: string;
          version?: string;
          entries?: Record<string, string>;
          relative?: Record<string, string>;
          mtime?: number;
        }>;
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
      memory: {
        scan: (
          exeName: string,
          text: string,
        ) => Promise<{
          ok: boolean;
          error?: string;
          modBase?: string;
          modSize?: number;
          results?: {
            encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';
            absolute: string;
            relative: string;
            relativeRaw: string;
          }[];
        }>;
        readString: (
          exeName: string,
          relativeOffset: string,
          encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis',
          maxBytes?: number,
        ) => Promise<{ ok: boolean; text?: string; error?: string }>;
        findAnchor: (
          exeName: string,
          heapAddr: string,
        ) => Promise<{
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
        }>;
        readViaAnchor: (
          exeName: string,
          anchorName: string,
          delta: string,
          encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis',
          maxBytes?: number,
          valueOffset?: string,
        ) => Promise<{ ok: boolean; text?: string; error?: string }>;
      };
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
