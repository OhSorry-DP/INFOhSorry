import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function loadHandler() {
  const context = vm.createContext({ console });
  const modules = new Map();
  function load(filename) {
    if (!path.extname(filename)) filename += fs.existsSync(filename + '.ts') ? '.ts' : '.js';
    if (modules.has(filename)) return modules.get(filename);
    const source = fs.readFileSync(filename, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, allowJs: true,
    } }).outputText;
    const exports = {};
    modules.set(filename, exports);
    vm.runInContext(`(function(exports, require) { ${code}\n})`, context)(exports,
      name => load(path.resolve(path.dirname(filename), name)));
    return exports;
  }
  return load(fileURLToPath(new URL('./recommendBridgeHandler.ts', import.meta.url)));
}

function fixture() {
  const { handleRecommendRequest } = loadHandler();
  const calls = [];
  const row = { title: 'fixture', chart: 'ANOTHER', level: 12, ec: 10, hc: 11, exh: 12,
    diffValue: 11.2, currentLamp: 'HARD', lampNum: 5, _tags: ['stairs'], _hashtags: ['#DP'],
    _matchByHand: { bestLabel: 'FLIP' }, _internalScore: 999 };
  const ctx = {
    practiceParents: ['stairs'], setLayoutMode: mode => calls.push(['layout', mode]),
    buildRecs: (...args) => { calls.push(['clear', ...args]); return [row]; },
    buildWeaknessRecs: (...args) => { calls.push(['practice', ...args]); return [row]; },
    buildEstLadder: () => [{ key: 'solid', target: 11, recs: [row] }],
    buildGrowthLandscape: (base, opts) => { calls.push(['growth', base, opts]); return {
      sections: [{ key: 'solid', validated: true, recs: [{ ...row, _growthExplain: {
        growth: { currentStage: 'AA', primaryTerminal: true }, cluster: { type: 'solid' },
        validation: { solidValidated: true },
      } }] }],
    }; },
  };
  const deps = { recCtx: ctx, ratingData: {}, userRStar: 10.5, baseStar: 11,
    userCharts: [], normFn: s => s, coreVersion: 'test-version' };
  return { run: (kind, params) => handleRecommendRequest({ reqId: 'r1', kind, params }, deps), deps, calls };
}

test('bridge meta and targets use injected data without window module dependencies', () => {
  const f = fixture();
  assert.equal(f.run('meta').coreVersion, 'test-version');
  assert.equal(f.run('meta').ready, true);
  f.deps.recCtx = null;
  assert.equal(f.run('meta').ready, false);
  assert.equal(f.run('targets').available, false);
  assert.throws(() => f.run('clear'), /recCtx not ready/);
});

test('clear and practice preserve request parameters, layout and slim card fields', () => {
  const f = fixture();
  const clear = f.run('clear', { stage: 'HC', layout: 'on', levelMode: 'lv12', djMode: 'on', limit: 1 });
  assert.deepEqual(f.calls, [['layout', 'on'], ['clear', 5, 'hc', 11, 'lv12', 'on']]);
  assert.equal(clear.rows[0].layout, 'FLIP');
  assert.equal(clear.rows[0].targetStar, 11.2);
  assert.equal(clear.rows[0]._internalScore, undefined);
  f.run('practice', { feature: 'stairs', strength: 2, handMode: 'left', flipOn: false, zasaMin: 1 });
  assert.equal(f.calls[2][1], 'off');
  assert.equal(f.calls[3][2].handMode, 'left');
  assert.equal(f.calls[3][2].flipOn, false);
  assert.equal(f.calls[3][2].zasaMin, 1);
});

test('legacy ladder and score growth preserve payload and axis base contract', () => {
  const f = fixture();
  assert.equal(f.run('ladder').sections[0].rows[0].title, 'fixture');
  const growth = f.run('ladder', { axis: 'score', topN: 3 });
  assert.equal(growth.base, 10.5);
  assert.equal(growth.baseKind, 'r_star');
  const row = growth.sections[0].rows[0];
  assert.equal(row.targetStar, undefined);
  assert.equal(row.growth.currentStage, 'AA');
  assert.equal(row.growth.validated, true);
  f.deps.userRStar = null;
  assert.equal(f.run('ladder', { mode: 'score' }).error, 'no_r_star');
});

function bridgeHook() {
  let callback, cleanup;
  const responses = [];
  const ref = {};
  const context = vm.createContext({ window: { infohsorry: { recommend: {
    onRequest: cb => { callback = cb; return () => {}; },
    respond: response => responses.push(response),
  } } } });
  const source = fs.readFileSync(new URL('../useRecommendBridge.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  vm.runInContext(`(function(exports, require) { ${code}\n})`, context)(exports, () => ({
    useRef: () => ref,
    useEffect: effect => { if (!cleanup) cleanup = effect(); },
  }));
  return { render: exports.useRecommendBridge, request: req => callback(req), responses,
    cleanup: () => cleanup() };
}

test('async bridge captures parameters and rejects results after data replacement', async () => {
  const hook = bridgeHook();
  let resolve;
  const calls = [];
  const service = { query: (options, lane) => {
    calls.push({ options, lane });
    return new Promise(r => { resolve = r; });
  } };
  const deps = { service, ratingData: {}, userRStar: 10, baseStar: 11, userCharts: [] };
  hook.render(deps);
  hook.request({ reqId: 'first', kind: 'clear', params: { layout: 'on' } });
  assert.equal(calls[0].options.operation, 'bridge');
  assert.equal(calls[0].options.layout, 'on');
  assert.equal(calls[0].lane, 'bridge:first');
  hook.render({ ...deps }); // unrelated render must retain this request
  resolve({ ec: [] });
  await new Promise(r => setImmediate(r));
  assert.equal(hook.responses[0].ok, true);
  hook.request({ reqId: 'second', kind: 'clear' });
  hook.render({ ...deps, userCharts: [{}] });
  resolve({ ec: [] });
  await new Promise(r => setImmediate(r));
  assert.equal(hook.responses[1].ok, false);
  assert.match(hook.responses[1].error, /data changed/);
});

test('unready bridge returns meta readiness and errors for recommendation requests', async () => {
  const hook = bridgeHook();
  hook.render({ service: null, ratingData: {}, userRStar: null, baseStar: null, userCharts: [] });
  hook.request({ reqId: 'meta', kind: 'meta' });
  hook.request({ reqId: 'clear', kind: 'clear' });
  await new Promise(r => setImmediate(r));
  assert.equal(hook.responses[0].ok, true);
  assert.equal(hook.responses[0].result.ready, false);
  assert.equal(hook.responses[1].ok, false);
});

test('targets use the context-free Worker service while recommendation context is unready', async () => {
  const hook = bridgeHook();
  const calls = [];
  const deps = { service: null, targetService: { query: async (options, lane) => {
    calls.push({ options, lane });
    return { available: true, userRStar: 10, a: [], aa: [], aaa: [], maxm: [] };
  } }, ratingData: {}, userRStar: 10, baseStar: null, userCharts: [] };
  hook.render(deps);
  hook.request({ reqId: 'targets', kind: 'targets', params: { layout: 'on' } });
  await new Promise(r => setImmediate(r));
  assert.equal(calls[0].options.operation, 'targets');
  assert.equal(calls[0].options.layout, 'off');
  assert.equal(calls[0].lane, 'bridge:targets');
  assert.equal(hook.responses[0].ok, true);
  assert.equal(hook.responses[0].result.available, true);
});
