// LAN 원격 모드 — window.infohsorry 가 없으면 (= browser 환경) HTTP RPC bridge 로 자동 patch.
// 그 결과 App.tsx 등은 환경 분기 없이 window.infohsorry.* 그대로 호출 가능.
import type { ProbeResult, RefluxState, TsvReadResult } from '../../shared/types';

const IS_HOST = typeof window !== 'undefined' && typeof window.infohsorry !== 'undefined';

// HTTP RPC: POST /api/ipc { channel, args[] } → { result } | { error }
async function callIpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const res = await fetch('/api/ipc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, args }),
  });
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new Error(json.error);
  return json.result;
}

// Reflux state polling — host 측 webContents.send 가 없으니 client 가 5초마다 fetch
function makeRefluxStatePoller(): (cb: (s: RefluxState) => void) => () => void {
  return (cb) => {
    let alive = true;
    let lastJson = '';
    const tick = async (): Promise<void> => {
      if (!alive) return;
      try {
        const s = (await callIpc('reflux:state')) as RefluxState;
        const j = JSON.stringify(s);
        if (j !== lastJson) {
          lastJson = j;
          cb(s);
        }
      } catch {
        /* 일시 끊김은 무시 — 다음 tick 에서 재시도 */
      }
    };
    void tick();
    const timer = window.setInterval(tick, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  };
}

// Browser 에서 saveImage — PC2 의 Chrome 자체 다운로드로 (a 태그 download). PC1 IPC 안 거침.
async function browserDownloadPng(
  data: ArrayBuffer | string,
  defaultName?: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    let blob: Blob;
    if (typeof data === 'string') {
      const base64 = data.replace(/^data:image\/png;base64,/, '');
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: 'image/png' });
    } else {
      blob = new Blob([data], { type: 'image/png' });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName || `capture-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, path: a.download };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

if (!IS_HOST) {
  // Browser 환경 — window.infohsorry 를 HTTP bridge 로 polyfill
  // CSS 에서 PC2 모드 분기용 (e.g. WindowControls 자리 padding 제거)
  document.documentElement.classList.add('browser-remote');
  const onState = makeRefluxStatePoller();
  const bridge: Window['infohsorry'] = {
    readTsv: (path: string) => callIpc('tsv:read', path) as Promise<TsvReadResult>,
    reflux: {
      start: () => callIpc('reflux:start') as ReturnType<Window['infohsorry']['reflux']['start']>,
      stop: () => callIpc('reflux:stop') as ReturnType<Window['infohsorry']['reflux']['stop']>,
      getState: () => callIpc('reflux:state') as Promise<RefluxState>,
      getTsvPath: () => callIpc('reflux:tsvPath') as Promise<string>,
      onState,
    },
    ereter: {
      get: (force?: boolean) =>
        callIpc('ereter:get', force) as ReturnType<Window['infohsorry']['ereter']['get']>,
      status: () => callIpc('ereter:status') as ReturnType<Window['infohsorry']['ereter']['status']>,
      dataPath: () => callIpc('ereter:dataPath') as Promise<string>,
    },
    zasa: {
      get: (force?: boolean) =>
        callIpc('zasa:get', force) as ReturnType<Window['infohsorry']['zasa']['get']>,
      status: () => callIpc('zasa:status') as ReturnType<Window['infohsorry']['zasa']['status']>,
    },
    saveImage: browserDownloadPng,
    probe: (exeName: string) => callIpc('memory:probe', exeName) as Promise<ProbeResult>,
    shell: {
      showInFolder: (path: string) =>
        callIpc('shell:showInFolder', path) as Promise<{ ok: boolean }>,
    },
    // 브라우저 원격에선 창 컨트롤 의미 없음 — noop (UI 자체가 안 보일 거지만 안전망)
    window: {
      minimize: async () => ({ ok: false }),
      maximizeToggle: async () => ({ ok: false }),
      close: async () => ({ ok: false }),
      isMaximized: async () => false,
      onMaximizedChange: () => () => {},
    },
  };
  (window as unknown as { infohsorry: Window['infohsorry'] }).infohsorry = bridge;
  console.log('[api] browser 환경 — HTTP bridge 활성');
}

export const IS_BROWSER_REMOTE = !IS_HOST;
