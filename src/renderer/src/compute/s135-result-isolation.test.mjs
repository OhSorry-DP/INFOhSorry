import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealm } from './test-support.mjs';

function setup(value) {
  const realm = createRealm();
  const receive = value => realm.context.structuredClone(value);
  let runs = 0;
  class Port {
    onmessage = null; onerror = null; onmessageerror = null;
    postMessage(message) {
      if (message.type === 'init') queueMicrotask(() => this.onmessage?.({ data: receive({ protocol: 1, type: 'ready', workerGeneration: message.workerGeneration }) }));
      if (message.type === 'install-input') queueMicrotask(() => this.onmessage?.({ data: receive({ protocol: 1, type: 'input-installed', inputHandle: message.inputHandle }) }));
      if (message.type === 'run') {
        runs++;
        queueMicrotask(() => this.onmessage?.({ data: receive({ protocol: 1, type: 'result', workerGeneration: message.workerGeneration,
          requestId: message.requestId, kind: message.kind, stamp: message.stamp, status: 'ready', value, valueBytes: 1 }) }));
      }
    }
    terminate() {}
  }
  const client = realm.load('./computeClient').createComputeClient({ hardwareConcurrency: 2, workerFactory: () => new Port() });
  const stamp = realm.dto({ scope: { iidxId: '1111-2222', epoch: 1 }, rowsRevision: 1, chartsRevision: 1,
    modelRevision: '', dataRevision: '', optionsKey: '{}' });
  client.installInput('input', realm.dto({ stamp, data: { rows: [], osrCharts: [], notInInf: [], songs: [] } }));
  const spec = { kind: 'r-star', inputHandle: 'input', stamp, options: realm.dto({}), isCurrent: () => true };
  return { realm, client, spec, get runs() { return runs; } };
}

test('coalesced subscribers receive isolated values and stamps', async () => {
  const h = setup({ nested: { items: [1] } });
  try {
    const a = h.client.submit(h.spec), b = h.client.submit(h.spec);
    const [ra, rb] = await Promise.all([a.promise, b.promise]);
    assert.equal(h.runs, 1);
    assert.notEqual(ra.value, rb.value); assert.notEqual(ra.value.nested, rb.value.nested);
    assert.notEqual(ra.stamp, rb.stamp);
    ra.value.nested.items[0] = 9; ra.stamp.scope.epoch = 99;
    assert.equal(rb.value.nested.items[0], 1); assert.equal(rb.stamp.scope.epoch, 1);
  } finally { h.client.dispose(); }
});

test('mutating a first response cannot alter the encoded cache hit; cache and miss values match', async () => {
  const h = setup({ nested: { value: 4 } });
  try {
    const first = h.client.submit(h.spec), miss = await first.promise;
    miss.value.nested.value = 8;
    const hit = await h.client.submit(h.spec).promise;
    assert.equal(hit.status, 'ready'); assert.deepEqual(structuredClone(hit.value), { nested: { value: 4 } });
    assert.equal(hit.value.nested.value, 4); assert.equal(h.runs, 1);
  } finally { h.client.dispose(); }
});

test('special scalars, own undefined, negative zero, arrays and objects are reconstructed', async () => {
  const h = setup({ undef: { __computeScalar: 'undefined' }, nan: { __computeScalar: 'NaN' },
    inf: { __computeScalar: 'Infinity' }, negInf: { __computeScalar: '-Infinity' }, zero: -0,
    arr: [{ __computeScalar: 'undefined' }] });
  try {
    const response = await h.client.submit(h.spec).promise;
    assert.equal(Object.hasOwn(response.value, 'undef'), true); assert.equal(response.value.undef, undefined);
    assert.equal(Number.isNaN(response.value.nan), true); assert.equal(response.value.inf, Infinity);
    assert.equal(response.value.negInf, -Infinity); assert.equal(Object.is(response.value.zero, -0), true);
    assert.equal(response.value.arr[0], undefined); assert.notEqual(response.value.arr, h.spec);
  } finally { h.client.dispose(); }
});

test('accept retains response identity and rejects stale subscribers', async () => {
  const h = setup({ ok: true });
  try {
    let current = true, applied = 0;
    const ticket = h.client.submit({ ...h.spec, isCurrent: () => current });
    const response = await ticket.promise;
    assert.equal(ticket.accept(response, () => applied++), true);
    assert.equal(ticket.accept({ ...response }, () => applied++), false);
    current = false; assert.equal(ticket.accept(response, () => applied++), false);
    assert.equal(applied, 1);
  } finally { h.client.dispose(); }
});

test('cache hit and miss preserve decode stage instrumentation', async () => {
  const h = setup({ nested: [1, 2] });
  try {
    const first = await h.client.submit(h.spec).promise;
    const second = await h.client.submit(h.spec).promise;
    assert.deepEqual(first.value, second.value); assert.equal(h.runs, 1);
  } finally { h.client.dispose(); }
});
