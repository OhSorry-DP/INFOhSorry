import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

async function loadModules({ supported = true, observeThrows = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'renderer-stall-'));
  const perfPath = join(dir, 'perfDiag.mjs');
  const heartbeatPath = join(dir, 'rendererHeartbeat.mjs');
  const transpile = (source, fileName) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }, fileName }).outputText;
  const perfSource = transpile(await readFile(new URL('./perfDiag.ts', import.meta.url), 'utf8'), 'perfDiag.ts');
  let heartbeatSource = await readFile(new URL('./rendererHeartbeat.ts', import.meta.url), 'utf8');
  heartbeatSource = heartbeatSource.replace("import { exceedsThreshold } from '../../shared/lagDiag';", "import { exceedsThreshold } from './lagDiag.mjs';")
    .replace("import { flushStallContext, perfEvent, recordLongTask } from './perfDiag';", "import { flushStallContext, perfEvent, recordLongTask } from './perfDiag.mjs';");
  heartbeatSource = transpile(heartbeatSource, 'rendererHeartbeat.ts');
  await writeFile(perfPath, perfSource);
  await writeFile(join(dir, 'lagDiag.mjs'), 'export const exceedsThreshold = (value) => value > 250;');
  await writeFile(heartbeatPath, heartbeatSource);

  let now = 0;
  let nextFrame = 1;
  const frames = new Map();
  const lines = [];
  let listener;
  let observerInstance;
  globalThis.performance = { now: () => now };
  globalThis.window = { location: { href: 'https://app.example/app', origin: 'https://app.example' }, infohsorry: { diag: { append(line) { if (appendThrows) throw new Error('diag'); lines.push(line); } } } };
  let appendThrows = false;
  globalThis.document = { visibilityState: 'visible', addEventListener(_name, cb) { listener = cb; }, removeEventListener(_name, cb) { if (listener === cb) listener = undefined; } };
  globalThis.requestAnimationFrame = (cb) => { const id = nextFrame++; frames.set(id, cb); return id; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  class FakeObserver {
    static supportedEntryTypes = supported ? ['longtask'] : [];
    constructor(callback) { this.callback = callback; this.disconnected = false; observerInstance = this; }
    observe() { if (observeThrows) throw new Error('no observe'); }
    disconnect() { this.disconnected = true; }
    emit(...entries) { this.callback({ getEntries: () => entries }); }
  }
  globalThis.PerformanceObserver = FakeObserver;
  globalThis.window.PerformanceObserver = FakeObserver;
  const perf = await import(pathToFileURL(perfPath));
  const heartbeat = await import(pathToFileURL(heartbeatPath));
  globalThis.PerformanceObserver.supportedEntryTypes = supported ? ['longtask'] : [];
  const setNow = (value) => { now = value; };
  const stepFrame = (value) => { now = value; const [id, cb] = frames.entries().next().value; frames.delete(id); cb(); };
  return { perf, heartbeat, setNow, stepFrame, lines, frames, get listener() { return listener; }, get observer() { return observerInstance; }, setAppendThrows(value) { appendThrows = value; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const entry = (startTime, duration, containerSrc = 'https://app.example/path?q=secret#frag') => ({ startTime, duration, name: 'self', attribution: [{ containerType: 'iframe', containerName: 'frame', containerSrc }] });

test('PERF ring is bounded; begin/end preserve safe extra fields and exclude raw identifiers', async () => {
  const env = await loadModules();
  try {
    for (let i = 0; i < 70; i++) { env.setNow(i); env.perf.perfEvent('tick', { i, accountId: 'sensitive', rows: 'private' }); }
    const context = env.perf.snapshotPerfContext(0, 100);
    assert.equal(context.length, 64);
    assert.equal(JSON.stringify(context).includes('sensitive'), false);
    env.setNow(100);
    const span = env.perf.beginPerf('calc', 2, 3, 'C123', { entryId: 'e1', chartsRev: 9, accountId: 'secret' });
    env.setNow(110);
    env.perf.endPerf('calc', span, 2, 3, 'C123', 'ok', { entryId: 'e1', chartsRev: 9 });
    const records = env.perf.snapshotPerfContext(100, 110);
    assert.deepEqual(records.map((record) => record.phase), ['begin', 'end']);
    assert.equal(records[0].fields.entryId, 'e1');
    assert.equal(records[0].fields.chartsRev, 9);
    assert.equal(JSON.stringify(records).includes('C123'), false);
  } finally { await env.cleanup(); }
});

test('longtasks are retained, sanitized, thresholded and rate limited with suppression accounting', async () => {
  const env = await loadModules();
  try {
    const stop = env.heartbeat.startRendererHeartbeat();
    env.observer.emit(entry(0, 99), entry(10, 100, `https://app.example/${'x'.repeat(220)}?q=secret#frag`));
    assert.equal(env.lines.filter((line) => line.includes('event=renderer-longtask ')).length, 1);
    assert.match(env.lines.at(-1), /source=https%3A%2F%2Fapp.example%2F/);
    assert.equal(env.lines.at(-1).includes('secret'), false);
    env.setNow(500);
    env.observer.emit(entry(20, 200), entry(30, 150), entry(40, 99));
    assert.equal(env.lines.filter((line) => line.includes('event=renderer-longtask ')).length, 1);
    env.setNow(999);
    env.observer.emit(entry(50, 300));
    env.setNow(1000);
    env.observer.emit(entry(60, 301));
    assert.equal(env.lines.filter((line) => line.includes('event=renderer-longtask ')).length, 2);
    assert.match(env.lines.at(-1), /suppressed=3/);
    const context = env.perf.snapshotPerfContext(0, 500);
    assert.equal(context.filter((record) => record.kind === 'longtask').length, 7);
    assert.equal(JSON.stringify(context).includes('q=secret'), false);
    stop();
  } finally { await env.cleanup(); }
});

test('stall context includes overlapping short and rate-limited tasks without altering suppression', async () => {
  const env = await loadModules();
  try {
    const stop = env.heartbeat.startRendererHeartbeat();
    env.observer.emit(entry(0, 100));
    env.observer.emit(entry(10, 100));
    env.observer.emit(entry(20, 99));
    env.setNow(300);
    env.stepFrame(300);
    env.observer.emit(entry(280, 99)); // delivered after the stall
    env.stepFrame(600);
    const contexts = env.lines.filter((line) => line.includes('event=renderer-stall-context') && line.includes('kind=longtask'));
    assert.ok(contexts.length >= 3);
    assert.ok(contexts.length <= 8);
    assert.equal(contexts.some((line) => line.includes('suppressed=')), false);
    stop();
  } finally { await env.cleanup(); }
});

test('unavailable observer, hidden reset, dispose, append failures and attribution bounds are safe', async () => {
  const unavailable = await loadModules({ supported: false });
  try {
    const stop = unavailable.heartbeat.startRendererHeartbeat();
    assert.equal(unavailable.observer, undefined);
    stop();
  } finally { await unavailable.cleanup(); }
  const failed = await loadModules({ observeThrows: true });
  try {
    const stop = failed.heartbeat.startRendererHeartbeat();
    assert.equal(failed.lines.filter((line) => line.includes('event=renderer-longtask-unavailable')).length, 1);
    stop();
  } finally { await failed.cleanup(); }
  const env = await loadModules();
  try {
    const stop = env.heartbeat.startRendererHeartbeat();
    env.stepFrame(0);
    globalThis.document.visibilityState = 'hidden'; env.listener(); env.stepFrame(1000);
    globalThis.document.visibilityState = 'visible'; env.listener(); env.stepFrame(1100);
    assert.equal(env.lines.some((line) => line.includes('event=renderer-stall ')), false);
    stop();
    assert.equal(env.frames.size, 0);
    assert.equal(env.listener, undefined);
    assert.equal(env.observer.disconnected, true);
    env.setAppendThrows(true);
    env.setNow(1200);
    assert.doesNotThrow(() => env.perf.perfEvent('safe'));
  } finally { await env.cleanup(); }
});
