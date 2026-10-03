import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as account from '../../shared/account.ts';

const module = { exports: {} };
const source = fs.readFileSync(new URL('./scopedCalculation.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: module.exports, require: () => account });
const { transferFloor, calculateScoped, reuseOsrInput } = module.exports;
const a = { iidxId: 'C000000000001', epoch: 1 };
const next = { ...a, epoch: 2 };
const floor = { scope: a, starFloor: 5.6, rStarFloor: 1.2 };

test('retained same-owner rows transfer both floors; mixed ownership resets', () => {
  assert.equal(transferFloor(floor, a, a, next, false).starFloor, 5.6);
  assert.equal(transferFloor(floor, a, a, next, false).rStarFloor, 1.2);
  for (const [f, owner, target, clear] of [
    [floor, a, next, true], [floor, { ...a, epoch: 0 }, next, false],
    [{ ...floor, scope: { ...a, epoch: 0 } }, a, next, false],
    [floor, a, { iidxId: 'C000000000002', epoch: 2 }, false],
    [floor, { iidxId: null, epoch: 1 }, next, false],
  ]) assert.equal(transferFloor(f, a, owner, target, clear).starFloor, null);
});

test('epoch retags cached result while rows/model/floor/owner changes rerun', () => {
  let calls = 0;
  const rows = [], model = {}, deps = [rows, model, 5.6];
  const first = calculateScoped(null, a, deps, () => ({ call: ++calls }));
  const retagged = calculateScoped(first, next, deps, () => ({ call: ++calls }));
  assert.equal(calls, 1);
  assert.equal(retagged.value, first.value);
  assert.equal(account.isFloorSeedCurrent(retagged.scope, next), true);
  assert.equal(account.isFloorSeedCurrent(first.scope, next), false);
  for (const changed of [[[], model, 5.6], [rows, {}, 5.6], [rows, model, 6]])
    calculateScoped(retagged, next, changed, () => ++calls);
  calculateScoped(retagged, { iidxId: 'C000000000002', epoch: 3 }, deps, () => ++calls);
  assert.equal(calls, 5);
});

test('OSR rebuild reuses only same owner and exact ordered chart values', () => {
  const input = [{ title: 'song', diff: 'ANOTHER', lampNum: 5 }];
  const cache = { owner: a.iidxId, input };
  assert.equal(reuseOsrInput(cache, a.iidxId, input.map(x => ({ ...x }))), input);
  assert.notEqual(reuseOsrInput(cache, next.iidxId, [{ ...input[0], lampNum: 6 }]), input);
  assert.notEqual(reuseOsrInput(cache, 'C000000000002', [...input]), input);
  assert.notEqual(reuseOsrInput(cache, a.iidxId, []), input);
});

test('App wires floor migration and Worker scope guards', () => {
  const app = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  assert.match(app, /setFloorState\(\(floor\) => transferFloor\(floor, previous, previousRowsOwner, scope, clearRows\)\)/);
  assert.match(app, /isFloorSeedCurrent\(workerInput.stamp.scope, accountScopeRef.current\)/);
  assert.match(app, /isFloorSeedCurrent\(workerInput.stamp.scope, rowsScopeRef.current\)/);
});
