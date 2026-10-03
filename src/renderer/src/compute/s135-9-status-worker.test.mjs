import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as Thread } from 'node:worker_threads';
import { createRealm } from './test-support.mjs';

const specsFor = realm => realm.dto([
  { key: 'OhsorryNorm', globalKey: 'OhsorryNorm', url: 'norm' },
  { key: 'OhsorryWeakness', globalKey: 'OhsorryWeakness', url: 'weak' },
  { key: 'patterns', url: 'patterns' }, { key: 'rateRef', url: 'reference' },
  { key: 'rating', url: null }, { key: 'zasa', url: null },
]);
const data = songs => ({ rows: [{ title: 'song', charts: { DPA: { noteCount: 100, exScore: 150, lamp: 'HC' } } }],
  osrCharts: [], notInInf: [], songs });

function runtimeHarness(result, { throws = false, countCalls = false } = {}) {
  const calls = { count: 0 };
  const entries = Array.isArray(result?.__entries) ? result.__entries : [];
  const sources = {
    norm: 'globalThis.OhsorryNorm = { norm: s => s };',
    weak: `globalThis.callCount = 0; globalThis.seenUserVec = null; globalThis.OhsorryWeakness = { calcUserWeakness: data => { globalThis.callCount++; ${throws ? 'throw new Error("compute failed");' : `return ${JSON.stringify(result)};`} }, chartStrengthMatch8Way: (chart, vec) => { globalThis.seenUserVec = vec; return { bestLabel: 'Strong' }; } };`,
    patterns: '{"p":{"t":"song","c":{"DP_ANO":{}}}}', reference: '{}',
  };
  const realm = createRealm({ fetch: async url => ({ ok: true, text: async () => sources[url] }) });
  const replies = [];
  const runtime = realm.load('./workerRuntime').createWorkerRuntime(reply => replies.push(reply));
  const specs = specsFor(realm);
  const prepare = async () => {
    await runtime(realm.dto({ protocol: 1, type: 'init', workerGeneration: 1 }));
    await runtime(realm.dto({ protocol: 1, type: 'prepare', prepareId: 1, workerGeneration: 1, kind: 'weakness', resources: specs }));
    return replies.at(-1);
  };
  const install = async (handle, songs, manifest) => {
    const stamp = realm.dto({ scope: { iidxId: null, epoch: 1 }, rowsRevision: 1, chartsRevision: 1,
      optionsKey: '{}', modelRevision: manifest.modelRevision, dataRevision: manifest.dataRevision });
    await runtime(realm.dto({ protocol: 1, type: 'install-input', inputHandle: handle,
      input: { stamp, data: realm.dto(data(songs)) } }));
    return stamp;
  };
  const run = async (handle, stamp, manifest, kind, options, requestId) => {
    const dtoOptions = realm.dto(options);
    const optionsKey = realm.load('./revisionKey').makeOptionsKey(dtoOptions);
    const stamped = realm.dto({ ...stamp, optionsKey });
    await runtime(realm.dto({ protocol: 1, type: 'run', requestId, workerGeneration: 1, kind,
      inputHandle: handle, stamp: stamped, payload: { options: dtoOptions, resources: specs } }));
    return replies.at(-1);
  };
  return { realm, replies, runtime, specs, calls, prepare, install, run, entries, countCalls };
}

test('status shape is compact while default, null, empty entries, and errors keep their contracts', async () => {
  const large = { __entries: Array.from({ length: 1438 }, (_, i) => ({ i, payload: 'entry-data' })),
    hugeExtra: 'x'.repeat(10000), axis: 0.5, allCharts: Array.from({ length: 100 }, (_, i) => i) };
  const h = runtimeHarness(large); const manifest = await h.prepare(); const stamp = await h.install('i', null, manifest);
  const status = await h.run('i', stamp, manifest, 'weakness', { resultShape: 'playdata-status-v1' }, 1);
  const bytes = new TextEncoder().encode(JSON.stringify(status.value)).byteLength;
  assert.equal(status.status, 'ready', status.message); assert.deepEqual(JSON.parse(JSON.stringify(status.value)), { entriesCount: 1438 });
  assert.ok(bytes <= 128); assert.equal(status.valueBytes, bytes); assert.equal(status.diag.entriesCount, 1438);
  const full = await h.run('i', stamp, manifest, 'weakness', {}, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(full.value)), large);

  const empty = runtimeHarness({ __entries: [], hugeExtra: true }); const emptyManifest = await empty.prepare();
  const emptyStamp = await empty.install('i', null, emptyManifest);
  assert.deepEqual(JSON.parse(JSON.stringify((await empty.run('i', emptyStamp, emptyManifest, 'weakness',
    { resultShape: 'playdata-status-v1' }, 3)).value)), { entriesCount: 0 });
  const nullHarness = runtimeHarness(null); const nullManifest = await nullHarness.prepare();
  const nullStamp = await nullHarness.install('i', null, nullManifest);
  assert.equal((await nullHarness.run('i', nullStamp, nullManifest, 'weakness', { resultShape: 'playdata-status-v1' }, 4)).value, null);
  const broken = runtimeHarness(null, { throws: true }); const brokenManifest = await broken.prepare();
  const brokenStamp = await broken.install('i', null, brokenManifest);
  assert.equal((await broken.run('i', brokenStamp, brokenManifest, 'weakness', { resultShape: 'playdata-status-v1' }, 5)).status, 'error');
});

test('client keeps shape options in request identity and caches accepted results separately', async () => {
  const realm = createRealm(); const requests = [];
  const stampBase = realm.dto({ scope: { iidxId: '1111-2222', epoch: 1 }, rowsRevision: 1, chartsRevision: 1,
    modelRevision: '', dataRevision: '', optionsKey: '{}' });
  let requestId = 0;
  class Port {
    onmessage = null; onerror = null; onmessageerror = null;
    postMessage(message) {
      if (message.type === 'run') {
        requests.push(structuredClone(message));
        queueMicrotask(() => this.onmessage?.({ data: realm.dto({ protocol: 1, type: 'result', status: 'ready',
          workerGeneration: message.workerGeneration, requestId: message.requestId, kind: message.kind, stamp: message.stamp,
          value: message.payload.options.resultShape ? { entriesCount: 7 } : { __entries: Array(7).fill(0) } }) }));
      } else if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: realm.dto({ protocol: 1, type: 'ready', workerGeneration: message.workerGeneration }) }));
      else if (message.type === 'install-input') queueMicrotask(() => this.onmessage?.({ data: realm.dto({ protocol: 1, type: 'input-installed', inputHandle: message.inputHandle, inputDigest: 'digest' }) }));
      else if (message.type === 'prepare') queueMicrotask(() => this.onmessage?.({ data: realm.dto({ protocol: 1, type: 'prepared', prepareId: message.prepareId,
        workerGeneration: message.workerGeneration, modelRevision: '', dataRevision: '' }) }));
    }
    terminate() {}
  }
  const client = realm.load('./computeClient').createComputeClient({ hardwareConcurrency: 2, workerFactory: () => new Port() });
  const dataInput = realm.dto(data(null));
  try {
    client.installInput('i', realm.dto({ stamp: stampBase, data: dataInput }));
    const prepared = await client.prepare('weakness');
    const make = options => ({ kind: 'weakness', stamp: realm.dto({ ...stampBase, ...prepared, optionsKey: JSON.stringify(options) }),
      inputHandle: 'i', options: realm.dto(options), isCurrent: () => true });
    const full = make({}); const status = make({ resultShape: 'playdata-status-v1' });
    const firstFull = client.submit(full); const fullResponse = await firstFull.promise; assert.equal(firstFull.accept(fullResponse, () => {}), true);
    const firstStatus = client.submit(status); const statusResponse = await firstStatus.promise; assert.equal(firstStatus.accept(statusResponse, () => {}), true);
    assert.equal((await client.submit(make({})).promise).value.__entries.length, 7);
    assert.deepEqual(JSON.parse(JSON.stringify((await client.submit(make({ resultShape: 'playdata-status-v1' })).promise).value)), { entriesCount: 7 });
    assert.equal(requests.length, 2); assert.notEqual(requests[0].stamp.optionsKey, requests[1].stamp.optionsKey);
    assert.equal(client.stats.cacheHit, 2);
  } finally { client.dispose(); }
});

test('status weakness vector is reused for later layout with full libs vector available', async () => {
  const vec = { __entries: [{ label: 'A', rank: 9 }], score: 0.75 };
  const h = runtimeHarness(vec, { countCalls: true }); const manifest = await h.prepare();
  const firstStamp = await h.install('first', null, manifest);
  const reduced = await h.run('first', firstStamp, manifest, 'weakness', { resultShape: 'playdata-status-v1' }, 20);
  assert.deepEqual(JSON.parse(JSON.stringify(reduced.value)), { entriesCount: 1 });
  const secondStamp = await h.install('second', [{ id: 'song', title: 'song', ac: 2, legen: null }], manifest);
  const layout = await h.run('second', secondStamp, manifest, 'layout', { style: 'dp', layoutMode: true }, 21);
  assert.equal(layout.status, 'ready', layout.message);
  assert.equal(h.realm.eval('globalThis.callCount'), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.realm.eval('globalThis.seenUserVec'))), vec);
  const full = await h.run('first', firstStamp, manifest, 'weakness', {}, 22);
  assert.deepEqual(JSON.parse(JSON.stringify(full.value)), vec);
  const fullLayout = await h.run('second', secondStamp, manifest, 'layout', { style: 'dp', layoutMode: true }, 23);
  assert.deepEqual(JSON.parse(JSON.stringify(fullLayout.value)), JSON.parse(JSON.stringify(layout.value)));
});
