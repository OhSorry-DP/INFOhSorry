import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as account from '../../../shared/account.ts';

function loadTs(path, imports = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(output, {
    exports: module.exports,
    require: (id) => imports[id] ?? {},
    Set, Object, Array, Number, JSON, TypeError,
  });
  return module.exports;
}

const protocol = loadTs('./protocol.ts');
const revision = loadTs('./revisionKey.ts', { './protocol': protocol });
const { makeOptionsKey, makeJobKey, scopesEqual, stampsEqual } = revision;
const scope = { iidxId: 'C000000000001', epoch: 3 };
const stamp = {
  scope, rowsRevision: 4, chartsRevision: 5,
  modelRevision: 'model-1', dataRevision: 'data-1', optionsKey: makeOptionsKey({ b: 2, a: 1 }),
};
const request = (overrides = {}) => ({
  protocol: 1, requestId: 10, workerGeneration: 2, kind: 'dp-star', stamp,
  inputHandle: 'input-1', payload: { prevStar: null }, ...overrides,
});

test('options keys canonicalize object keys and preserve array order', () => {
  assert.equal(makeOptionsKey({ a: 1, b: { d: 3, c: 2 } }), makeOptionsKey({ b: { c: 2, d: 3 }, a: 1 }));
  assert.equal(makeOptionsKey({ value: [1, 2] }) === makeOptionsKey({ value: [2, 1] }), false);
  assert.equal(makeOptionsKey({ value: undefined }) === makeOptionsKey({ value: null }), false);
  assert.notEqual(makeOptionsKey(undefined), makeOptionsKey(null));
  assert.equal(makeOptionsKey(-0), makeOptionsKey(0));
});

test('options key rejects cycles, non-finite numbers, and non-JSON values', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, NaN, Infinity, -Infinity, () => 1, Symbol('x'), 1n]) {
    assert.throws(() => makeOptionsKey(value), TypeError);
  }
});

test('job key includes each content stamp field and excludes request identity', () => {
  const base = makeJobKey('dp-star', stamp);
  assert.equal(base, makeJobKey('dp-star', { ...stamp, scope: { ...scope } }));
  assert.equal(base, makeJobKey('dp-star', stamp));
  for (const changed of [
    { ...stamp, scope: { iidxId: 'C000000000002', epoch: 3 } },
    { ...stamp, scope: { ...scope, epoch: 4 } },
    { ...stamp, rowsRevision: 6 }, { ...stamp, chartsRevision: 6 },
    { ...stamp, modelRevision: 'model-2' }, { ...stamp, dataRevision: 'data-2' },
    { ...stamp, optionsKey: 'other' },
  ]) assert.notEqual(makeJobKey('dp-star', changed), base);
  assert.notEqual(makeJobKey('r-star', stamp), base);
  assert.equal(request({ requestId: 11 }).requestId === request().requestId, false);
  assert.equal(makeJobKey(request().kind, request({ requestId: 11 }).stamp), base);
});

test('tuple encoding avoids delimiter collisions in identifiers', () => {
  const a = { ...stamp, scope: { iidxId: 'a:|"', epoch: 1 }, modelRevision: 'b' };
  const b = { ...stamp, scope: { iidxId: 'a', epoch: 1 }, modelRevision: '|"b' };
  assert.notEqual(makeJobKey('dp-star', a), makeJobKey('dp-star', b));
});

test('scope and full stamp equality compare values rather than object identity', () => {
  assert.equal(scopesEqual(scope, { ...scope }), true);
  assert.equal(scopesEqual(scope, { ...scope, epoch: 4 }), false);
  assert.equal(stampsEqual(stamp, { ...stamp, scope: { ...scope } }), true);
  assert.equal(stampsEqual(stamp, { ...stamp, rowsRevision: 9 }), false);
});

test('request and response guards reject malformed versions, kinds and identifiers', () => {
  assert.equal(protocol.isJobRequest(request()), true);
  assert.equal(protocol.isJobRequest(request({ protocol: 0 })), false);
  assert.equal(protocol.isJobRequest(request({ protocol: 2 })), false);
  assert.equal(protocol.isJobRequest(request({ kind: 'unknown' })), false);
  assert.equal(protocol.isJobRequest(request({ requestId: -1 })), false);
  assert.equal(protocol.isJobRequest(request({ workerGeneration: 1.5 })), false);
  assert.equal(protocol.isJobRequest(request({ stamp: { ...stamp, rowsRevision: Number.MAX_SAFE_INTEGER + 1 } })), false);
  assert.equal(protocol.isJobRequest(request({ stamp: { ...stamp, scope: { ...scope, epoch: -1 } } })), false);
  assert.equal(protocol.isJobRequest(request({ stamp: { ...stamp, scope: { ...scope, epoch: 0.5 } } })), false);
  assert.equal(protocol.isJobRequest(request({ stamp: { ...stamp, scope: { ...scope, epoch: Number.MAX_SAFE_INTEGER + 1 } } })), false);
  assert.equal(protocol.isJobRequest(request({ stamp: { ...stamp, scope: { iidxId: 3, epoch: 0 } } })), false);
});

test('ready-null is valid and remains distinct from an error response', () => {
  const ready = { protocol: 1, requestId: 1, workerGeneration: 1, kind: 'dp-star', stamp, status: 'ready', value: null };
  const error = { protocol: 1, requestId: 1, workerGeneration: 1, kind: 'dp-star', stamp, status: 'error', code: 'failed', message: 'failure' };
  assert.equal(protocol.isJobResponse(ready), true);
  assert.equal(protocol.isJobResult(ready), true);
  assert.equal(protocol.isJobError(ready), false);
  assert.equal(protocol.isJobResponse(error), true);
  assert.equal(protocol.isJobError(error), true);
  assert.equal(protocol.isJobResult(error), false);
});

test('control message guards enforce discriminants and plain DTO payloads', () => {
  assert.equal(protocol.isWorkerCommand({ protocol: 1, type: 'init', workerGeneration: 0 }), true);
  assert.equal(protocol.isWorkerCommand({ protocol: 1, type: 'init', workerGeneration: -1 }), false);
  assert.equal(protocol.isWorkerCommand({ protocol: 1, type: 'install-input', inputHandle: 'x', input: { rows: [] } }), true);
  assert.equal(protocol.isWorkerCommand({ protocol: 1, type: 'install-input', inputHandle: 'x', input: new Date() }), false);
  assert.equal(protocol.isWorkerNotification({ protocol: 1, type: 'ready', workerGeneration: 1 }), true);
  assert.equal(protocol.isWorkerNotification({ protocol: 1, type: 'unexpected' }), false);
});
