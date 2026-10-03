import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRealm } from './test-support.mjs';

function harness() {
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
  const source = fs.readFileSync(new URL('./useRecommendService.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const hook = {};
  vm.runInContext(`(function(exports, require) { ${compiled}\n})`, realm.context)(hook, name => {
    if (name === 'react') return react;
    if (name === './rendererService') return { computeClient: client };
    if (name === '../perfDiag') return { beginPerf: () => ({}), endPerf: () => {} };
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
    output = hook.useRecommendService(args.input, args.resources, args.enabled, () => args.current);
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
  return { realm, client, args, held, ports, render, pump, deliver, ready, makeInput,
    strictReplay() { slots.forEach(slot => { if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined; slot.deps = undefined; } }); render(); },
    get output() { return output; }, dispose() { slots.forEach(slot => slot?.cleanup?.()); client.dispose(); } };
}

test('recommendation lanes complete independently, and busy context affinity remains serial', async () => {
  const h = harness();
  try {
    const service = await h.ready();
    const requests = ['EC', 'HC', 'EXH', 'bridge:1'].map(lane => service.query(h.realm.dto({ operation: 'stage', stage: lane }), lane));
    await h.pump();
    const owner = h.held[0].port;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.held.length, 1, 'other recommendation lanes wait for the context Worker');
    for (let i = 0; i < requests.length; i++) { await h.pump(); assert.equal(h.held[0].port, owner); h.deliver({ lane: h.held[0].m.payload.options.stage }); }
    const results = await Promise.all(requests);
    assert.deepEqual(results.map(result => result.lane).sort(), ['EC', 'EXH', 'HC', 'bridge:1'].sort());
  } finally { h.dispose(); }
});

test('same lane supersedes old reroll; identical token subscribers share one Worker run', async () => {
  const h = harness();
  try {
    const service = await h.ready();
    const old = service.query(h.realm.dto({ operation: 'stage', token: 1 }), 'EC');
    const rejected = assert.rejects(old, /STALE|superseded/i);
    await h.pump();
    const newest = service.query(h.realm.dto({ operation: 'stage', token: 2 }), 'EC');
    const duplicate = service.query(h.realm.dto({ operation: 'stage', token: 2 }), 'EC');
    h.deliver({ picked: ['old'] }); await h.pump(); h.deliver({ picked: ['new'] });
    await rejected;
    assert.deepEqual(structuredClone(await newest), { picked: ['new'] });
    assert.deepEqual(structuredClone(await duplicate), { picked: ['new'] });
    assert.equal(h.client.stats.run, 3, 'one context and two token runs');
  } finally { h.dispose(); }
});

test('StrictMode context replay shares in-flight computation and retained input survives pruning', async () => {
  const h = harness();
  try {
    h.render(); await h.pump(); h.strictReplay();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.held.length, 1);
    h.makeInput().ensure(); h.makeInput().ensure(); h.makeInput().ensure();
    h.deliver({ contextHandle: 'ctx' }); await h.pump(() => !!h.output.service);
    const request = h.output.service.query(h.realm.dto({ operation: 'weakness' }), 'weakness');
    await h.pump(); h.deliver({ weakness: 1 });
    assert.equal((await request).weakness, 1);
  } finally { h.dispose(); }
});

test('render invalidates old service immediately on input/epoch/account change; current guard rejects pending query', async () => {
  const h = harness();
  try {
    let old = await h.ready();
    const pending = old.query(h.realm.dto({ operation: 'stage' }), 'EC');
    const rejected = assert.rejects(pending, /STALE/);
    await h.pump(); h.args.current = false; h.deliver({ picked: ['stale'] }); await rejected;
    h.args.current = true;
    for (const [id, epoch] of [['A', 2], ['B', 3]]) {
      h.args.input = h.makeInput(id, epoch);
      assert.equal(h.render().service, null);
      await assert.rejects(old.query(h.realm.dto({ operation: 'stage' }), 'EC'), /STALE/);
      await h.pump(); h.deliver({ contextHandle: `ctx-${epoch}` }); await h.pump(() => !!h.output.service);
      old = h.output.service;
    }
  } finally { h.dispose(); }
});

test('context failure surfaces error and explicit retry obtains a usable service', async () => {
  const h = harness();
  try {
    h.render(); await h.pump(); h.deliver(null, true); await h.pump(() => h.output.status === 'error');
    assert.match(h.output.error, /injected context failure/); assert.equal(h.output.service, null);
    h.output.retry(); await h.pump(); h.deliver({ contextHandle: 'retried' }); await h.pump(() => !!h.output.service);
    assert.equal(h.output.service.contextHandle, 'retried');
  } finally { h.dispose(); }
});

test('actual runtime context identity follows bytes/scope, returns DTOs, and explicitly serializes layout', async () => {
  const sources = {
    norm: 'globalThis.OhsorryNorm = { norm: s => s };',
    weak: 'globalThis.OhsorryWeakness = { calcUserWeakness: () => ({}) };',
    rec: `globalThis.contextCreates = 0; globalThis.layouts = [];
      globalThis.OhsorryRecommend = { VERSION: 'fixture', buildRecommendDeps: () => ({}), createContext: () => {
        globalThis.contextCreates++; let mode;
        return { setLayoutMode: value => { mode = value; globalThis.layouts.push(value); },
          chartStrengthMatchByHand: () => ({ bestLabel: mode }), computeChartTags: () => ['fixture'],
          computeRecHashtags: () => [mode] };
      } };`,
    patterns: '{}', changed: '{"extra":{}}',
  };
  const realm = createRealm({ fetch: async url => ({ ok: true, text: async () => sources[String(url).replace('alias:', '')] }) });
  const replies = [], runtime = realm.load('./workerRuntime').createWorkerRuntime(reply => replies.push(reply));
  const specs = [
    { key: 'OhsorryNorm', globalKey: 'OhsorryNorm', url: 'norm' },
    { key: 'OhsorryWeakness', globalKey: 'OhsorryWeakness', url: 'weak' },
    { key: 'OhsorryRecommend', globalKey: 'OhsorryRecommend', url: 'rec' },
    { key: 'patterns', url: 'patterns' },
    ...['rating', 'zasa', 'ereter'].map(key => ({ key, url: null })),
  ];
  let seq = 0;
  await runtime(realm.dto({ protocol: 1, type: 'init', workerGeneration: 1 }));
  const prepare = async (resources, kind = 'rec-context') => {
    await runtime(realm.dto({ protocol: 1, type: 'prepare', kind, prepareId: ++seq, workerGeneration: 1, resources }));
    assert.equal(replies.at(-1).type, 'prepared'); return replies.at(-1);
  };
  const targetSpecs = specs.filter(spec => ['OhsorryNorm', 'rating'].includes(spec.key));
  let manifest = await prepare(targetSpecs, 'rec-query');
  const stamp = { scope: { iidxId: 'A', epoch: 1 }, rowsRevision: 1, chartsRevision: 1,
    modelRevision: manifest.modelRevision, dataRevision: manifest.dataRevision, optionsKey: '{}' };
  await runtime(realm.dto({ protocol: 1, type: 'install-input', inputHandle: 'rows', input: { stamp,
    data: { rows: [], osrCharts: [], notInInf: [], songs: null } } }));
  const run = async (kind, options, resources) => {
    await runtime(realm.dto({ protocol: 1, type: 'run', workerGeneration: 1, requestId: ++seq, kind, inputHandle: 'rows',
      stamp: { ...stamp, modelRevision: manifest.modelRevision, dataRevision: manifest.dataRevision,
        optionsKey: realm.load('./revisionKey').makeOptionsKey(realm.dto(options)) }, payload: { options, resources } }));
    const reply = replies.at(-1); assert.equal(reply.status, 'ready', reply.message);
    assert.equal(realm.load('./protocol').isPlainDto(reply.value), true); return reply.value;
  };
  const targets = await run('rec-query', { operation: 'targets', request: { kind: 'targets' },
    bridge: { baseStar: null, userRStar: null, userCharts: [] } }, targetSpecs);
  assert.equal(targets.available, false);
  assert.equal(realm.eval('typeof OhsorryRecommend'), 'undefined', 'targets require no recommendation module or context');
  manifest = await prepare(specs);
  const first = await run('rec-context', {}, specs);
  const aliases = specs.map(spec => ({ ...spec, url: spec.url === null ? null : `alias:${spec.url}` }));
  manifest = await prepare(aliases);
  assert.equal((await run('rec-context', {}, aliases)).contextHandle, first.contextHandle);
  assert.equal(realm.eval('contextCreates'), 1, 'URL changes with identical bytes reuse the context');
  const cards = layout => run('rec-query', { contextHandle: first.contextHandle, operation: 'cards', layout,
    rows: [{ title: 'song', chart: 'ANOTHER' }] }, aliases);
  const [on, off, onAgain] = await Promise.all([cards('on'), cards('off'), cards('on')]);
  assert.equal(on[0]._cardBestLabel, 'on'); assert.equal(off[0]._cardBestLabel, 'off');
  assert.equal(onAgain[0]._cardBestLabel, 'on');
  assert.deepEqual(structuredClone(realm.eval('layouts')), ['on', 'off', 'on']);
  const changed = aliases.map(spec => spec.key === 'patterns' ? { ...spec, url: 'changed' } : spec);
  manifest = await prepare(changed);
  assert.notEqual((await run('rec-context', {}, changed)).contextHandle, first.contextHandle);
  assert.equal(realm.eval('contextCreates'), 2);
});
