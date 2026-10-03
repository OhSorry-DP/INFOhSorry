import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, globals = {}) {
  const exports = {};
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { exports, ...globals });
  return exports;
}
const rules = load('./lagDiag.ts');

test('threshold is strict and rejects invalid or negative samples', () => {
  for (const sample of [0, -1, 199.999, 200, NaN, Infinity]) {
    assert.equal(rules.exceedsThreshold(sample), false);
  }
  assert.equal(rules.exceedsThreshold(200.001), true);
  assert.equal(rules.exceedsThreshold(11, 10), true);
});

test('main lag subtracts the normal interval and resets after a delayed sample', () => {
  assert.equal(rules.timerLagMs(100, 600, 500), 0);
  assert.equal(rules.timerLagMs(100, 800, 500), 200);
  assert.equal(rules.timerLagMs(100, 801, 500), 201);
  assert.equal(rules.timerLagMs(801, 1301, 500), 0);
  assert.equal(rules.timerLagMs(100, 99, 500), 0);
});

test('GPU summary includes software/disabled statuses and explicit missing values', () => {
  assert.equal(rules.gpuStatusSummary({ gpu_compositing: 'disabled_software', rasterization: 'enabled' }),
    'gpu_compositing=disabled_software rasterization=enabled opengl=unknown webgl=unknown webgl2=unknown video_decode=unknown');
});

test('renderer heartbeat logs only visible long gaps and cleans up', () => {
  let now = 0;
  let callback;
  let visibilityListener;
  let cancelled = false;
  const lines = [];
  const document = {
    visibilityState: 'visible',
    addEventListener: (_event, listener) => { visibilityListener = listener; },
    removeEventListener: (_event, listener) => { assert.equal(listener, visibilityListener); visibilityListener = null; },
  };
  const { startRendererHeartbeat } = load('../renderer/src/rendererHeartbeat.ts', {
    require: name => name.includes('lagDiag') ? rules : { perfEvent: (event, fields) => lines.push({ event, ...fields }) },
    document, performance: { now: () => now },
    requestAnimationFrame: cb => { callback = cb; return 1; },
    cancelAnimationFrame: () => { cancelled = true; },
  });
  const stop = startRendererHeartbeat();
  const tick = time => { now = time; callback(); };
  tick(0); tick(200); tick(401); tick(417);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'renderer-stall');
  assert.equal(lines[0].gapMs, '201.000');
  document.visibilityState = 'hidden'; visibilityListener(); tick(2000);
  document.visibilityState = 'visible'; visibilityListener(); tick(4000); tick(4016);
  assert.equal(lines.length, 1);
  stop();
  assert.equal(cancelled, true);
  assert.equal(visibilityListener, null);
});

test('main heartbeat emits only excess lag and stops its timer', () => {
  let now = 0;
  let callback;
  let cleared = false;
  const lines = [];
  const timer = { unref() {} };
  const { startMainHeartbeat, recordGpuStatus } = load('../main/perfDiag.ts', {
    require: name => {
      if (name === 'electron') return { app: { getGPUFeatureStatus: () => ({ gpu_compositing: 'disabled_software' }) } };
      if (name.includes('lagDiag')) return rules;
      return { appendDiagLine: line => lines.push(line) };
    },
    performance: { now: () => now },
    setInterval: (cb, interval) => { callback = cb; assert.equal(interval, 500); return timer; },
    clearInterval: value => { assert.equal(value, timer); cleared = true; },
  });
  const stop = startMainHeartbeat();
  for (const time of [500, 1200, 1901, 2401]) { now = time; callback(); }
  assert.deepEqual(lines, ['PERF event=main-lag lagMs=201.000']);
  recordGpuStatus('child-process-gone', 'crashed', 1);
  assert.match(lines[1], /^GPU event=child-process-gone reason="crashed" exitCode=1 gpu_compositing=disabled_software/);
  stop();
  assert.equal(cleared, true);
});

test('session monitoring keeps one process lookup per poll and logs only slow polls / PID changes', () => {
  let now = 0;
  let callback;
  let calls = 0;
  let pid = 0;
  let duration = 0;
  const lines = [];
  const { InfinitasSessionMonitor } = load('../main/infinitasSession.ts', {
    require: name => {
      if (name === 'events') return { EventEmitter: class { emit() {} } };
      if (name.includes('lagDiag')) return rules;
      if (name === './memory') return { findProcessId: () => { calls++; now += duration; return pid; } };
      return { appendDiagLine: line => lines.push(line) };
    },
    performance: { now: () => now }, Date,
    setInterval: (cb, interval) => { callback = cb; assert.equal(interval, 1000); return 1; },
    clearInterval() {},
  });
  const monitor = new InfinitasSessionMonitor();
  monitor.start(); monitor.start();
  assert.equal(calls, 1);
  callback();
  assert.equal(lines.length, 1);
  duration = 200; callback();
  assert.equal(lines.length, 1);
  duration = 201; pid = 42; callback();
  assert.match(lines[1], /^PERF event=session-poll durMs=201.000$/);
  assert.match(lines[2], /prevPid=null pid=42 generation=1$/);
  duration = 0; callback(); pid = 43; callback(); pid = 0; callback();
  assert.equal(calls, 7);
  assert.match(lines[3], /prevPid=42 pid=43 generation=2$/);
  assert.match(lines[4], /prevPid=43 pid=null generation=2$/);
  assert.equal(lines.length, 5);
  monitor.stop();
});
