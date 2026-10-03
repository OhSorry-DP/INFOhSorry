import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealm } from './test-support.mjs';

async function runtimeWith(result, { clock = true, throws = false } = {}) {
  // renderer-integration.test.mjs 관례: 리소스 원문은 fetch 주입으로 공급한다.
  const sources = {
    norm: 'globalThis.OhsorryNorm = { norm: s => s };',
    weak: `globalThis.OhsorryWeakness = { calcUserWeakness: () => ${throws ? '{ throw new Error("compute failed"); }' : `(${JSON.stringify(result)})`} };`,
    patterns: '{}',
    reference: '{}',
  };
  const realm = createRealm({
    fetch: async url => ({ ok: true, text: async () => sources[url] }),
    ...(clock ? { performance: { timeOrigin: 1000, now: () => 100 } } : {}),
  });
  const replies = [];
  const runtime = realm.load('./workerRuntime').createWorkerRuntime(reply => replies.push(reply));
  const specs = realm.dto([
    { key: 'OhsorryNorm', globalKey: 'OhsorryNorm', url: 'norm' },
    { key: 'OhsorryWeakness', globalKey: 'OhsorryWeakness', url: 'weak' },
    { key: 'patterns', url: 'patterns' }, { key: 'rateRef', url: 'reference' },
    { key: 'rating', url: null }, { key: 'zasa', url: null },
  ]);
  await runtime(realm.dto({ protocol: 1, type: 'init', workerGeneration: 1 }));
  await runtime(realm.dto({ protocol: 1, type: 'prepare', prepareId: 1, workerGeneration: 1, kind: 'weakness', resources: specs }));
  const manifest = replies.at(-1);
  const stamp = realm.dto({ scope: { iidxId: null, epoch: 1 }, rowsRevision: 1, chartsRevision: 1,
    optionsKey: '{}', modelRevision: manifest.modelRevision, dataRevision: manifest.dataRevision });
  await runtime(realm.dto({ protocol: 1, type: 'install-input', inputHandle: 'i',
    input: { stamp, data: { rows: [{ title: 'song', charts: { DPA: { noteCount: 100, exScore: 150, lamp: 'HC' } } }],
      osrCharts: [], notInInf: [], songs: null } } }));
  return { realm, runtime, replies, stamp, specs };
}

test('ready diagnostics report shape and scalar counts while preserving value', async () => {
  const original = { __entries: [{ rate: 0.5 }, { rate: 0.7 }], axis: 0.25 };
  const h = await runtimeWith(original);
  await h.runtime(h.realm.dto({ protocol: 1, type: 'run', requestId: 7, workerGeneration: 1,
    kind: 'weakness', inputHandle: 'i', stamp: h.stamp, payload: { options: {}, resources: h.specs } }));
  const reply = h.replies.at(-1);
  assert.equal(reply.status, 'ready', reply.message);
  assert.deepEqual(JSON.parse(JSON.stringify(reply.value)), original);
  assert.equal(reply.diag.version, 1);
  assert.equal(reply.diag.entriesCount, 2);
  assert.equal(reply.diag.topLevelKeyCount, 2);
  assert.equal(reply.diag.valueBytes, new TextEncoder().encode(JSON.stringify(original)).byteLength);
  assert.equal(typeof reply.diag.workerReadyEpochMs, 'number');
});

test('missing performance clock omits timestamps and keeps ready result', async () => {
  const h = await runtimeWith({ __entries: [1] }, { clock: false });
  await h.runtime(h.realm.dto({ protocol: 1, type: 'run', requestId: 8, workerGeneration: 1,
    kind: 'weakness', inputHandle: 'i', stamp: h.stamp, payload: { options: {}, resources: h.specs } }));
  const reply = h.replies.at(-1);
  assert.equal(reply.status, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(reply.value)), { __entries: [1] });
  assert.equal('workerReadyEpochMs' in reply.diag, false);
  assert.equal('encodeMs' in reply.diag, false);
});

test('null and compute errors retain the existing response policy', async () => {
  const h = await runtimeWith(null);
  await h.runtime(h.realm.dto({ protocol: 1, type: 'run', requestId: 9, workerGeneration: 1,
    kind: 'weakness', inputHandle: 'i', stamp: h.stamp, payload: { options: {}, resources: h.specs } }));
  const ready = h.replies.at(-1);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.value, null);
  const broken = await runtimeWith(null, { throws: true });
  await broken.runtime(broken.realm.dto({ protocol: 1, type: 'run', requestId: 10, workerGeneration: 1,
    kind: 'weakness', inputHandle: 'i', stamp: broken.stamp, payload: { options: {}, resources: broken.specs } }));
  const error = broken.replies.at(-1);
  assert.equal(error.status, 'error');
  assert.equal('diag' in error, false);
});
