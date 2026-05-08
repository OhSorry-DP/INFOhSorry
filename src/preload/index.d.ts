// 렌더러에서 window.infohsorry 의 타입 인식하도록 ambient declaration
import type { ProbeResult, TsvReadResult } from '../shared/types';

declare global {
  interface Window {
    infohsorry: {
      pickTsv: () => Promise<string | null>;
      readTsv: (path: string) => Promise<TsvReadResult>;
      probe: (exeName: string) => Promise<ProbeResult>;
    };
  }
}

export {};
