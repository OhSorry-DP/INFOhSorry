import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadTs(path, imports = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(output, { exports: module.exports, require: (id) => imports[id] ?? {}, Set, Map, Object, Array, Number, JSON, TypeError, RangeError, RegExp, String });
  return module.exports;
}
const protocol = loadTs('./protocol.ts');
const revision = loadTs('./revisionKey.ts', { './protocol': protocol });
const bundle = { __typeOnly: true };
const gate = loadTs('./analysisUploadGate.ts', { './protocol': protocol, './revisionKey': revision, './acceptedBundle': bundle });
const { canUploadAnalysis, analysisUploadKey, createAnalysisUploadLedger } = gate;

function fixture() {
  const scope = { iidxId: '12345678-1234-1234-1234-123456789abc', epoch: 7 };
  const common = { scope, rowsRevision: 11, chartsRevision: 13, modelRevision: 'model-1', dataRevision: 'data-1', optionsKey: 'opts' };
  const weaknessStamp = { ...common, modelRevision: 'weak-model', dataRevision: 'weak-data', optionsKey: 'weak-options' };
  const patternStamp = { ...common, modelRevision: 'pattern-model', dataRevision: 'pattern-data', optionsKey: 'pattern-options' };
  const expected = { targetId: scope.iidxId, remote: false, scope, inputHandle: 'handle-a', weaknessStamp, patternStamp, intentToken: 0 };
  const weakness = { status: 'ready', stamp: weaknessStamp, inputHandle: 'handle-a', value: { vec: { score: 1, __entries: [1] }, allCharts: [] } };
  const pattern = { status: 'ready', stamp: patternStamp, inputHandle: 'handle-a', value: { vec: { score: 2 }, digest: 'a'.repeat(64) } };
  return { scope, common, weaknessStamp, patternStamp, expected, weakness, pattern };
}

test('accepts only a current, complete local analysis pair', () => {
  const f = fixture();
  assert.equal(canUploadAnalysis(f.weakness, f.pattern, f.expected), true);
  assert.equal(canUploadAnalysis(f.weakness, f.pattern, { ...f.expected, remote: true }), false);
  assert.equal(canUploadAnalysis(f.weakness, f.pattern, { ...f.expected, targetId: '' }), false);
  assert.equal(canUploadAnalysis(f.weakness, f.pattern, { ...f.expected, targetId: 'other' }), false);
  assert.equal(canUploadAnalysis(f.weakness, f.pattern, { ...f.expected, targetId: f.scope.iidxId.replaceAll('-', '').toUpperCase() }), true);
});

test('rejects a change in every expected stamp axis for either task', () => {
  const f = fixture();
  for (const axis of ['scope', 'rowsRevision', 'chartsRevision', 'modelRevision', 'dataRevision', 'optionsKey']) {
    const changed = { ...f.weaknessStamp, [axis]: axis === 'scope' ? { ...f.scope, epoch: 8 } : axis === 'rowsRevision' || axis === 'chartsRevision' ? f.weaknessStamp[axis] + 1 : `${f.weaknessStamp[axis]}-changed` };
    assert.equal(canUploadAnalysis({ ...f.weakness, stamp: changed }, f.pattern, f.expected), false, `weakness ${axis}`);
    const changedPattern = { ...f.patternStamp, [axis]: axis === 'scope' ? { ...f.scope, epoch: 8 } : axis === 'rowsRevision' || axis === 'chartsRevision' ? f.patternStamp[axis] + 1 : `${f.patternStamp[axis]}-changed` };
    assert.equal(canUploadAnalysis(f.weakness, { ...f.pattern, stamp: changedPattern }, f.expected), false, `pattern ${axis}`);
  }
});

test('rejects owner, handle, mismatched task revisions, non-ready and null results', () => {
  const f = fixture();
  assert.equal(canUploadAnalysis(f.weakness, f.pattern, { ...f.expected, scope: { ...f.scope, iidxId: 'different' } }), false);
  assert.equal(canUploadAnalysis({ ...f.weakness, inputHandle: 'old' }, f.pattern, f.expected), false);
  assert.equal(canUploadAnalysis(f.weakness, { ...f.pattern, stamp: { ...f.patternStamp, rowsRevision: 12 } }, f.expected), false);
  for (const status of ['pending', 'error']) assert.equal(canUploadAnalysis({ ...f.weakness, status }, f.pattern, f.expected), false);
  assert.equal(canUploadAnalysis({ ...f.weakness, value: null }, f.pattern, f.expected), false);
  assert.equal(canUploadAnalysis(f.weakness, { ...f.pattern, value: null }, f.expected), false);
  assert.equal(canUploadAnalysis({ ...f.weakness, value: { vec: { score: 9, __entries: [1] }, allCharts: [] } }, f.pattern, f.expected), true);
});

test('validates payload shapes and sha256 digest', () => {
  const f = fixture();
  for (const digest of ['', 'f'.repeat(63), 'g'.repeat(64)]) assert.equal(canUploadAnalysis(f.weakness, { ...f.pattern, value: { ...f.pattern.value, digest } }, f.expected), false);
  assert.equal(canUploadAnalysis(f.weakness, { ...f.pattern, value: { vec: { score: 2 }, digest: 'b'.repeat(64) } }, f.expected), true);
  assert.equal(canUploadAnalysis({ ...f.weakness, value: { vec: { __entries: 'bad' }, allCharts: [] } }, f.pattern, f.expected), false);
  assert.equal(canUploadAnalysis({ ...f.weakness, value: { vec: { __entries: [1, NaN] }, allCharts: [] } }, f.pattern, f.expected), false);
});

test('keys include content stamps and intent, excluding handles and row/chart revisions', () => {
  const f = fixture();
  const digest = f.pattern.value.digest;
  const base = analysisUploadKey(f.expected, digest);
  assert.notEqual(base, analysisUploadKey({ ...f.expected, intentToken: 1 }, digest));
  assert.notEqual(base, analysisUploadKey(f.expected, 'c'.repeat(64)));
  assert.notEqual(base, analysisUploadKey({ ...f.expected, weaknessStamp: { ...f.weaknessStamp, modelRevision: 'new' } }, digest));
  assert.notEqual(base, analysisUploadKey({ ...f.expected, patternStamp: { ...f.patternStamp, dataRevision: 'new' } }, digest));
  assert.equal(base, analysisUploadKey({ ...f.expected, inputHandle: 'another', weaknessStamp: { ...f.weaknessStamp, rowsRevision: 90, chartsRevision: 91 }, patternStamp: { ...f.patternStamp, rowsRevision: 90, chartsRevision: 91 } }, digest));
});

test('same content deduplicates in flight and after success; new intent is allowed', () => {
  const ledger = createAnalysisUploadLedger();
  const token = ledger.reserve('same');
  assert.equal(typeof token, 'number');
  assert.equal(ledger.reserve('same'), null);
  assert.equal(ledger.finish(token, true, true), true);
  assert.equal(ledger.reserve('same'), null);
  assert.equal(typeof ledger.reserve('same-new-intent'), 'number');
});

test('failure, exception release, stale success and explicit release permit retry', () => {
  const ledger = createAnalysisUploadLedger();
  let token = ledger.reserve('failed');
  assert.equal(ledger.finish(token, false, true), true);
  token = ledger.reserve('failed');
  assert.equal(typeof token, 'number');
  assert.equal(ledger.release(token), true); // caller's finally after a throw
  token = ledger.reserve('failed');
  assert.equal(ledger.finish(token, true, false), true);
  assert.equal(typeof ledger.reserve('failed'), 'number');
});

test('old token completion cannot clear a newer retry reservation', () => {
  const ledger = createAnalysisUploadLedger();
  const old = ledger.reserve('k');
  assert.equal(ledger.finish(old, false, true), true);
  const retry = ledger.reserve('k');
  assert.equal(ledger.finish(old, true, true), false);
  assert.equal(ledger.reserve('k'), null);
  assert.equal(ledger.finish(retry, false, true), true);
  assert.equal(typeof ledger.reserve('k'), 'number');
});

test('bounded LRU evicts completed entries and refuses work when in-flight fills capacity', () => {
  const ledger = createAnalysisUploadLedger(2);
  let t = ledger.reserve('one'); ledger.finish(t, true, true);
  t = ledger.reserve('two'); ledger.finish(t, true, true);
  assert.equal(ledger.reserve('one'), null); // touch one; it becomes newest
  t = ledger.reserve('three'); ledger.finish(t, true, true); // evicts two
  assert.equal(typeof ledger.reserve('two'), 'number'); // evicted success can be retried
  const retryLedger = createAnalysisUploadLedger(2);
  let retry = retryLedger.reserve('one'); retryLedger.finish(retry, true, true);
  retry = retryLedger.reserve('two'); retryLedger.finish(retry, true, true);
  assert.equal(retryLedger.reserve('one'), null); // touch one, so two is oldest
  retry = retryLedger.reserve('three'); retryLedger.finish(retry, true, true); // evicts two
  retry = retryLedger.reserve('four');
  assert.equal(typeof retry, 'number'); // evicted key does not occupy a slot
  const bounded = createAnalysisUploadLedger(2);
  const a = bounded.reserve('a'); const b = bounded.reserve('b');
  assert.equal(bounded.reserve('c'), null);
  assert.equal(bounded.release(a), true);
  assert.equal(typeof bounded.reserve('c'), 'number');
  bounded.clear();
  assert.equal(typeof bounded.reserve('b'), 'number'); // token sequence remains monotonic through clear
});

test('fake send harness revalidates immediately before send', () => {
  const f = fixture();
  let sends = 0;
  const sendIfCurrent = (expected) => {
    if (!canUploadAnalysis(f.weakness, f.pattern, expected)) return false;
    sends++;
    return true;
  };
  assert.equal(sendIfCurrent(f.expected), true);
  assert.equal(sendIfCurrent({ ...f.expected, patternStamp: { ...f.patternStamp, optionsKey: 'changed' } }), false);
  assert.equal(sends, 1);
});
