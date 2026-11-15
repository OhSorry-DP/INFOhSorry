import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./account.ts', import.meta.url), 'utf8');
const exports = {};
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(code, { exports, require: () => ({}) });
const { mergeAccountMeta, resolveAccountSnapshotProfile } = exports;
const id = 'A123456789012';
const otherId = 'B123456789012';
const profile = (overrides = {}) => ({ iidxId: id, djName: 'DJ', iidxIdFormatted: id, spRank: null, dpRank: null, spRankInt: null, dpRankInt: null, spRadar: null, dpRadar: null, ...overrides });

test('none 삭제', () => {
  const result = mergeAccountMeta(id, { iidxId: id, spRank: 'A', spRankInt: 12 }, profile({ spRankReadState: 'none' }), 10);
  assert.equal(result.spRank, null); assert.equal(result.spRankInt, null); assert.equal(result.spRankReadState, 'none');
});

test('value 교체', () => {
  const result = mergeAccountMeta(id, { iidxId: id, spRank: 'A', spRankInt: 12 }, profile({ spRank: 'S', spRankInt: 99, spRankReadState: 'value' }), 10);
  assert.equal(result.spRank, 'S'); assert.equal(result.spRankInt, 99); assert.equal(result.spRankReadState, 'value');
});

test('unread 유지', () => {
  const result = mergeAccountMeta(id, { iidxId: id, spRank: 'A', spRankInt: 12, spRankReadState: 'value' }, profile({ spRankReadState: 'unread' }), 10);
  assert.equal(result.spRank, 'A'); assert.equal(result.spRankInt, 12); assert.equal(result.spRankReadState, 'value');
});

test('구 meta', () => {
  const result = mergeAccountMeta(id, { iidxId: id, spRank: 'A', spRankInt: 12 }, profile(), 10);
  assert.equal(result.spRank, 'A'); assert.equal(result.spRankReadState, undefined);
});

test('live 우선', () => {
  const meta = { iidxId: id, profileCapturedAt: 999, spRank: 'OLD', spRankInt: 1, dpRank: 'OLD', dpRankInt: 2, spRankReadState: 'value', dpRankReadState: 'value' };
  const result = resolveAccountSnapshotProfile(id, meta, profile({ spRank: null, spRankInt: null, spRankReadState: 'none', dpRank: 'NEW', dpRankInt: 3, dpRankReadState: 'value' }));
  assert.equal(result.spRank, null); assert.equal(result.spRankInt, null); assert.equal(result.spRankReadState, 'none');
  assert.equal(result.dpRank, 'NEW'); assert.equal(result.dpRankInt, 3); assert.equal(result.dpRankReadState, 'value');
});

test('ID 격리', () => {
  const meta = { iidxId: otherId, spRank: 'OTHER', spRankInt: 7, spRankReadState: 'value' };
  const result = mergeAccountMeta(id, meta, profile(), 10);
  assert.equal(result.spRank, null); assert.equal(result.spRankReadState, undefined);
  assert.equal(resolveAccountSnapshotProfile(id, meta, { ...profile({ spRank: 'OTHER', spRankInt: 7, spRankReadState: 'value' }), iidxId: otherId }), null);
});
