import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createRealm } from './test-support.mjs';
const realm = createRealm({ fetch: async url => {
  const u = new URL(url), filename = decodeURIComponent(u.pathname.split('/').pop());
  const candidate = path.join(workerData.root, u.pathname.includes('/lib/') ? 'modules' : 'dist', filename);
  const text = fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(workerData.root, filename), 'utf8');
  return { ok: true, status: 200, text: async () => text };
} });
const receive = realm.load('./workerRuntime').createWorkerRuntime(value => parentPort.postMessage(value));
parentPort.on('message', async message => {
  // Test-only RNG reset, never installed in the production Worker.
  if (message.type === 'run' && message.kind === 'rec-query') realm.eval(`var seed=1337; Math.random=()=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296;
  };`);
  await receive(realm.dto(message));
});
