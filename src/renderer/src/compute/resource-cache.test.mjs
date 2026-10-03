import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const module = { exports: {} };
const source = fs.readFileSync(new URL('./resourceCache.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: module.exports });
const { createResourceCache } = module.exports;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('joins in-flight work and retains completed values including falsy values', async () => {
  for (const value of [null, 0]) {
    const cache = createResourceCache();
    const gate = deferred();
    let calls = 0;
    const factory = () => { calls++; return gate.promise; };
    const first = cache.load('key', factory);
    const second = cache.load('key', factory);
    await Promise.resolve();
    assert.equal(calls, 1);
    gate.resolve(value);
    assert.equal(await first, value);
    assert.equal(await second, value);
    await Promise.resolve();
    assert.equal(await cache.load('key', factory), value);
    assert.equal(calls, 1);
    assert.equal(cache.stats.hit, 1);
    assert.equal(cache.stats.inFlightJoin, 1);
  }
});

test('retries after rejected and synchronously throwing factories', async () => {
  const cache = createResourceCache();
  await assert.rejects(cache.load('reject', () => Promise.reject(new Error('no'))));
  assert.equal(await cache.load('reject', async () => 7), 7);
  await assert.rejects(cache.load('throw', () => { throw new Error('sync'); }));
  assert.equal(await cache.load('throw', async () => 8), 8);
});

for (const order of ['old-then-new', 'new-then-old']) {
  test(`force generation keeps newest value (${order}) and old finally cannot detach new work`, async () => {
    const cache = createResourceCache();
    const oldGate = deferred(), newGate = deferred();
    let oldCalls = 0, newCalls = 0;
    const old = cache.load('key', () => { oldCalls++; return oldGate.promise; });
    const fresh = cache.load('key', () => { newCalls++; return newGate.promise; }, { force: true });
    if (order === 'old-then-new') {
      oldGate.resolve('old');
      assert.equal(await old, 'old');
      const joined = cache.load('key', async () => { throw new Error('duplicate new'); });
      assert.equal(newCalls, 1);
      newGate.resolve('new');
      assert.equal(await fresh, 'new');
      assert.equal(await joined, 'new');
    } else {
      newGate.resolve('new');
      assert.equal(await fresh, 'new');
      oldGate.resolve('old');
      assert.equal(await old, 'old');
    }
    assert.equal(await cache.load('key', async () => 'wrong'), 'new');
    assert.equal(oldCalls, 1);
    assert.equal(newCalls, 1);
  });
}

test('invalidate and clear prevent pending completions from repopulating cache', async () => {
  for (const invalidate of [true, false]) {
    const cache = createResourceCache();
    const gate = deferred();
    const pending = cache.load('key', () => gate.promise);
    if (invalidate) cache.invalidate('key'); else cache.clear();
    gate.resolve('stale');
    await pending;
    assert.equal(await cache.load('key', async () => 'current'), 'current');
  }
});

test('different keys start independently', async () => {
  const cache = createResourceCache();
  const a = deferred(), b = deferred();
  const pa = cache.load('a', () => a.promise);
  const pb = cache.load('b', () => b.promise);
  b.resolve(2);
  assert.equal(await pb, 2);
  a.resolve(1);
  assert.equal(await pa, 1);
});
