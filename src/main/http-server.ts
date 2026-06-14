// LAN 원격 제어 HTTP 서버 — 다른 PC 의 Chrome 에서 :3000 접속하면 같은 renderer 화면 + 모든 IPC 호출
// 이 서버를 통해 PC1 에서 동작 (RPC bridge).
//
// 라우팅:
//   POST /api/ipc          — body { channel, args[] } → 결과 { result } 또는 { error }
//                             (window.infohsorry 의 모든 메서드 일대일 대응)
//   GET  /api/events       — SSE (text/event-stream) — reflux state 변경을 PC2 에 실시간 push.
//                             기존 5초 polling 대체. EventSource 가 자동 재연결 처리.
//   GET /*                 — out/renderer/ 의 정적 파일 (SPA fallback 으로 index.html)
//
// production 빌드 (npm run release) 에서만 시작 — dev 모드는 vite 가 :5173 띄움.
import http from 'http';
import { promises as fsp } from 'fs';
import { extname, join, dirname } from 'path';
import { networkInterfaces } from 'os';
import { RefluxManager } from './reflux';
import type { RefluxState } from '../shared/types';

const PORT = 3000;
// 원격모드 오소리웹 서빙 — vercel 배포본을 받아 로컬 캐시(A: 오프라인) + 캐시 비우면 재fetch(B: 최신화).
const OSR_ORIGIN = 'https://ohsorry.vercel.app';

function mimeOf(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const info of ifs[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

// /osr/* → 오소리웹 정적 서빙. 로컬 캐시 우선(A: 오프라인), 없으면 vercel 에서 받아 캐시(B: 최신화).
//   오소리웹은 상대경로(./modules/, ./styles.css)라 /osr/ 하위에서 그대로 동작.
//   오소리웹의 /api/me 는 절대경로 → 루트로 가서 INF http-server 가 처리(same-origin, mixed content 없음).
async function serveOsr(
  urlPath: string,
  osrCacheDir: string,
  res: http.ServerResponse,
): Promise<void> {
  let rel = urlPath.replace(/^\/osr\/?/, '');
  if (rel === '' || rel.endsWith('/')) rel = rel + 'index.html';
  rel = rel.split('/').filter((s) => s && s !== '..').join('/'); // 경로 탈출 방지
  const cachePath = join(osrCacheDir, rel);
  let buf: Buffer | null = null;
  try {
    buf = await fsp.readFile(cachePath);
  } catch {
    try {
      const resp = await fetch(`${OSR_ORIGIN}/${rel}`);
      if (!resp.ok) {
        res.writeHead(resp.status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`osr fetch ${resp.status}`);
        return;
      }
      buf = Buffer.from(await resp.arrayBuffer());
      await fsp.mkdir(dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, buf).catch(() => {});
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('osr proxy fail: ' + (e as Error).message);
      return;
    }
  }
  res.writeHead(200, {
    'content-type': mimeOf(extname(rel)),
    'access-control-allow-origin': '*',
    'cache-control': 'no-cache',
  });
  res.end(buf);
}

async function readBody(req: http.IncomingMessage, maxBytes = 50 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

type IpcHandlers = Record<string, (...args: never[]) => unknown>;

async function handleIpc(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handlers: IpcHandlers,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('method not allowed');
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: (e as Error).message }));
    return;
  }
  let payload: { channel?: string; args?: unknown[] };
  try {
    payload = JSON.parse(body) as { channel?: string; args?: unknown[] };
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'invalid json: ' + (e as Error).message }));
    return;
  }
  const channel = payload.channel;
  const args = payload.args ?? [];
  if (!channel || !handlers[channel]) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `unknown channel: ${channel}` }));
    return;
  }
  try {
    const fn = handlers[channel] as (...a: unknown[]) => unknown;
    const result = await fn(...args);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ result }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
}

// SSE 클라이언트 set — reflux state 변경 시 broadcast.
// EventSource 가 자동 재연결하므로 서버는 client 끊기면 set 에서 제거만 하면 됨.
function setupSseBroadcast(refluxManager: RefluxManager): {
  attach: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  notifyMeUpdate: () => void;
} {
  const clients = new Set<http.ServerResponse>();

  const broadcast = (eventName: string, data: unknown): void => {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        /* 끊긴 client — close 핸들러가 정리 */
      }
    }
  };

  refluxManager.on('state', (state: RefluxState) => {
    broadcast('reflux:state', state);
  });

  // 15초마다 SSE comment ping — idle proxy / NAT 가 connection 끊지 않게 keep-alive
  setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }
  }, 15000).unref();

  return {
    attach: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
        'x-accel-buffering': 'no', // nginx 류 reverse proxy buffering off
      });
      // 연결 즉시 현재 state 1회 push (초기 sync — PC2 가 EventSource open 직후 화면 채움)
      res.write(
        `event: reflux:state\ndata: ${JSON.stringify(refluxManager.getState())}\n\n`,
      );
      clients.add(res);
      const cleanup = (): void => {
        clients.delete(res);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
    },
    // 원격모드 본인 카드 갱신 신호 — renderer 가 setUser 로 /api/me 를 새로 채울 때마다 호출.
    //   PC2(오소리웹 ?remote)가 이 이벤트를 받아 보고 있는 본인 카드를 조용히 다시 fetch/렌더.
    notifyMeUpdate: () => broadcast('me:update', { ts: Date.now() }),
  };
}

export function startHttpServer(
  refluxManager: RefluxManager,
  rendererDir: string,
  ipcHandlers: IpcHandlers,
  getRemoteUser?: () => unknown,
  osrCacheDir?: string,
): { server: http.Server; notifyMeUpdate: () => void } {
  const sse = setupSseBroadcast(refluxManager);

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = (req.url || '/').split('?')[0];

      // CORS preflight (LAN 내 브라우저들이 OPTIONS 요청 보낼 수 있음)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end();
        return;
      }

      // RPC bridge
      if (urlPath === '/api/ipc') {
        await handleIpc(req, res, ipcHandlers);
        return;
      }

      // SSE event stream — reflux state push (5초 polling 대체)
      if (urlPath === '/api/events' && req.method === 'GET') {
        sse.attach(req, res);
        return;
      }

      // 원격모드 본인 카드 — renderer 가 계산해 push 한 오소리웹 user 객체(별값 + charts_json)를 로컬 실시간 노출.
      //   오소리웹 fetchUserProfile 의 원격 분기(?remote)가 supabase 대신 이 엔드포인트를 읽는다.
      if (urlPath === '/api/me' && req.method === 'GET') {
        const user = getRemoteUser ? getRemoteUser() : null;
        res.writeHead(user ? 200 : 404, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-cache',
        });
        res.end(JSON.stringify(user ?? { error: 'no remote user yet' }));
        return;
      }

      // 원격모드 오소리웹 — /osr/* 를 vercel 캐시/프록시로 서빙 (A 동봉/오프라인 + B 최신화).
      if (osrCacheDir && (urlPath === '/osr' || urlPath.startsWith('/osr/'))) {
        await serveOsr(urlPath, osrCacheDir, res);
        return;
      }

      // 정적 파일 (out/renderer/...)
      const target = urlPath === '/' ? '/index.html' : urlPath;
      const filePath = join(rendererDir, target);
      try {
        const buf = await fsp.readFile(filePath);
        res.writeHead(200, {
          'content-type': mimeOf(extname(filePath)),
          'cache-control': 'no-cache',
        });
        res.end(buf);
        return;
      } catch {
        try {
          // SPA fallback — 없는 경로는 index.html
          const html = await fsp.readFile(join(rendererDir, 'index.html'));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(404);
          res.end('Not Found');
        }
      }
    } catch (e) {
      res.writeHead(500);
      res.end((e as Error).message);
    }
  });
  server.listen(PORT, '0.0.0.0', () => {
    const ips = lanAddresses();
    console.log(`[http] LAN 원격 제어 서버 :${PORT}`);
    for (const ip of ips) console.log(`         http://${ip}:${PORT}`);
  });
  return { server, notifyMeUpdate: sse.notifyMeUpdate };
}
