// 렌더러에서 window.infohsorry 의 타입 인식하도록 ambient declaration
import type {
  ProbeResult,
  TsvReadResult,
  RefluxState,
  RefluxStartResult,
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
        onState: (cb: (s: RefluxState) => void) => () => void;
      };
      probe: (exeName: string) => Promise<ProbeResult>;
    };
  }
}

export {};
