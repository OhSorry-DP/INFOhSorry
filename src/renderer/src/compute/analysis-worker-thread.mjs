import { parentPort, workerData, threadId } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createRealm } from './test-support.mjs';
const realm = createRealm({ trace: (phase, kind) => parentPort.postMessage({ trace: true, threadId, phase, kind, time: Date.now() }),
  fetch: async url => {
    const u = new URL(url), file = decodeURIComponent(u.pathname.split('/').pop());
    const source = workerData.sources?.[file];
    const candidate = path.join(workerData.root, u.pathname.includes('/lib/') ? 'modules' : 'dist', file);
    const text = source ?? fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(workerData.root, file), 'utf8');
    return { ok: true, status: 200, text: async () => text };
  } });
const receive = realm.load('./workerRuntime').createWorkerRuntime(value => parentPort.postMessage(value));
parentPort.on('message', message => { void receive(realm.dto(message)); });
