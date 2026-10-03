import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as account from '../../../shared/account.ts';

function loadTs(path, imports = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(output, { exports: module.exports, require: id => imports[id] ?? {}, Object, Array, Number, JSON, TypeError, Set });
  return module.exports;
}
const protocol = loadTs('./protocol.ts');
const revision = loadTs('./revisionKey.ts', { './protocol': protocol });
const api = loadTs('./acceptedBundle.ts', { '../../../shared/account': account, './protocol': protocol, './revisionKey': revision });
const scope = { iidxId: 'C000000000001', epoch: 1 };
const stamp = (x = {}) => ({ scope, rowsRevision: 2, chartsRevision: 3, modelRevision: 'm', dataRevision: 'd', optionsKey: 'o', ...x });
const expected = (x = {}) => ({ kind: 'dp-star', latestRequestId: 10, workerGeneration: 2, inputHandle: 'ih', stamp: stamp(), selectedViewerId: scope.iidxId, rowsScope: scope, accountScope: scope, ...x });
const result = (x = {}) => ({ protocol: 1, kind: 'dp-star', requestId: 10, workerGeneration: 2, inputHandle: 'ih', stamp: stamp(), status: 'ready', value: 0, ...x });

test('rejects stale epochs, revisions, handles, ids, generations and context', () => {
  assert.equal(api.canAccept(result(), expected()), true);
  for (const [res, exp] of [
    [result({ stamp: stamp({ scope: { ...scope, epoch: 0 } }) }), expected()],
    [result({ requestId: 9 }), expected()], [result({ inputHandle: 'other' }), expected()],
    [result({ workerGeneration: 1 }), expected()], [result(), expected({ stamp: stamp({ rowsRevision: 1 }) })],
    [result(), expected({ accountScope: { ...scope, epoch: 2 } })],
    [result(), expected({ context: { contextHandle: 'ctx', contextGeneration: 1 } })],
  ]) assert.equal(api.canAccept(res, exp), false);
  assert.equal(api.canAccept(result(), expected({ selectedViewerId: null })), false);
});

test('bundle readiness handles pending, null, errors, task-specific manifests and invalidation', () => {
  const dp = stamp({ optionsKey: 'dp' }); const r = stamp({ optionsKey: 'r', modelRevision: 'rm', dataRevision: 'rd' }); const sp = stamp({ optionsKey: 'sp' });
  const bundle = { scope, rowsRevision: 2, chartsRevision: 3, modelRevision: 'm', dataRevision: 'd', rowsHandle: 'rows',
    dp: { status: 'ready', stamp: dp, value: 0 }, r: { status: 'pending', stamp: r }, sp: { status: 'ready', stamp: sp, value: null } };
  const exp = { scope, rowsRevision: 2, chartsRevision: 3, modelRevision: 'm', dataRevision: 'd', rowsHandle: 'rows', dp, r, sp, required: ['dp','r','sp'] };
  assert.equal(api.isUploadReady(bundle, exp), false);
  bundle.r = { status: 'ready', stamp: r, value: null }; assert.equal(api.isUploadReady(bundle, exp), true);
  bundle.r = { status: 'error', stamp: r }; assert.equal(api.isUploadReady(bundle, exp), false);
  const invalidated = api.invalidateBundle(bundle, { ...exp, r: stamp({ ...r, optionsKey: 'changed' }) });
  assert.equal(api.isUploadReady(invalidated, { ...exp, r: stamp({ ...r, optionsKey: 'changed' }) }), false);
  const changedScope = { ...scope, epoch: 2 };
  const cleared = api.invalidateBundle(bundle, { ...exp, scope: changedScope, dp: stamp({ scope: changedScope }), r: stamp({ scope: changedScope }), sp: stamp({ scope: changedScope }) });
  assert.equal(cleared.dp.value, undefined); assert.equal(cleared.dp.status, 'pending');
});
