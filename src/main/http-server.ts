// LAN 원격 제어 HTTP 서버 — 다른 PC 의 Chrome 에서 :3000 접속하면 같은 renderer 화면 + 모든 IPC 호출
// 이 서버를 통해 PC1 에서 동작 (RPC bridge).
//
// 라우팅:
//   POST /api/ipc          — body { channel, args[] } → 결과 { result } 또는 { error }
//                             (window.infohsorry 의 모든 메서드 일대일 대응)
//   GET  /api/events       — SSE (text/event-stream) — reflux state 변경을 PC2 에 실시간 push.
//                             기존 5초 polling 대체. EventSource 가 자동 재연결 처리.
//   GET  /api/me           — renderer 가 push 한 오소리웹 user 객체(원격모드 본인 카드).
//   GET  /index.html,/assets/* — out/renderer/ 의 INF 자체 화면(LAN 원격제어). 로컬 정적.
//   GET  /osr, /osr/*      — 레거시 → 같은 경로의 루트 등가물로 302 (호환).
//   GET  /                 — remote 쿼리 없으면 /?remote 로 302 (IP:3000 만 쳐도 원격 카드).
//   GET  /* (그 외)         — 오소리웹 루트 마운트(serveOsr: vercel 캐시/프록시 + SPA fallback).
//
// production 빌드 (npm run release) 에서만 시작 — dev 모드는 vite 가 :5173 띄움.
import http from 'http';
import { promises as fsp } from 'fs';
import { extname, join, dirname } from 'path';
import { networkInterfaces } from 'os';
import makeMdns from 'multicast-dns';
import QRCode from 'qrcode';
import { RefluxManager } from './reflux';
import type { RefluxState } from '../shared/types';

const PORT = 3000;
const LOCAL_NAME = 'ohsorry.local';   // mDNS 광고 이름 — 포트80 OK 면 http://ohsorry.local 로 접속

// 폰/PC2 접속 정보 — 헤더 QR/안내용.
export interface ConnectInfo {
  ip: string | null;       // 대표 LAN IPv4
  port: number;            // 3000 (항상)
  port80: boolean;         // 80 listen 성공 여부(포트 없이 접속 가능)
  localName: string;       // ohsorry.local
  url: string | null;      // 스캔/접속 권장 URL (IP 기반 — 가장 확실)
  nameUrl: string;         // 이름 기반 URL (ohsorry.local[:port])
  qr: string | null;       // url 의 QR (data:image/png base64) — main 에서 생성(렌더러 qrcode import 회피)
}
// 원격모드 오소리웹 서빙 — vercel 배포본을 받아 로컬 캐시(A: 오프라인) + 캐시 비우면 재fetch(B: 최신화).
const OSR_ORIGIN = 'https://ohsorry.iidx.in';  // 정본 도메인 (vercel.app 은 여기로 308 redirect)

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

// 오소리웹 정적 서빙 — 루트 마운트. 네트워크 우선(vercel), 실패 시 로컬 캐시(오프라인) fallback.
//   오소리웹은 서버 루트에 마운트되므로 urlPath 의 선행 슬래시만 떼어 vercel 경로로 사용한다
//   (예: /styles.css→styles.css, /user/X→user/X, /→index.html). <base href="/"> 가 루트 기준이라 자산도 정상.
//   SPA 라우트(/user/*, /grid/* 등)는 vercel rewrites 가 index.html 을 반환 → 별도 fallback 불필요.
//   오소리웹의 /api/me 는 절대경로 → 루트로 가서 INF http-server 가 처리(same-origin, mixed content 없음).
async function serveOsr(
  urlPath: string,
  osrCacheDir: string,
  res: http.ServerResponse,
): Promise<void> {
  let rel = urlPath.replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel = rel + 'index.html';
  rel = rel.split('/').filter((s) => s && s !== '..').join('/'); // 경로 탈출 방지
  const cachePath = join(osrCacheDir, rel);
  let buf: Buffer | null = null;
  // 네트워크 우선 — 항상 최신 오소리웹을 받는다. cache-bust 쿼리로 CDN edge stale 회피(예: 새 배포 직후
  //   특정 PoP 가 옛 파일을 들고 있어 토글/신규 UI 가 안 뜨던 문제). 받은 건 디스크에도 저장(오프라인 fallback).
  //   네트워크 실패(오프라인 등) 시에만 디스크 캐시로 fallback. (이전엔 캐시 우선이라 한 번 받으면 영원히 stale.)
  try {
    const resp = await fetch(`${OSR_ORIGIN}/${rel}?t=${Date.now()}`, { cache: 'no-store' });
    if (resp.ok) {
      buf = Buffer.from(await resp.arrayBuffer());
      await fsp.mkdir(dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, buf).catch(() => {});
    }
  } catch {
    /* 오프라인/네트워크 실패 → 아래 디스크 캐시 fallback */
  }
  if (!buf) {
    try {
      buf = await fsp.readFile(cachePath);
    } catch {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('osr unavailable (오프라인 + 캐시 없음)');
      return;
    }
  }
  // 확장자 없는 경로 = SPA 라우트(/user/*, /grid/*, /docs …) → vercel rewrites 가 index.html(HTML)을 반환.
  //   mimeOf 의 octet-stream 기본값으로 덮으면 브라우저가 문서 렌더 대신 다운로드하므로 text/html 로 명시.
  const ext = extname(rel);
  res.writeHead(200, {
    'content-type': ext ? mimeOf(ext) : 'text/html; charset=utf-8',
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
): { server: http.Server; notifyMeUpdate: () => void; connectInfo: () => Promise<ConnectInfo>; stop: () => void } {
  const sse = setupSseBroadcast(refluxManager);

  const requestListener = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const rawUrl = req.url || '/';
      const urlPath = rawUrl.split('?')[0];
      const query = rawUrl.slice(urlPath.length);   // '?remote' 등 (없으면 '')

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

      // INF 자체 renderer(LAN 원격제어 화면) — /index.html(exact) 와 /assets/* 만 로컬 빌드(out/renderer)에서 서빙.
      //   오소리웹은 /assets/ 를 안 쓰고 index 는 '/' 로 받으므로, 이 둘만 INF 전용으로 떼어내면 루트 마운트와 충돌 없음.
      if (urlPath === '/index.html' || urlPath === '/assets' || urlPath.startsWith('/assets/')) {
        const filePath = join(rendererDir, urlPath);
        try {
          const buf = await fsp.readFile(filePath);
          res.writeHead(200, {
            'content-type': mimeOf(extname(filePath)),
            'cache-control': 'no-cache',
          });
          res.end(buf);
        } catch {
          res.writeHead(404);
          res.end('Not Found');
        }
        return;
      }

      // 레거시 /osr/* — 루트 마운트로 전환됨. 같은 경로의 루트 등가물로 302 (기존 캐시/북마크/공유 링크 호환).
      //   예: /osr/?remote→/?remote, /osr/styles.css→/styles.css. 쿼리는 그대로 보존.
      if (urlPath === '/osr' || urlPath.startsWith('/osr/')) {
        const rest = urlPath.replace(/^\/osr/, '') || '/';
        res.writeHead(302, { location: rest + query });
        res.end();
        return;
      }

      // 루트 마운트 — 그 외 모든 경로(/, /user/*, /grid/*, /docs, /styles.css, /readme-page.js, /services/* …)는
      //   오소리웹을 serveOsr(vercel 캐시/프록시)로 서빙. SPA fallback 은 vercel rewrites 가 처리.
      if (osrCacheDir) {
        // '/' 에 remote 쿼리가 없으면 ?remote 붙여 302 — IP:3000 만 쳐도 원격 본인카드 + REMOTE_MODE 보장.
        //   이미 ?remote 면 리다이렉트하지 않음(루프 방지).
        if (urlPath === '/' && req.method === 'GET' && !new URLSearchParams(query).has('remote')) {
          res.writeHead(302, { location: '/?remote' });
          res.end();
          return;
        }
        await serveOsr(urlPath, osrCacheDir, res);
        return;
      }

      // osrCacheDir 미설정(이론상 없음) — 최후 fallback: 로컬 정적 + SPA fallback(INF index.html)
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
  };

  const server = http.createServer(requestListener);
  server.listen(PORT, '0.0.0.0', () => {
    const ips = lanAddresses();
    console.log(`[http] LAN 원격 제어 서버 :${PORT}`);
    for (const ip of ips) console.log(`         http://${ip}:${PORT}`);
  });

  // best-effort :80 — 포트 없이 http://ohsorry.local 접속용. 이미 사용 중이면(EADDRINUSE 등) 무시하고 :3000 만.
  let port80Ok = false;
  const server80 = http.createServer(requestListener);
  server80.on('error', (e) => console.warn('[http] :80 바인드 실패(무시, :3000 사용):', (e as Error).message));
  server80.listen(80, '0.0.0.0', () => { port80Ok = true; console.log(`[http] :80 listen — http://${LOCAL_NAME}`); });

  // mDNS — ohsorry.local 을 대표 LAN IP 로 광고(폰/PC2 가 IP 없이 이름으로 접속).
  const primaryIp = lanAddresses()[0] || null;
  let mdnsInst: ReturnType<typeof makeMdns> | null = null;
  if (primaryIp) {
    try {
      mdnsInst = makeMdns();
      mdnsInst.on('query', (q) => {
        for (const question of q.questions || []) {
          if (question.name === LOCAL_NAME && question.type === 'A') {
            mdnsInst?.respond({ answers: [{ name: LOCAL_NAME, type: 'A', ttl: 120, data: primaryIp }] });
          }
        }
      });
      console.log(`[mdns] ${LOCAL_NAME} → ${primaryIp} 광고`);
    } catch (e) {
      console.warn('[mdns] 광고 실패(무시):', (e as Error).message);
    }
  }

  // QR 은 main(node)에서 생성 — 렌더러가 qrcode 를 import 하면 @types/qrcode 가 web 컴파일에 node 타입을 끌어옴(타이머 타입 깨짐). url 별 캐시.
  let qrCache: { url: string; data: string } | null = null;
  const connectInfo = async (): Promise<ConnectInfo> => {
    const url = primaryIp ? `http://${primaryIp}${port80Ok ? '' : ':' + PORT}` : null;
    let qr: string | null = null;
    if (url) {
      if (qrCache && qrCache.url === url) qr = qrCache.data;
      else {
        try { qr = await QRCode.toDataURL(url, { width: 240, margin: 1 }); qrCache = { url, data: qr }; }
        catch { qr = null; }
      }
    }
    return {
      ip: primaryIp,
      port: PORT,
      port80: port80Ok,
      localName: LOCAL_NAME,
      url,
      nameUrl: port80Ok ? `http://${LOCAL_NAME}` : `http://${LOCAL_NAME}:${PORT}`,
      qr,
    };
  };
  const stop = (): void => {
    try { mdnsInst?.destroy(); } catch { /* ignore */ }
    try { server80.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
  };
  return { server, notifyMeUpdate: sse.notifyMeUpdate, connectInfo, stop };
}
