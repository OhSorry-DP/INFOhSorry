import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRealm } from './test-support.mjs';

// Execute the production hook with a small deterministic React hook dispatcher.
// Messages use the real computeClient acceptance/cache/installation path.
function harness(kind = 'dp-star', snapshots) {
  const held = [], ports = [], events = [];
  const realm = createRealm({ URL, Blob });
  class Port {
    onmessage = null; onerror = null; onmessageerror = null;
    constructor() { ports.push(this); }
    postMessage(m) {
      const deliver = value => this.onmessage?.({ data: realm.dto(value) });
      if (m.type === 'init') queueMicrotask(() => deliver({ protocol: 1, type: 'ready', workerGeneration: m.workerGeneration }));
      if (m.type === 'prepare') queueMicrotask(() => deliver({ protocol: 1, type: 'prepared', prepareId: m.prepareId,
        workerGeneration: m.workerGeneration, modelRevision: 'model-1', dataRevision: 'data-1' }));
      if (m.type === 'install-input') queueMicrotask(() => deliver({ protocol: 1, type: 'input-installed', inputHandle: m.inputHandle }));
      if (m.type === 'run') held.push({ m, deliver });
    }
    terminate() {}
  }
  const client = realm.load('./computeClient').createComputeClient({ workerFactory: () => new Port(), watchdogMs: 5000 });
  let beforeContinuation = () => {};
  const submit = client.submit;
  client.submit = spec => {
    const ticket = submit(spec);
    return { ...ticket, promise: ticket.promise.then(response => { beforeContinuation(response); return response; }) };
  };
  const slots = [], effects = [];
  let cursor = 0, dirty = true, output, serial = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, next => {
        slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; dirty = true;
      }];
    },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !equal(slots[i].deps, deps)) {
        effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  let source = fs.readFileSync(new URL('./useComputeTask.ts', import.meta.url), 'utf8');
  if (process.env.S2_INJECT_STALE === '1') {
    source = source.replace('ticket.accept(response, accepted => {', '((response, apply) => apply(response))(response, accepted => {');
  }
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const hook = {};
  vm.runInContext(`(function(exports, require) { ${compiled}\n})`, realm.context)(hook, name => {
    if (name === 'react') return react;
    if (name === './rendererService') return { computeClient: client };
    if (name === '../perfDiag') return { beginPerf: (...a) => { events.push(['begin', ...a]); return {}; },
      endPerf: (...a) => events.push(['end', ...a]) };
    return realm.load(name);
  });
  const makeInput = (id = 'A', epoch = 1, rowsRevision = 1) => {
    const handle = `rows-${++serial}`;
    const stamp = realm.dto({ scope: { iidxId: id, epoch }, rowsRevision, chartsRevision: serial,
      modelRevision: '', dataRevision: '', optionsKey: '{}' });
    let installed = false;
    return { handle, stamp, ensure() {
      if (!installed) { installed = true; client.installInput(handle, realm.dto({ stamp,
        data: { rows: [], osrCharts: [], notInInf: [], songs: [] } })); }
    } };
  };
  const args = { input: makeInput(), options: realm.dto({}), resources: realm.dto([]), enabled: true, current: true, snapshots,
    ready: () => {} };
  function render() {
    cursor = 0; dirty = false;
    output = snapshots === undefined ? hook.useComputeTask(kind, args.input, args.options, args.resources, args.enabled,
      () => args.current, args.ready) : hook.useSnapshotResources(kind, args.snapshots);
    effects.splice(0).forEach(effect => effect());
    return output;
  }
  async function pump(predicate = () => held.length > 0) {
    for (let i = 0; i < 200; i++) {
      if (dirty) render();
      await new Promise(resolve => setTimeout(resolve, 1));
      if (dirty) render();
      if (predicate()) return;
    }
    throw new Error('renderer harness timeout');
  }
  const deliver = (value, status = 'ready') => {
    const job = held.shift(); assert.ok(job, 'expected pending Worker message');
    job.deliver({ ...job.m, type: status === 'ready' ? 'result' : 'error', status,
      ...(status === 'ready' ? { value } : { code: 'INJECTED_FAILURE', message: 'failure' }) });
  };
  return { realm, client, args, makeInput, render, pump, deliver, held, events,
    beforeContinuation(fn) { beforeContinuation = fn; },
    strictReplay() { slots.forEach(slot => { if (slot?.cleanup) { slot.cleanup(); slot.cleanup = undefined; slot.deps = undefined; } }); render(); },
    get output() { return output; },
    dispose() { slots.forEach(slot => slot?.cleanup?.()); client.dispose(); } };
}

test('real renderer hook: same-scope pending retains display; epoch/account clears; null and error differ', async () => {
  const h = harness();
  try {
    h.render(); await h.pump();
    h.deliver({ star: 12, nativeStar: 11 });
    await h.pump(() => h.output.task.status === 'ready');
    assert.equal(h.output.value.star, 12);
    h.args.input = h.makeInput('A', 1, 2);
    assert.equal(h.render().value.star, 12);
    assert.equal(h.output.task.status, 'pending');
    await h.pump(); h.deliver(null);
    await h.pump(() => h.output.task.status === 'ready');
    assert.equal(h.output.value, null);
    h.args.input = h.makeInput('A', 2, 2);
    assert.equal(h.render().value, null);
    await h.pump(); h.deliver(null, 'error');
    await h.pump(() => h.output.task.status === 'error');
    assert.equal(h.output.value, null);
    h.output.retry(); await h.pump(); h.deliver({ star: 13 });
    await h.pump(() => h.output.task.status === 'ready');
    h.args.input = h.makeInput('B', 3, 3);
    assert.equal(h.render().value, null);
  } finally { h.dispose(); }
});

test('stale response between delivery and accept changes neither UI, floor nor upload reference', async () => {
  const h = harness();
  let floor = 10, uploadRef = null;
  h.args.ready = value => { floor = value.star; uploadRef = value; };
  try {
    h.render(); await h.pump();
    h.beforeContinuation(() => { h.args.current = false; });
    h.deliver({ star: 99 });
    // finish() passed, but account changed before the hook promise continuation.
    await new Promise(resolve => setTimeout(resolve, 5));
    h.render();
    assert.equal(floor, 10);
    assert.equal(uploadRef, null);
    assert.equal(h.output.task.status, 'pending');
    assert.equal(h.output.value, null);
  } finally { h.dispose(); }
});

test('rows replacement before delivery drops stale UI/floor and keeps only the newest request', async () => {
  const h = harness('r-star');
  let floor = 1;
  h.args.ready = value => { floor = value; };
  try {
    h.render(); await h.pump();
    h.args.input = h.makeInput('A', 1, 2); h.render();
    h.deliver(88); await h.pump();
    assert.equal(floor, 1);
    h.deliver(12); await h.pump(() => h.output.task.status === 'ready');
    assert.equal(floor, 12);
    assert.equal(h.output.value, 12);
    const count = h.events.filter(e => e[0] === 'begin').length;
    h.render(); h.render();
    assert.equal(h.events.filter(e => e[0] === 'begin').length, count, 'unrelated renders never add requests');
  } finally { h.dispose(); }
});

test('W4 renderer bundle requires all three ready stamps/one rows handle; displayed previous never uploads', () => {
  const realm = createRealm();
  const { starBundle, previousDisplay } = realm.load('./rendererState');
  const input = realm.dto({ handle: 'rows-1', stamp: { scope: { iidxId: 'A', epoch: 1 }, rowsRevision: 1, chartsRevision: 1 } });
  const task = optionsKey => realm.dto({ status: 'ready', inputHandle: 'rows-1', value: null,
    stamp: { ...input.stamp, modelRevision: 'm', dataRevision: 'd', optionsKey } });
  const dp = task('{"prevStar":12}'), r = task('{"prevRStar":10}'), sp = task('{}');
  assert.equal(starBundle(input, dp, r, sp).ready, true, 'ready-null completes upload');
  assert.equal(starBundle(input, { ...dp, status: 'pending' }, r, sp).ready, false);
  assert.equal(starBundle(input, dp, { ...r, status: 'error' }, sp).ready, false);
  assert.equal(starBundle(input, dp, r, { ...sp, inputHandle: 'other' }).ready, false);
  assert.equal(starBundle({ ...input, stamp: { ...input.stamp, rowsRevision: 2 } }, dp, r, sp).ready, false);
  assert.equal(previousDisplay({ scope: input.stamp.scope, value: 12 }, input.stamp.scope), 12);
  assert.equal(previousDisplay({ scope: input.stamp.scope, value: 12 }, { iidxId: 'A', epoch: 2 }), null);
});

test('snapshot resources carry exact App rating/ereter JSON, explicit null and revoke replaced blobs', async () => {
  const h = harness('dp-star', { rating: { ratings: { chart: 12 } }, ereter: { charts: [{ title: 'scraped', level: 9 }] } });
  try {
    assert.equal(h.render(), undefined);
    await h.pump(() => !!h.output);
    const oldRating = h.output.find(spec => spec.key === 'rating').url;
    const oldEreter = h.output.find(spec => spec.key === 'ereter').url;
    assert.deepEqual(await (await fetch(oldRating)).json(), h.args.snapshots.rating);
    assert.deepEqual(await (await fetch(oldEreter)).json(), h.args.snapshots.ereter);
    h.args.snapshots = { rating: null, ereter: { charts: [] } };
    assert.equal(h.render(), undefined, 'resources invalidate in render, before their effect');
    await h.pump(() => !!h.output);
    assert.equal(h.output.find(spec => spec.key === 'rating').url, null);
    await assert.rejects(fetch(oldRating));
  } finally { h.dispose(); }
});

test('StrictMode effect replay shares one in-flight Worker run and cancels only the old subscriber', async () => {
  const h = harness();
  try {
    h.render(); await h.pump();
    h.strictReplay();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.held.length, 1);
    assert.equal(h.client.stats.run, 1);
    h.deliver({ star: 12 });
    await h.pump(() => h.output.task.status === 'ready');
    assert.equal(h.output.value.star, 12);
  } finally { h.dispose(); }
});

test('mounted disabled layout retains its installed input beyond latest-two eviction and can toggle back on', async () => {
  const h = harness('layout');
  try {
    h.args.enabled = false; h.render();
    h.makeInput('A', 1, 2).ensure(); h.makeInput('A', 1, 3).ensure();
    h.args.enabled = true; h.render(); await h.pump();
    h.deliver([['song|ANOTHER', 'MIRROR']]);
    await h.pump(() => h.output.task.status === 'ready');
    assert.equal(h.output.value[0][1], 'MIRROR');
  } finally { h.dispose(); }
});

test('Worker runtime reuses weakness across a later songs handle, with exact rows/scope/resource isolation', async () => {
  const sources = {
    norm: 'globalThis.OhsorryNorm = { norm: s => s };',
    weak: `globalThis.weakCalls = 0; globalThis.OhsorryWeakness = {
      calcUserWeakness: () => { globalThis.weakCalls++; return { __entries: [1] }; },
      chartStrengthMatch8Way: () => ({ bestLabel: 'MIRROR' }) };`,
    patterns: JSON.stringify({ 1: { t: 'song', c: { DP_ANO: { test: 1 } } } }),
    reference: '{}',
  };
  const realm = createRealm({ fetch: async url => ({ ok: true, text: async () => sources[url] }) });
  const specs = realm.dto([
    { key: 'OhsorryNorm', globalKey: 'OhsorryNorm', url: 'norm' },
    { key: 'OhsorryWeakness', globalKey: 'OhsorryWeakness', url: 'weak' },
    { key: 'patterns', url: 'patterns' }, { key: 'rateRef', url: 'reference' },
    { key: 'rating', url: null }, { key: 'zasa', url: null },
  ]);
  const replies = [];
  const runtime = realm.load('./workerRuntime').createWorkerRuntime(reply => replies.push(reply));
  await runtime(realm.dto({ protocol: 1, type: 'init', workerGeneration: 1 }));
  await runtime(realm.dto({ protocol: 1, type: 'prepare', prepareId: 1, workerGeneration: 1, kind: 'weakness', resources: specs }));
  const manifest = replies.at(-1);
  const rows = [{ title: 'song', charts: { DPA: { noteCount: 100, exScore: 150, lamp: 'HC' } } }];
  const install = async (handle, revision, epoch, dataRows, songs) => {
    const stamp = { scope: { iidxId: 'A', epoch }, rowsRevision: revision, chartsRevision: revision,
      modelRevision: manifest.modelRevision, dataRevision: manifest.dataRevision, optionsKey: '{}' };
    await runtime(realm.dto({ protocol: 1, type: 'install-input', inputHandle: handle,
      input: { stamp, data: { rows: dataRows, osrCharts: [], notInInf: [], songs } } }));
    return stamp;
  };
  const run = async (kind, handle, stamp, options = {}) => {
    await runtime(realm.dto({ protocol: 1, type: 'run', requestId: replies.length, workerGeneration: 1,
      kind, inputHandle: handle, stamp: { ...stamp, optionsKey: realm.load('./revisionKey').makeOptionsKey(realm.dto(options)) },
      payload: { options, resources: specs } }));
    assert.equal(replies.at(-1).status, 'ready');
    return replies.at(-1).value;
  };
  const first = await install('weak-input', 1, 1, rows, []);
  await run('weakness', 'weak-input', first);
  const labels = await install('songs-input', 2, 1, rows, [{ title: 'song', ac: 2, legen: 0 }]);
  assert.deepEqual(structuredClone(await run('layout', 'songs-input', labels, { style: 'dp', layoutMode: true })), [['song|ANOTHER', 'MIRROR']]);
  assert.equal(realm.eval('weakCalls'), 1, 'songs arrival does not recalculate weakness');
  const changed = await install('changed-input', 3, 1, [{ ...rows[0], title: 'other' }], []);
  await run('weakness', 'changed-input', changed);
  assert.equal(realm.eval('weakCalls'), 2);
  const epoch = await install('epoch-input', 4, 2, rows, []);
  await run('weakness', 'epoch-input', epoch);
  assert.equal(realm.eval('weakCalls'), 3, 'same rows in a new epoch cannot reuse a personal vector');
  sources.rating2 = '{"ratings":[]}';
  specs.find(spec => spec.key === 'rating').url = 'rating2';
  await runtime(realm.dto({ protocol: 1, type: 'prepare', prepareId: 2, workerGeneration: 1, kind: 'weakness', resources: specs }));
  const revised = replies.at(-1);
  await run('weakness', 'epoch-input', { ...epoch, modelRevision: revised.modelRevision, dataRevision: revised.dataRevision });
  assert.equal(realm.eval('weakCalls'), 4, 'data digest changes invalidate weakness even for identical rows');
});

test('manual intent waits for current ready bundle and stops on scope/error instead of mixing snapshots', async () => {
  const realm = createRealm();
  const { waitForBundle } = realm.load('./waitForBundle');
  let status = 'pending';
  const result = waitForBundle(() => status, 200);
  setTimeout(() => { status = 'ready'; }, 10);
  assert.equal(await result, true);
  assert.equal(await waitForBundle(() => 'invalid'), false);
  assert.equal(await waitForBundle(() => 'pending', 1), false);
});

test('renderer structural boundary: Worker calls replace star/PlayData/recommendation kernels', () => {
  const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const play = fs.readFileSync(new URL('../PlayData.tsx', import.meta.url), 'utf8');
  assert.match(app, /useComputeTask<StarResult>\('dp-star'/);
  assert.match(app, /useComputeTask<number>\('r-star'/);
  assert.match(app, /useComputeTask<SpSkillResult>\('sp-star'/);
  assert.doesNotMatch(app, /onlyOSR2eLib|userRateStarLib|spSkillLib|calculateScoped/);
  assert.match(app, /useRecommendService\(recInput/);
  assert.doesNotMatch(app, /createRecCtx\(|\.buildRecsWithPool\(|\.buildWeaknessRecs\(|\.chartStrengthMatchByHand\(|\.computeChartTags\(|\.computeRecHashtags\(/);
  assert.match(app, /isUploadReady\(state.acceptedBundle, state.expectedBundle\)/);
  assert.match(app, /state.rowsRevision !== rowsRevisionRef.current/);
  assert.match(app, /computeClient.invalidateScope\(\)/);
  assert.match(play, /useComputeTask<unknown>\('weakness'/);
  assert.match(play, /useComputeTask<\[string, string\]\[]>\('layout'/);
  assert.doesNotMatch(play, /\.calcUserWeakness\(|\.chartStrengthMatch8Way\(/);
  assert.match(play, /new Map\(layoutTask.value\)/);
});
