import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealm } from './test-support.mjs';

function setup() {
  const realm = createRealm(), ports = [], sent = [];
  class Port {
    onmessage = null; onerror = null; onmessageerror = null;
    constructor() { ports.push(this); }
    postMessage(message) {
      sent.push(structuredClone(message));
      let reply;
      if (message.type === 'init') reply = { protocol: 1, type: 'ready', workerGeneration: message.workerGeneration };
      if (message.type === 'prepare') reply = { protocol: 1, type: 'prepared', prepareId: message.prepareId,
        workerGeneration: message.workerGeneration, modelRevision: '', dataRevision: '' };
      if (message.type === 'install-input') reply = { protocol: 1, type: 'input-installed', inputHandle: message.inputHandle };
      if (reply) queueMicrotask(() => this.onmessage?.({ data: realm.dto(reply) }));
    }
    terminate() {}
  }
  const client = realm.load('./computeClient').createComputeClient({ workerFactory: () => new Port(), watchdogMs: 10000 });
  const options = realm.dto({}), key = realm.load('./revisionKey').makeOptionsKey;
  const stampOptionsKey = key(options);
  const stamp = realm.dto({ scope: { iidxId: '1111-2222', epoch: 1 }, rowsRevision: 1, chartsRevision: 1,
    modelRevision: '', dataRevision: '', optionsKey: stampOptionsKey });
  client.installInput('input-1', realm.dto({ stamp, data: { rows: [], osrCharts: [], notInInf: [], songs: [] } }));
  const spec = (inputHandle = 'input-1', currentStamp = stamp) => ({ kind: 'r-star', inputHandle,
    stamp: currentStamp, options, isCurrent: () => true });
  const until = async predicate => {
    const end = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > end) throw new Error('test deadline'); await new Promise(r => setTimeout(r, 1)); }
  };
  const deliver = (request, value, extra = {}) => {
    const port = ports.find(candidate => candidate.onmessage);
    queueMicrotask(() => port.onmessage?.({ data: realm.dto({ ...request, type: 'result', status: 'ready', value, ...extra }) }));
  };
  return { realm, client, sent, spec, until, deliver };
}

test('Unicode byte accounting uses exact UTF-8 length and 32 MiB cache budget evicts correctly', () => {
  const realm = createRealm();
  const value = { text: '\uD55C\uAE00\uD83C\uDFB5\u00E9' };
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  assert.ok(bytes > JSON.stringify(value).length);
  const cache = realm.load('./resultCache').createResultCache();
  cache.set('unicode', value, bytes, 'scope');
  cache.set('large', null, 32 * 1024 * 1024 - bytes + 1, 'scope');
  assert.equal(cache.has('unicode'), false);
  assert.equal(cache.has('large'), true);
});

test('valid valueBytes skips renderer stringify and leaves returned value unchanged', async () => {
  const h = setup();
  try {
    const ticket = h.client.submit(h.spec());
    await h.until(() => h.sent.some(message => message.type === 'run'));
    const run = h.sent.findLast(message => message.type === 'run');
    const value = { marker: 'unchanged' }, before = JSON.stringify(value);
    const original = JSON.stringify; let valueStringifies = 0;
    JSON.stringify = function(candidate, ...args) {
      if (candidate && typeof candidate === 'object' && candidate.marker === 'unchanged') valueStringifies++;
      return original.call(this, candidate, ...args);
    };
    h.deliver(run, value, { valueBytes: new TextEncoder().encode(before).byteLength });
    try {
      const response = await ticket.promise;
      assert.equal(response.status, 'ready');
      assert.deepEqual(JSON.parse(original(response.value)), JSON.parse(before));
      assert.equal(valueStringifies, 0);
    } finally { JSON.stringify = original; }
  } finally { h.client.dispose(); }
});

test('missing and invalid valueBytes use renderer exact JSON UTF-8 fallback', async () => {
  for (const metadata of ['missing', 'invalid']) {
    const h = setup();
    try {
      const ticket = h.client.submit(h.spec());
      await h.until(() => h.sent.some(message => message.type === 'run'));
      const run = h.sent.findLast(message => message.type === 'run');
      const value = { marker: `fallback-${metadata}` }, original = JSON.stringify;
      let valueStringifies = 0;
      JSON.stringify = function(candidate, ...args) {
        if (candidate && typeof candidate === 'object') valueStringifies++;
        return original.call(this, candidate, ...args);
      };
      h.deliver(run, value, metadata === 'missing' ? {} : { valueBytes: -1 });
      try {
        assert.equal((await ticket.promise).status, 'ready');
        assert.equal(valueStringifies, 1);
      } finally { JSON.stringify = original; h.client.dispose(); }
    } catch (error) { h.client.dispose(); throw error; }
  }
});

test('stale result is rejected before it can populate cache', async () => {
  const h = setup();
  try {
    const oldTicket = h.client.submit(h.spec());
    await h.until(() => h.sent.some(message => message.type === 'run'));
    const firstRun = h.sent.findLast(message => message.type === 'run');
    const newer = h.realm.dto({ scope: { iidxId: '1111-2222', epoch: 1 }, rowsRevision: 2,
      chartsRevision: 1, modelRevision: '', dataRevision: '', optionsKey: '{}' });
    h.client.installInput('input-2', h.realm.dto({ stamp: newer, data: { rows: [], osrCharts: [], notInInf: [], songs: [] } }));
    const next = h.client.submit(h.spec('input-2', newer));
    h.deliver(firstRun, { marker: 'stale' }, { valueBytes: 50 });
    assert.equal((await oldTicket.promise).status, 'error');
    await h.until(() => h.sent.filter(message => message.type === 'run').length >= 2);
    const secondRun = h.sent.filter(message => message.type === 'run').at(-1);
    h.deliver(secondRun, { marker: 'current' }, { valueBytes: 60 });
    assert.equal((await next.promise).status, 'ready');
    assert.equal(h.client.stats.cacheHit, 0);
    assert.equal(h.client.stats.run, 2);
  } finally { h.client.dispose(); }
});
