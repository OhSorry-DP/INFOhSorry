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
  const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const gate = app.match(/const analysisCurrent = \(\) => ([\s\S]*?);/)[1];
  const appCurrent = new Function('analysisLive', 'analysisInput', 'isFloorSeedCurrent', 'accountScopeRef', 'rowsScopeRef', 'selectedViewerIdRef', 'rowsRevisionRef', `return ${gate}`);
  const analysisSource = fs.readFileSync(new URL('../Analysis.tsx', import.meta.url), 'utf8');
  const snapshotSource = analysisSource.slice(analysisSource.indexOf('  const resourceToken ='), analysisSource.indexOf('  const [personal,'));
  const snapshotCompiled = ts.transpileModule(`function snapshot(bundle: any, ratingData: any, zasaData: any) {
    ${snapshotSource}
    return resources;
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const snapshot = new Function('useMemo', 'useState', 'useRef', 'useEffect', 'DEFAULT_RESOURCES', 'span', 'finish', 'setError', 'URL', 'Blob',
    `${snapshotCompiled}; return snapshot;`)(react.useMemo, react.useState, react.useRef, react.useEffect,
      realm.load('./workerResources').DEFAULT_RESOURCES, () => ({}), () => {}, error => { throw error; },
      { createObjectURL: () => `blob:test-${++serial}`, revokeObjectURL() {} }, Blob);
  const args = { input: makeInput(), bundle: undefined, rating: null, zasa: null, current: true };
  const initialRows = args.input.stamp.rowsRevision;
  const account = { current: args.input.stamp.scope };
  const viewer = { current: 'A' }, rowsRev = { current: initialRows };
  const live = { current: { input: args.input } };
  const matches = (a, b) => a.iidxId === b.iidxId && a.epoch === b.epoch;
  const isCurrent = () => args.current && appCurrent(live, args.input, matches, account, account, viewer, rowsRev);
  const resourceDtos = new WeakMap();
  const dtoResources = specs => {
    if (!specs) return undefined;
    if (!resourceDtos.has(specs)) resourceDtos.set(specs, realm.dto(specs));
    return resourceDtos.get(specs);
  };
  function render() { cursor = 0; dirty = false;
    live.current = { input: args.input };
    const resources = snapshot(args.bundle, args.rating, args.zasa);
    output = ['weakness', 'pattern-score'].map(kind => hook.useComputeTask(kind, args.input,
      realm.dto({ adapter: 'analysis-songcharts-v1' }), dtoResources(kind === 'weakness' ? resources?.weakness : resources?.pattern), !!resources, isCurrent,
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
  return { realm, client, args, held, perf, ports, render, pump, deliver, ready, makeInput, rowsRev, viewer,
    strictReplay() { slots.forEach(slot => { if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined; slot.deps = undefined; } }); render(); },
    get output() { return output; },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); }, dispose() { slots.forEach(slot => slot?.cleanup?.()); client.dispose(); } };
}


test('saved account without a live game profile starts both tasks after repeated charts revisions and snapshot publication', async () => {
  const h = harness();
  try {
    h.render();
    for (const rev of [8, 13, 15, 17]) {
      h.args.input = h.makeInput();
      h.args.input.stamp.rowsRevision = h.rowsRev.current;
      h.args.input.stamp.chartsRevision = rev;
      h.render();
    }
    // Execute the production snapshot effect at rev 17, then change input before the state rerender.
    h.args.bundle = { patternsMap: {}, rateRef: {}, featureScores: {}, normSource: { source: 'norm' }, weaknessSource: { source: 'weakness' } };
    h.args.rating = { ratings: {} }; h.args.zasa = { charts: {} }; h.render();
    h.args.input = h.makeInput();
    h.args.input.stamp.rowsRevision = h.rowsRev.current;
    h.args.input.stamp.chartsRevision = 18;
    h.render();
    await h.pump(() => h.held.length === 2);
    assert.ok(h.held.every(job => job.m.stamp.chartsRevision === 18));
    h.deliver({ vec: { __entries: [], NOTES: 1 }, allCharts: [] });
    h.deliver({ vec: { NOTES: 1 }, digest: 'a'.repeat(64) });
    await h.pump(() => h.output.every(x => x.task.status === 'ready'));
    assert.equal(h.perf.filter(p => p[5] === 'ok').length, 2);
    h.viewer.current = 'B';
    h.args.input = h.makeInput(); h.render();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.held.length, 0, 'account mismatch still blocks computation');
  } finally { h.dispose(); }
});
