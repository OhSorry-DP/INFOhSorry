import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(name) {
  const module = { exports: {} };
  const source = fs.readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { exports: module.exports, require: () => ({}) });
  return module.exports;
}

const { createResultCache, createInFlightRegistry } = load('resultCache');
const { choosePoolSize } = load('poolPolicy');

test('pool size applies reserve and cap; invalid inputs use one worker', () => {
  for (const [hardware, expected] of [[1, 1], [2, 1], [4, 3], [8, 4]])
    assert.equal(choosePoolSize(hardware), expected);
  for (const invalid of [0, -1, NaN, Infinity, -Infinity, undefined, '8', null])
    assert.equal(choosePoolSize(invalid), 1);
  assert.equal(choosePoolSize(4.8), 3);
});

test('LRU get refreshes recency and overwrite updates count and bytes', () => {
  const cache = createResultCache({ maxEntries: 2, maxBytes: 20 });
  cache.set('a', 'A', 4, 'owner');
  cache.set('b', 'B', 5, 'owner');
  assert.equal(cache.get('a'), 'A');
  cache.set('c', 'C', 6, 'owner');
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.count, 2);
  assert.equal(cache.bytes, 10);
  cache.set('a', 'A2', 7, 'owner');
  assert.equal(cache.count, 2);
  assert.equal(cache.bytes, 13);
  assert.equal(cache.get('a'), 'A2');
});

test('byte budget evicts LRU and oversize entries are not stored', () => {
  const cache = createResultCache({ maxEntries: 5, maxBytes: 10 });
  cache.set('a', {}, 4, 'owner');
  cache.set('b', {}, 4, 'owner');
  cache.set('c', {}, 4, 'owner');
  assert.equal(cache.has('a'), false);
  assert.equal(cache.bytes, 8);
  assert.equal(cache.set('huge', {}, 11, 'owner'), false);
  assert.equal(cache.has('huge'), false);
  assert.equal(cache.bytes, 8);
});

test('null is a hit; owner invalidation is scoped; clear resets bytes', () => {
  const cache = createResultCache({ maxEntries: 4, maxBytes: 30 });
  cache.set('a', null, 3, 'A');
  cache.set('b', { ok: true }, 7, 'B');
  assert.equal(cache.has('a'), true);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.invalidateOwner('A'), 1);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.bytes, 7);
  cache.clear();
  assert.equal(cache.count, 0);
  assert.equal(cache.bytes, 0);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('in-flight success is shared and removed on completion', async () => {
  const registry = createInFlightRegistry();
  const gate = deferred();
  let calls = 0;
  const first = registry.run('key', () => { calls += 1; return gate.promise; });
  const second = registry.run('key', () => { calls += 1; return 'unused'; });
  assert.equal(first, second);
  assert.equal(calls, 0); // factory runs on the next microtask
  gate.resolve(42);
  assert.equal(await first, 42);
  assert.equal(calls, 1);
  assert.equal(registry.count, 0);
});

test('in-flight failure and synchronous throw are removed for retry', async () => {
  const registry = createInFlightRegistry();
  const failed = deferred();
  const first = registry.run('failure', () => failed.promise);
  const shared = registry.run('failure', () => 1);
  assert.equal(first, shared);
  failed.reject(new Error('failed'));
  await assert.rejects(first, /failed/);
  assert.equal(registry.count, 0);

  await assert.rejects(registry.run('throw', () => { throw new Error('sync'); }), /sync/);
  assert.equal(registry.count, 0);
  assert.equal(await registry.run('throw', () => 7), 7);
});

test('old in-flight finally cannot delete a request added after invalidation', async () => {
  const registry = createInFlightRegistry();
  const oldGate = deferred();
  const newGate = deferred();
  const oldRequest = registry.run('same', () => oldGate.promise);
  registry.invalidate('same');
  const newRequest = registry.run('same', () => newGate.promise);
  assert.notEqual(oldRequest, newRequest);
  oldGate.resolve('old');
  assert.equal(await oldRequest, 'old');
  assert.equal(registry.run('same', () => 'wrong'), newRequest);
  newGate.resolve('new');
  assert.equal(await newRequest, 'new');
  assert.equal(registry.count, 0);
});

test('clear also protects later requests from old finally cleanup', async () => {
  const registry = createInFlightRegistry();
  const oldGate = deferred();
  const newGate = deferred();
  const oldRequest = registry.run('key', () => oldGate.promise);
  registry.clear();
  const newRequest = registry.run('key', () => newGate.promise);
  oldGate.resolve(1);
  await oldRequest;
  assert.equal(registry.run('key', () => 3), newRequest);
  newGate.resolve(2);
  assert.equal(await newRequest, 2);
});
