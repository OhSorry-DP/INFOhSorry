import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRealm } from './test-support.mjs';
import { inspectPerf } from '../../../../scratchpad/s133/smoke-packaged-worker.mjs';

function harness() {
  const perf = [];
  const realm = createRealm(), held = [], ports = [], slots = [], effects = [];
  class Port {
    onmessage = null; onerror = null; onmessageerror = null;
    constructor() { ports.push(this); }
    postMessage(m) {
      const deliver = value => this.onmessage?.({ data: realm.dto(value) });
      if (m.type === 'init') queueMicrotask(() => deliver({ protocol: 1, type: 'ready', workerGeneration: m.workerGeneration }));
      if (m.type === 'prepare') queueMicrotask(() => deliver({ protocol: 1, type: 'prepared', prepareId: m.prepareId,
        workerGeneration: m.workerGeneration, modelRevision: 'm', dataRevision: 'd' }));
      if (m.type === 'install-input') queueMicrotask(() => deliver({ protocol: 1, type: 'input-installed', inputHandle: m.inputHandle }));
      if (m.type === 'run') held.push({ m, deliver, port: this });
    }
    terminate() {}
  }
  const client = realm.load('./computeClient').createComputeClient({ hardwareConcurrency: 8, workerFactory: () => new Port(), watchdogMs: 5000 });
  let cursor = 0, dirty = true, output, serial = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) effects.push(() => {
      slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const source = fs.readFileSync(new URL('./useComputeTask.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const hook = {};
  vm.runInContext(`(function(exports, require) { ${compiled}\n})`, realm.context)(hook, name => {
    if (name === 'react') return react;
    if (name === './rendererService') return { computeClient: client };
    if (name === '../perfDiag') return { beginPerf: () => ({}), endPerf: (...args) => perf.push(args) };
    return realm.load(name);
  });
  const makeInput = (id = 'A', epoch = 1) => {
    const handle = `rows-${++serial}`;
    const stamp = realm.dto({ scope: { iidxId: id, epoch }, rowsRevision: serial, chartsRevision: serial,
      modelRevision: '', dataRevision: '', optionsKey: '{}' });
    let installed = false;
    return { handle, stamp, ensure() { if (!installed) { installed = true;
      client.installInput(handle, realm.dto({ stamp, data: { rows: [], osrCharts: [], notInInf: [], songs: [] } })); } } };
  };
  const args = { input: makeInput(), resources: realm.dto([]), enabled: true, current: true };
  function render() { cursor = 0; dirty = false;
    output = ['weakness', 'pattern-score'].map(kind => hook.useComputeTask(kind, args.input,
      realm.dto({ adapter: 'analysis-songcharts-v1' }), args.resources, args.enabled, () => args.current,
      undefined, { entryId: 1, chartsRev: args.input.stamp.chartsRevision }));
    effects.splice(0).forEach(fn => fn()); return output; }
  async function pump(predicate = () => held.length > 0) {
    for (let i = 0; i < 300; i++) { if (dirty) render(); await new Promise(resolve => setTimeout(resolve, 1));
      if (dirty) render(); if (predicate()) return; }
    throw new Error('recommend service harness timeout');
  }
  function deliver(value, error = false) { const job = held.shift(); assert.ok(job, 'pending Worker run');
    job.deliver({ ...job.m, type: error ? 'error' : 'result', status: error ? 'error' : 'ready',
      ...(error ? { code: 'INJECTED', message: 'injected context failure' } : { value }) }); return job; }
  async function ready() { render(); await pump(); deliver({ contextHandle: 'ctx', coreVersion: 'test' });
    await pump(() => !!output.service); return output.service; }
  return { realm, client, args, held, perf, ports, render, pump, deliver, ready, makeInput,
    strictReplay() { slots.forEach(slot => { if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined; slot.deps = undefined; } }); render(); },
    get output() { return output; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); }, dispose() { slots.forEach(slot => slot?.cleanup?.()); client.dispose(); } };
}

test('two analysis hook requests run independently and stale chart results never become ready', async () => {
  const h = harness();
  try {
    h.render(); await h.pump(() => h.held.length === 2);
    assert.notEqual(h.held[0].port, h.held[1].port);
    const old = h.args.input;
    h.args.input = h.makeInput(); h.render();
    h.deliver({ vec: { __entries: [], NOTES: 1 }, allCharts: [] });
    h.deliver({ vec: { NOTES: 1 }, digest: 'a'.repeat(64) });
    await h.pump(() => h.held.length === 2);
    assert.ok(h.output.every(x => x.task.status === 'pending'));
    h.deliver({ vec: { __entries: [], NOTES: 2 }, allCharts: [] });
    h.deliver({ vec: { NOTES: 2 }, digest: 'b'.repeat(64) });
    await h.pump(() => h.output.every(x => x.task.status === 'ready'));
    assert.ok(h.output.every(x => x.task.inputHandle !== old.handle));
    assert.ok(h.perf.filter(p => p[5] === 'ok').length === 2);
  } finally { h.dispose(); }
});
test('scope A to B to A, resource generation, unmount and StrictMode reject late acceptance', async () => {
  const h = harness();
  try {
    h.render(); await h.pump(() => h.held.length === 2);
    h.args.current = false; h.render(); h.unmount();
    h.deliver(null); h.deliver(null);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(h.perf.filter(p => p[5] === 'ok').length, 0);
    for (const [id, epoch] of [['B',2], ['A',3]]) {
      h.args.input = h.makeInput(id, epoch); h.args.current = true;
      h.args.resources = h.realm.dto([{ key: 'x', url: null }]); h.strictReplay();
      await h.pump(() => h.held.length === 2);
      h.deliver(null); h.deliver(null);
      await h.pump(() => h.output.every(x => x.task.status === 'ready'));
      assert.ok(h.output.every(x => x.task.stamp.scope.epoch === epoch));
    }
  } finally { h.dispose(); }
});
test('analysis error is explicit, retry does not cache failure, same stamp cache remount confirms entry', async () => {
  const h = harness();
  try {
    h.render(); await h.pump(() => h.held.length === 2);
    h.deliver(null, true); h.deliver(null);
    await h.pump(() => h.output[0].task.status === 'error');
    h.output[0].retry(); h.render(); await h.pump();
    h.deliver({ vec: { NOTES: 3, __entries: [] }, allCharts: [] });
    await h.pump(() => h.output[0].task.status === 'ready');
    const count = h.client.stats.run; h.strictReplay();
    await h.pump(() => h.output.every(x => x.task.status === 'ready'));
    assert.equal(h.client.stats.run, count);
  } finally { h.dispose(); }
});

function uploadHarness() {
  const calls = []; let response = async () => ({ ok: true });
  const realm = createRealm({ fetch: async (url, init) => { calls.push({ url, init }); return response(); } });
  const source = fs.readFileSync(new URL('../Analysis.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const api = {};
  vm.runInContext(`(function(exports, require) { ${compiled}\n})`, realm.context)(api, name => {
    if (name === 'react' || name === 'react/jsx-runtime') return {};
    if (name === './api') return { IS_BROWSER_REMOTE: false };
    if (name === './compute/useComputeTask') return {};
    return realm.load('../' + name);
  });
  const gate = realm.load('./analysisUploadGate');
  const stamp = { scope: { iidxId: '12345678', epoch: 1 }, rowsRevision: 1, chartsRevision: 2,
    modelRevision: 's4-model', dataRevision: 'data', optionsKey: '{"adapter":"analysis-songcharts-v1"}' };
  const weakness = realm.dto({ status: 'ready', inputHandle: 'analysis', requestId: 1, workerGeneration: 1,
    stamp, value: { vec: { __entries: [], NOTES: 1 }, allCharts: [] } });
  const pattern = realm.dto({ status: 'ready', inputHandle: 'analysis', requestId: 2, workerGeneration: 1,
    stamp: { ...stamp, dataRevision: 'features' }, value: { vec: { NOTES: 1, HANDS: 2 }, digest: 'a'.repeat(64) } });
  const expected = realm.dto({ targetId: '1234-5678', remote: false, scope: stamp.scope,
    inputHandle: 'analysis', weaknessStamp: weakness.stamp, patternStamp: pattern.stamp, intentToken: 0 });
  return { api, calls, gate, weakness, pattern, expected,
    response(fn) { response = fn; }, send: current => api.sendAnalysisUpload(weakness, pattern, expected, current) };
}

test('production upload preserves all RPC fields and numOrNull, dedups content and distinguishes intents', async () => {
  const h = uploadHarness(); h.gate.analysisUploadLedger.clear();
  const axes = ['NOTES','CHORD','PEAK','CHARGE','SCRATCH','SOF-LAN','PHRASE','JACK','TRILL','RAND',
    'STAIR_UP_L','STAIR_UP_R','STAIR_DN_L','STAIR_DN_R', ...Array.from({length:7}, (_,i)=>[`K${i+1}_L`,`K${i+1}_R`]).flat(),
    'DOUBLE_STAIR_L','DOUBLE_STAIR_R','KEIMA_L','KEIMA_R','HSTAIR_ONEHAND','HSTAIR_SYNC','HSTAIR_SAMESHAPE','HSTAIR_DIFFSHAPE','HANDS'];
  axes.forEach((k,i) => h.pattern.value.vec[k] = i + .25);
  h.pattern.value.vec.PEAK = NaN; h.pattern.value.vec.CHARGE = Infinity; h.pattern.value.vec.JACK = undefined;
  assert.equal(await h.api.upsertFeatureScore(h.expected.targetId, h.pattern.value.vec, () => true), true);
  const expectedBody = { p_iidx_id: '12345678' };
  axes.forEach(k => { const v = h.pattern.value.vec[k];
    expectedBody['p_os_' + k.toLowerCase().replace('-','')] = Number.isFinite(v) ? v : null; });
  assert.deepEqual(JSON.parse(h.calls[0].init.body), expectedBody);
  assert.equal(h.calls[0].init.method, 'POST');
  assert.match(h.calls[0].url, /rpc\/upsert_user_feature_score$/);
  h.pattern.value.vec.PEAK = 1; h.pattern.value.vec.CHARGE = 2; h.pattern.value.vec.JACK = 3;
  assert.equal(await h.send(() => true), true);
  assert.equal(await h.send(() => true), false); assert.equal(h.calls.length, 2);
  h.expected.intentToken++; assert.equal(await h.send(() => true), true);
  h.pattern.value.vec.CHORD++; h.pattern.value.digest = 'b'.repeat(64);
  assert.equal(await h.send(() => true), true);
});

test('remote, owner mismatch, full stamp drift and account switch immediately before sending produce zero RPCs', async () => {
  for (const mutate of [
    h => { h.expected.remote = true; }, h => { h.expected.targetId = '99999999'; },
    h => { h.expected.weaknessStamp.modelRevision += '-poll'; },
    h => { h.expected.patternStamp.dataRevision += '-poll'; },
    h => { h.pattern.stamp.chartsRevision++; }, h => { h.weakness.inputHandle = 'old'; },
  ]) {
    const h = uploadHarness(); mutate(h);
    assert.equal(await h.send(() => true), false); assert.equal(h.calls.length, 0);
  }
  const h = uploadHarness(); let current = true;
  const request = h.send(() => current); current = false;
  assert.equal(await request, false); assert.equal(h.calls.length, 0);
});
test('failed/stale HTTP releases reservation, inflight duplicates merge, same intent can explicitly retry', async () => {
  const h = uploadHarness(); let resolve; let current = true;
  h.response(() => new Promise(r => resolve = r));
  const first = h.send(() => current); await new Promise(r => setTimeout(r, 0));
  assert.equal(await h.send(() => true), false); assert.equal(h.calls.length, 1);
  current = false; resolve({ ok: true }); assert.equal(await first, false);
  h.response(async () => ({ ok: false })); assert.equal(await h.send(() => true), false);
  h.response(async () => ({ ok: true })); assert.equal(await h.send(() => true), true);
});

test('real UMD object entries and private caches retain their values while numeric gate readiness permits upload', async () => {
  const h = uploadHarness();
  h.weakness.value.vec.__entries = [{ title: 'kept', residual: 0.25 }];
  h.weakness.value.vec.__meta = { matched: 30 };
  h.weakness.value.vec.__vecL = { CHORD: -0.2 };
  const before = structuredClone(h.weakness.value);
  assert.equal(await h.send(() => true), true);
  assert.deepEqual(structuredClone(h.weakness.value), before);
});

test('gist cache source is the exact evaluated bytes; force generations cannot publish late modules', async () => {
  const held = [];
  const realm = createRealm({ fetch: async () => new Promise(resolve => held.push(resolve)) });
  const loader = realm.load('../gistLib');
  const one = loader.loadGistModuleSource('https://test/module.js', 'Source');
  held.shift()({ ok: true, text: async () => 'window.Source={version:1};' });
  const source = await one;
  assert.equal(source.source, 'window.Source={version:1};');
  assert.equal(await loader.loadGistModuleSource('https://test/module.js', 'Source'), source);
  const slow = loader.loadGistModuleSource('https://test/module.js', 'Source', true);
  const old = held.shift();
  const stale = assert.rejects(slow, /STALE_MODULE_LOAD/);
  const newest = loader.loadGistModuleSource('https://test/module.js', 'Source', true);
  held.shift()({ ok: true, text: async () => 'window.Source={version:3};' });
  assert.equal((await newest).value.version, 3);
  old({ ok: true, text: async () => 'window.Source={version:2};' }); await stale;
  assert.equal((await loader.loadGistModuleSource('https://test/module.js', 'Source')).value.version, 3);
});

test('actual L4 logging with consumer revision suffix satisfies the unchanged L3 smoke parser', () => {
  const lines = [];
  const realm = createRealm({ performance, diagLine: line => lines.push(line) });
  realm.eval('window.infohsorry={diag:{append:diagLine}}');
  const perf = realm.load('../perfDiag');
  const fields = { entryId: 9, chartsRev: 2, epoch: 1, scopeId: perf.perfScopeId('12345678') };
  perf.perfEvent('rows-commit', realm.dto({ source:'account-read', epoch:1, scopeId:fields.scopeId, revision:'7 rowsRev=7 rowsCount=30' }));
  for (const name of ['dp','r','sp','playDataWeakness','recCtx','recommend']) {
    const extra = realm.dto({ revision:'7 rowsRev=7' }); const p = perf.beginPerf(name,7,1,'12345678',extra);
    perf.endPerf(name,p,7,1,'12345678','ok',extra);
  }
  perf.perfEvent('analysis-enter', realm.dto({ ...fields, revision:'7 rowsRev=7' }));
  for (const name of ['analysisWeakness','analysisPatternScore']) {
    const extra = realm.dto({ ...fields, revision:'7 rowsRev=7' }); const p = perf.beginPerf(name,7,1,'12345678',extra);
    perf.endPerf(name,p,7,1,'12345678','ok',extra);
  }
  assert.equal(inspectPerf(lines.join('\n'), 30).pass, true);
});
