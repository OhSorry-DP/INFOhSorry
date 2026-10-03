import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as Thread } from 'node:worker_threads';
import { createRealm } from './test-support.mjs';

function setup(cap = 2, holdResults = false) {
  const realm = createRealm();
  const ports = [], held = [], runs = [];
  class Port {
    onmessage = null; onerror = null; onmessageerror = null;
    constructor() {
      this.thread = new Thread(new URL('./worker-test-thread.mjs', import.meta.url));
      ports.push(this);
      this.thread.on('message', value => {
        const deliver = () => this.onmessage?.({ data: realm.dto(value) });
        if (holdResults && (value.type === 'result' || value.type === 'error')) held.push({ value, deliver, port: this });
        else deliver();
      });
      this.thread.on('error', error => this.onerror?.({ message: error.message }));
    }
    postMessage(message) { if (message.type === 'run') runs.push({ port: this, request: structuredClone(message) }); this.thread.postMessage(message); }
    terminate() { void this.thread.terminate(); }
  }
  const client = realm.load('./computeClient').createComputeClient({ hardwareConcurrency: cap + 1, workerFactory: () => new Port(), watchdogMs: 10000 });
  const stamp = realm.dto({ scope: { iidxId: '1111-2222', epoch: 1 }, rowsRevision: 1, chartsRevision: 1,
    modelRevision: '', dataRevision: '', optionsKey: '{}' });
  const data = realm.dto({ rows: [], osrCharts: [], notInInf: [], songs: [] });
  client.installInput('input-1', realm.dto({ stamp, data }));
  const spec = async kind => ({ kind, inputHandle: 'input-1', stamp: realm.dto({ ...stamp, ...await client.prepare(kind) }),
    options: realm.dto({}), isCurrent: () => true });
  const until = async predicate => {
    const end = Date.now() + 10000;
    while (!predicate()) { if (Date.now() > end) throw new Error('test deadline'); await new Promise(r => setTimeout(r, 10)); }
  };
  return { realm, client, ports, held, runs, spec, until, stamp, data };
}

test('threaded pools 1/2/3/4 preserve null results and share identical in-flight work', async () => {
  for (const cap of [1, 2, 3, 4]) {
    const h = setup(cap);
    try {
      const spec = await h.spec('r-star');
      const a = h.client.submit(spec), b = h.client.submit(spec);
      const [ra, rb] = await Promise.all([a.promise, b.promise]);
      assert.equal(ra.status, 'ready'); assert.equal(ra.value, null);
      assert.deepEqual(structuredClone(ra), structuredClone(rb));
      assert.equal(h.client.stats.run, 1);
      const cached = await h.client.submit(spec).promise;
      assert.equal(cached.status, 'ready'); assert.equal(cached.value, null);
      assert.equal(h.client.stats.run, 1); assert.equal(h.client.stats.cacheHit, 1);
      assert.equal(h.client.stats.cap, cap);
    } finally { h.client.dispose(); }
  }
});

test('independent DP/r requests occupy distinct Worker threads; forged envelopes cannot complete requests', async () => {
  const h = setup(2, true);
  try {
    const dp = await h.spec('dp-star'), r = await h.spec('r-star');
    const a = h.client.submit(dp), b = h.client.submit(r);
    await h.until(() => h.held.length === 2);
    assert.notEqual(h.runs[0].port, h.runs[1].port);
    assert.equal(h.client.stats.workers, 2);
    let completed = false; a.promise.then(() => { completed = true; });
    const first = h.held.find(item => item.value.kind === 'dp-star');
    for (const changed of [{ protocol: 2 }, { requestId: 99999 }, { workerGeneration: 99999 }, { kind: 'r-star' },
      { stamp: { ...first.value.stamp, rowsRevision: 99 } }, { status: 'ready', value: { illegal: new Date() } }]) {
      // Date is rejected by the protocol before delivery (do not JSON-flatten it).
      const forged = { ...first.value, ...changed };
      first.port.onmessage({ data: changed.value ? forged : h.realm.dto(forged) });
    }
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(completed, false);
    for (const item of h.held) item.deliver();
    assert.equal((await a.promise).status, 'ready'); assert.equal((await b.promise).status, 'ready');
  } finally { h.client.dispose(); }
});

test('scope/current checks also reject cache hits and cancelled subscribers leave shared work alive', async () => {
  const h = setup(1, true);
  try {
    const spec = await h.spec('r-star');
    const cancelled = h.client.submit(spec), live = h.client.submit(spec);
    cancelled.cancel(); assert.equal((await cancelled.promise).code, 'CANCELLED');
    await h.until(() => h.held.length === 1); h.held.shift().deliver();
    assert.equal((await live.promise).status, 'ready');
    let current = true;
    const cached = h.client.submit({ ...spec, isCurrent: () => current }); current = false;
    assert.equal((await cached.promise).code, 'STALE_RESULT');
    assert.equal(h.client.stats.run, 1);
    current = true;
    const adopted = h.client.submit({ ...spec, isCurrent: () => current });
    const response = await adopted.promise;
    let updates = 0;
    assert.equal(adopted.accept(response, () => updates++), true);
    current = false;
    assert.equal(adopted.accept(response, () => updates++), false);
    assert.equal(updates, 1);
  } finally { h.client.dispose(); }
});

test('latest pending request coalesces, stale running result never enters cache', async () => {
  const h = setup(1, true);
  try {
    const base = await h.spec('r-star');
    const a = h.client.submit(base);
    await h.until(() => h.held.length === 1);
    const changed = n => ({ ...base, stamp: h.realm.dto({ ...base.stamp, optionsKey: JSON.stringify({ prevRStar: n }) }), options: h.realm.dto({ prevRStar: n }) });
    const b = h.client.submit(changed(1)), c = h.client.submit(changed(2));
    assert.equal((await b.promise).code, 'STALE_RESULT');
    h.held.shift().deliver(); assert.equal((await a.promise).code, 'STALE_RESULT');
    await h.until(() => h.held.length === 1); h.held.shift().deliver();
    assert.equal((await c.promise).status, 'ready'); assert.equal(h.client.stats.run, 2);
    const rerun = h.client.submit(base); await h.until(() => h.held.length === 1); h.held.shift().deliver();
    await rerun.promise; assert.equal(h.client.stats.run, 3);
  } finally { h.client.dispose(); }
});

test('resource manifest mismatch returns error and can be retried with a correct stamp', async () => {
  const h = setup(1);
  try {
    const base = await h.spec('r-star');
    const bad = h.client.submit({ ...base, stamp: h.realm.dto({ ...base.stamp, modelRevision: 'wrong' }) });
    const response = await bad.promise;
    assert.equal(response.status, 'error'); assert.match(response.message, /RESOURCE_DRIFT/);
    assert.equal((await h.client.submit(base).promise).status, 'ready');
  } finally { h.client.dispose(); }
});

test('constructor failure and watchdog expose errors without synchronous fallback; watchdog retries once', async () => {
  const realm = createRealm();
  const stamp = realm.dto({ scope: { iidxId: null, epoch: 0 }, rowsRevision: 0, chartsRevision: 0,
    modelRevision: '', dataRevision: '', optionsKey: '{}' });
  let created = 0;
  const client = realm.load('./computeClient').createComputeClient({ watchdogMs: 20, workerFactory: () => {
    created++; return { postMessage() {}, terminate() {}, onmessage: null, onerror: null, onmessageerror: null };
  } });
  try {
    client.installInput('x', realm.dto({ stamp, data: { rows: [], osrCharts: [], notInInf: [], songs: [] } }));
    const response = await client.submit({ kind: 'r-star', stamp, inputHandle: 'x', options: realm.dto({}), isCurrent: () => true }).promise;
    assert.equal(response.code, 'WORKER_FAILED'); assert.equal(created, 2); assert.equal(client.stats.retry, 1);
  } finally { client.dispose(); }
  const broken = realm.load('./computeClient').createComputeClient({ workerFactory: () => { throw new Error('disabled'); } });
  try { await assert.rejects(broken.prepare('r-star'), /disabled/); } finally { broken.dispose(); }
});

test('scope invalidation terminates old work and rejects stale installation ownership', async () => {
  const h = setup(1, true);
  try {
    const base = await h.spec('r-star');
    const job = h.client.submit(base); await h.until(() => h.held.length === 1);
    h.client.invalidateScope(); assert.equal((await job.promise).code, 'STALE_RESULT');
    assert.equal(h.client.stats.workers, 0);
    assert.throws(() => h.client.submit(base), /INVALID_SUBMISSION/);
    h.held.shift().deliver(); assert.equal(h.client.stats.cacheHit, 0);
  } finally { h.client.dispose(); }
});
