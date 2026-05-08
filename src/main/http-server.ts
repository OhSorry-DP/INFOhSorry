// LAN 원격 제어 HTTP 서버 — 다른 PC 의 Chrome 에서 :3000 접속하면 같은 renderer 화면 + 모든 IPC 호출
// 이 서버를 통해 PC1 에서 동작 (RPC bridge).
//
// 라우팅:
//   POST /api/ipc          — body { channel, args[] } → 결과 { result } 또는 { error }
//                             (window.infohsorry 의 모든 메서드 일대일 대응)
//   GET /*                 — out/renderer/ 의 정적 파일 (SPA fallback 으로 index.html)
//
// production 빌드 (npm run release) 에서만 시작 — dev 모드는 vite 가 :5173 띄움.
import http from 'http';
import { promises as fsp } from 'fs';
import { extname, join } from 'path';
import { networkInterfaces } from 'os';
import { RefluxManager } from './reflux';

const PORT = 3000;

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

export function startHttpServer(
  _refluxManager: RefluxManager,
  rendererDir: string,
  ipcHandlers: IpcHandlers,
): http.Server {
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
  return server;
}
