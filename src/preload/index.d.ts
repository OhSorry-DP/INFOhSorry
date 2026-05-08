// 렌더러 측에서 window.infohsorry 의 타입 인식하도록 ambient declaration
export interface ProbeResult {
  ok: boolean;
  error?: string;
  pid?: number;
  modBaseAddr?: string;
  modBaseSize?: number;
  modName?: string;
}

declare global {
  interface Window {
    infohsorry: {
      probe: (exeName: string) => Promise<ProbeResult>;
    };
  }
}

export {};
