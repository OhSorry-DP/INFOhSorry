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

// Reflux state subscribe — SSE (/api/events) 로 PC1 에서 push 받음. EventSource 가 끊김 시 자동 재연결.
// SSE 가 영구 실패 (네트워크 / 옛 버전 PC1) 면 안전망으로 30초 polling fallback. (이전엔 5초 polling 강제였음)
function makeRefluxStatePoller(): (cb: (s: RefluxState) => void) => () => void {
  return (cb) => {
    let alive = true;
    let lastJson = '';
    let es: EventSource | null = null;
    let fallbackTimer: number | null = null;
    let consecutiveErrors = 0;

    const deliver = (s: RefluxState): void => {
      const j = JSON.stringify(s);
      if (j !== lastJson) {
        lastJson = j;
        cb(s);
      }
    };

    const startFallbackPolling = (): void => {
      if (fallbackTimer !== null) return;
      const tick = async (): Promise<void> => {
        if (!alive) return;
        try {
          deliver((await callIpc('reflux:state')) as RefluxState);
        } catch {
          /* 일시 끊김은 무시 */
        }
      };
      void tick();
      fallbackTimer = window.setInterval(tick, 30000);
    };

    const stopFallbackPolling = (): void => {
      if (fallbackTimer !== null) {
        window.clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    try {
      es = new EventSource('/api/events');
      es.addEventListener('reflux:state', (ev) => {
        consecutiveErrors = 0;
        stopFallbackPolling();
        try {
          deliver(JSON.parse((ev as MessageEvent).data) as RefluxState);
        } catch {
          /* malformed payload 무시 */
        }
      });
      es.addEventListener('open', () => {
        consecutiveErrors = 0;
        stopFallbackPolling();
      });
      es.addEventListener('error', () => {
        // EventSource 가 자동 재연결 — readyState 가 CLOSED 거나 errors 가 누적되면 fallback 으로 전환
        consecutiveErrors++;
        if (es && es.readyState === EventSource.CLOSED) {
          startFallbackPolling();
        } else if (consecutiveErrors >= 3) {
          // 재연결 시도 중에도 데이터는 멈춰있지 않게 polling 병행
          startFallbackPolling();
        }
      });
    } catch {
      // EventSource 미지원 (구형 브라우저) — polling 으로 동작
      startFallbackPolling();
    }

    return () => {
      alive = false;
      stopFallbackPolling();
      if (es) {
        es.close();
        es = null;
      }
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
    clearTsv: (path: string) =>
      callIpc('tsv:clear', path) as ReturnType<Window['infohsorry']['clearTsv']>,
    reflux: {
      start: () => callIpc('reflux:start') as ReturnType<Window['infohsorry']['reflux']['start']>,
      stop: () => callIpc('reflux:stop') as ReturnType<Window['infohsorry']['reflux']['stop']>,
      getState: () => callIpc('reflux:state') as Promise<RefluxState>,
      getTsvPath: () => callIpc('reflux:tsvPath') as Promise<string>,
      getOffsets: () => callIpc('reflux:offsets') as ReturnType<Window['infohsorry']['reflux']['getOffsets']>,
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
    spTier: {
      get: (force?: boolean) =>
        callIpc('sptier:get', force) as ReturnType<Window['infohsorry']['spTier']['get']>,
      status: () => callIpc('sptier:status') as ReturnType<Window['infohsorry']['spTier']['status']>,
    },
    serviceStatus: {
      get: () =>
        callIpc('serviceStatus:get') as ReturnType<Window['infohsorry']['serviceStatus']['get']>,
    },
    rating: {
      get: (force?: boolean) =>
        callIpc('rating:get', force) as ReturnType<Window['infohsorry']['rating']['get']>,
      status: () =>
        callIpc('rating:status') as ReturnType<Window['infohsorry']['rating']['status']>,
    },
    offsets: {
      getProfile: () =>
        callIpc('offsets:getProfile') as ReturnType<Window['infohsorry']['offsets']['getProfile']>,
    },
    // 브라우저 원격에선 포터블 자동 업데이트 의미 없음 (호스트 exe 를 원격 기기에서 받아 실행 불가) — noop/reject
    portable: {
      download: async (): Promise<string> => {
        throw new Error('원격 접속에서는 자동 업데이트를 사용할 수 없습니다');
      },
      run: async (): Promise<{ ok: boolean; error?: string }> => ({
        ok: false,
        error: '원격 접속에서는 자동 업데이트를 사용할 수 없습니다',
      }),
      onProgress: () => () => {},
    },
    update: {
      check: () =>
        callIpc('update:check') as ReturnType<Window['infohsorry']['update']['check']>,
    },
    saveImage: browserDownloadPng,
    probe: (exeName: string) => callIpc('memory:probe', exeName) as Promise<ProbeResult>,
    memory: {
      scan: (exeName: string, text: string) =>
        callIpc('memory:scan', exeName, text) as ReturnType<Window['infohsorry']['memory']['scan']>,
      refineScan: (
        exeName: string,
        text: string,
        prev: { encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'; absolute: string }[],
      ) =>
        callIpc('memory:refine-scan', exeName, text, prev) as ReturnType<
          Window['infohsorry']['memory']['refineScan']
        >,
      readString: (exeName: string, off: string, enc: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis', maxBytes?: number) =>
        callIpc('memory:read-string', exeName, off, enc, maxBytes) as ReturnType<
          Window['infohsorry']['memory']['readString']
        >,
      findAnchor: (exeName: string, heapAddr: string) =>
        callIpc('memory:find-anchor', exeName, heapAddr) as ReturnType<
          Window['infohsorry']['memory']['findAnchor']
        >,
      readViaAnchor: (
        exeName: string,
        anchor: string,
        delta: string,
        enc: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis',
        maxBytes?: number,
        valueOffset?: string,
      ) =>
        callIpc(
          'memory:read-via-anchor',
          exeName,
          anchor,
          delta,
          enc,
          maxBytes,
          valueOffset,
        ) as ReturnType<Window['infohsorry']['memory']['readViaAnchor']>,
    },
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
    // 브라우저 원격(폰)에선 setUser 를 직접 쓰지 않지만(본인 user push 는 PC 본체가 함), 타입 일치 위해 bridge 제공.
    remote: {
      setUser: (user: unknown) =>
        callIpc('remote:setUser', user) as Promise<{ ok: boolean }>,
    },
    // PC2(브라우저 원격)는 업로드 안 함 — main 의 final-request 도 받지 않으므로 no-op.
    upload: {
      onFinalRequest: () => (): void => {},
      finalDone: (): void => {},
    },
  };
  (window as unknown as { infohsorry: Window['infohsorry'] }).infohsorry = bridge;
  console.log('[api] browser 환경 — HTTP bridge 활성');
}

export const IS_BROWSER_REMOTE = !IS_HOST;
