import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealm } from './test-support.mjs';

function setup({ diag, responseStatus = 'ready' } = {}) {
  const lines = [];
  const realm = createRealm({ performance: { timeOrigin: 1_000, now: (() => { let n = 0; return () => ++n; })() } });
  const perf = realm.load('../perfDiag');
  perf.perfEvent = (event, fields) => lines.push({ event, ...fields });
  class Port {
    onmessage = null; onerror = null; onmessageerror = null; generation = 0;
    postMessage(message) {
      queueMicrotask(() => {
        let value;
        if (message.type === 'init') { this.generation = message.workerGeneration; value = { protocol: 1, type: 'ready', workerGeneration: this.generation }; }
        else if (message.type === 'install-input') value = { protocol: 1, type: 'input-installed', inputHandle: message.inputHandle };
        else if (message.type === 'run') value = { protocol: 1, type: 'result', requestId: message.requestId,
          workerGeneration: message.workerGeneration, kind: message.kind, stamp: message.stamp,
          status: responseStatus, ...(responseStatus === 'ready' ? { value: null } : { code: 'X', message: 'failed' }),
          ...(diag ? { diag } : {}) };
        else return;
        this.onmessage?.({ data: realm.dto(value) });
      });
    }
    terminate() {}
  }
  const client = realm.load('./computeClient').createComputeClient({ workerFactory: () => new Port(), watchdogMs: 1000 });
  const stamp = realm.dto({ scope: { iidxId: null, epoch: 1 }, rowsRevision: 1, chartsRevision: 1, modelRevision: '', dataRevision: '', optionsKey: '{}' });
  client.installInput('input', realm.dto({ stamp, data: { rows: [], osrCharts: [], notInInf: [], songs: [] } }));
  const spec = { kind: 'r-star', inputHandle: 'input', stamp, options: realm.dto({}), isCurrent: () => true };
  return { client, spec, lines, close: () => client.dispose() };
}
const events = h => h.lines.filter(line => line.event === 'compute-result-stage');

test('ready result stages preserve result and report ordered string durations', async () => {
  const h = setup();
  try {
    const result = await h.client.submit(h.spec).promise;
    assert.equal(result.status, 'ready'); assert.equal(result.value, null);
    const stages = events(h);
    assert.deepEqual(stages.map(x => x.stage), ['receiver-entry', 'event-data-access', 'pending-match', 'promise-continuation-entry', 'cache-stringify', 'cache-utf8-bytes', 'cache-set', 'decode', 'subscriber-clone', 'prune', 'finish']);
    for (const stage of stages) assert.match(stage.durMs, /^\d+\.\d{3}$/);
    assert.ok(stages.every(x => x.requestId === 1 && x.kind === 'r-star' && x.origin === 'worker'));
  } finally { h.close(); }
});

test('cache hit emits cache origin and preserves value', async () => {
  const h = setup();
  try {
    assert.equal((await h.client.submit(h.spec).promise).value, null);
    h.lines.length = 0;
    const result = await h.client.submit(h.spec).promise;
    assert.equal(result.value, null);
    assert.ok(events(h).some(x => x.stage === 'cache-hit-clone-decode' && x.origin === 'cache'));
    assert.equal(events(h).at(-1).stage, 'finish');
  } finally { h.close(); }
});

test('error result completes unchanged and records error path', async () => {
  const h = setup({ responseStatus: 'error' });
  try {
    const result = await h.client.submit(h.spec).promise;
    assert.equal(result.status, 'error'); assert.equal(result.code, 'X'); assert.equal(result.message, 'failed');
    assert.ok(events(h).some(x => x.stage === 'error-response'));
  } finally { h.close(); }
});

test('worker transport diag is optional and records only valid version one values', async () => {
  const h = setup({ diag: { version: 1, workerReadyEpochMs: 999, valueBytes: 5, entriesCount: 2, allChartsCount: 3, encodeMs: 1, dtoValidateMs: 2, sizeMeasureMs: 3 } });
  try {
    const result = await h.client.submit(h.spec).promise;
    assert.equal(result.status, 'ready');
    const upper = events(h).find(x => x.stage === 'transport-upper');
    assert.equal(upper.available, true); assert.equal(upper.valueBytes, 5); assert.match(upper.transportUpperMs, /^\d+\.\d{3}$/);
  } finally { h.close(); }
  const absent = setup();
  try {
    await absent.client.submit(absent.spec).promise;
    assert.equal(events(absent).some(x => x.stage === 'transport-upper'), false);
  } finally { absent.close(); }
});
