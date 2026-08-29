// recommendBridge — http-server(/api/recommend) ↔ renderer(recCtx) 요청/응답 중계.
//
// main 은 recCtx(코어 recommend.js)를 들고 있지 않다(renderer 가 patterns 등 ~3MB 를 로드해 만든다).
//   그래서 요청이 오면 webContents.send('recommend:request') 로 renderer 에 넘기고,
//   renderer 가 ipcRenderer.send('recommend:response') 로 돌려준 결과를 reqId 로 매칭해 resolve 한다.
//   renderer 가 12초 안에 응답 안 하면(창 닫힘 / lib 미로딩) reject → http-server 가 503.

import type { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';

const TIMEOUT_MS = 12_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RecommendBridge {
  /** kind + params → renderer recCtx 계산 결과. 실패 시 throw (창 없음 / timeout / recCtx 미준비). */
  query: (kind: string, params: Record<string, unknown>) => Promise<unknown>;
  /** ipcMain.on('recommend:response') 핸들러가 호출. */
  handleResponse: (payload: { reqId?: string; ok?: boolean; result?: unknown; error?: string }) => void;
}

export function createRecommendBridge(getWindow: () => BrowserWindow | null): RecommendBridge {
  const pending = new Map<string, Pending>();

  return {
    query(kind, params) {
      return new Promise((resolve, reject) => {
        const win = getWindow();
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
          reject(new Error('INF 창이 없음 — 추천은 INF 앱 창이 열려 있을 때만 가능'));
          return;
        }
        const reqId = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(reqId);
          reject(new Error('renderer 응답 timeout (추천 lib 로딩 중이거나 창이 응답 없음)'));
        }, TIMEOUT_MS);
        pending.set(reqId, { resolve, reject, timer });
        win.webContents.send('recommend:request', { reqId, kind, params });
      });
    },
    handleResponse(payload) {
      const reqId = payload?.reqId;
      if (!reqId) return;
      const p = pending.get(reqId);
      if (!p) return; // 이미 timeout 됐거나 중복
      pending.delete(reqId);
      clearTimeout(p.timer);
      if (payload.ok) p.resolve(payload.result);
      else p.reject(new Error(payload.error || 'renderer 계산 실패'));
    },
  };
}
