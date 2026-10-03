import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRealm } from './test-support.mjs';

function stageRecorderHarness() {
  const events = [], perf = [], slots = [], effects = [];
  const realm = createRealm({ performance: { now: () => Number(process.hrtime.bigint()) / 1e6 } });
  let cursor = 0, hookToken;
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, value => { slots[i].value = value; }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo(fn, deps) { const i = cursor++; const old = slots[i]; if (old && deps && old.deps?.length === deps.length && deps.every((value, n) => Object.is(value, old.deps[n]))) return old.value;
      const value = fn(); slots[i] = { deps, value }; if (i === 1) hookToken = value; return value; },
    useEffect(fn) { cursor++; effects.push(fn); },
  };
  let accepted = true;
  const client = {
    retainInput() { return () => {}; }, prepare: async () => ({ modelRevision: 'm', dataRevision: 'd' }),
    submit() { const response = realm.dto({ requestId: 41, workerGeneration: 9, kind: 'weakness', status: 'ready', value: { score: 7 } });
      return { promise: Promise.resolve(response), accept(value, apply) { if (!accepted) return false; apply(value); return true; }, cancel() {} }; },
  };
  const hook = {}, source = fs.readFileSync(new URL('./useComputeTask.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(`(function(exports, require) { ${compiled}\n})`, realm.context)(hook, name => {
    if (name === 'react') return react;
    if (name === './rendererService') return { computeClient: client };
    if (name === '../perfDiag') return { beginPerf: () => ({}), endPerf: (...args) => perf.push(args), perfEvent: (event, fields) => events.push({ event, ...fields }) };
    if (name === './workerResources') return { DEFAULT_RESOURCES: {} };
    return realm.load(name);
  });
  const input = { handle: 'in-1', affinityHandle: 'in-1', stamp: realm.dto({ scope: { iidxId: 'ABC123', epoch: 4 }, rowsRevision: 5, chartsRevision: 2, optionsKey: '{}' }), ensure() {} };
  let callbackValue;
  function render(adapter, callback) {
    cursor = 0;
    hook.useComputeTask('weakness', input, realm.dto({ adapter }), realm.dto([]), true, () => true, callback, {});
  }
  render('analysis-songcharts-v1');
  effects.splice(0).forEach(effect => effect());
  return new Promise(resolve => setTimeout(() => resolve({
    async rerun(adapter, callback, shouldAccept = true) {
      accepted = shouldAccept; events.length = 0; perf.length = 0;
      // Each request gets its own hook state and stable token; rerender immediately before its effect.
      slots.length = 0; render(adapter, callback); effects.splice(0).forEach(effect => effect());
      await new Promise(done => setTimeout(done, 0));
      callbackValue = callbackValue;
      return { events: [...events], perf: [...perf], callbackValue };
    },
  }), 0));
}

test('both adapter names emit acceptance stages with request identity', async () => {
  const source = fs.readFileSync(new URL('./useComputeTask.ts', import.meta.url), 'utf8');
  assert.match(source, /analysis-songcharts-v1/);
  assert.match(source, /playDataWeakness/);
  const h = await stageRecorderHarness();
  for (const adapter of ['analysis-songcharts-v1']) {
    const { events } = await h.rerun(adapter);
    assert.deepEqual(events.map(event => event.stage), ['promise-resume', 'accept-total', 'task-create', 'previous-current', 'onReady', 'set-state', 'before-end']);
    assert.equal(events[1].accepted, true);
    assert.deepEqual([events[0].requestId, events[0].workerGeneration, events[0].kind, events[0].rowsRev, events[0].epoch], [41, 9, 'weakness', 5, 4]);
    for (const event of events) { assert.equal(typeof event.durMs, 'string'); assert.match(event.durMs, /^\d+\.\d{3}$/); assert.equal(typeof event.startMonoMs, 'string'); assert.equal(typeof event.endMonoMs, 'string'); }
  }
});

test('rejected acceptance is explicit and onReady reflects invocation only', async () => {
  const h = await stageRecorderHarness();
  const reject = await h.rerun('analysis-songcharts-v1', undefined, false);
  assert.deepEqual(reject.events.map(event => event.stage), ['promise-resume', 'accept-total', 'before-end']);
  assert.equal(reject.events[1].accepted, false);
  assert.equal(reject.perf[0][5], 'error');
  const withCallback = await h.rerun('playdata-v1', value => assert.equal(value.score, 7));
  assert.equal(withCallback.events.find(event => event.stage === 'onReady').called, true);
  const noCallback = await h.rerun('analysis-songcharts-v1');
  assert.equal(noCallback.events.find(event => event.stage === 'onReady').called, false);
});
