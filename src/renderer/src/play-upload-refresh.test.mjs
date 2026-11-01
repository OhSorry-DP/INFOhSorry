import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const app = read('./App.tsx');
const start = app.indexOf('  const uploadSnapshot = useCallback(async (snapshot: UploadSnapshot, trigger: string)');
const end = app.indexOf('\n  // IIDX ID 전환은', start);
const fn = app.slice(start, end).replace('  const uploadSnapshot = useCallback(', '').replace(/, \[\]\);\s*$/, '');
const callbackCode = ts.transpileModule(`(${fn})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const row = (timestamp, title) => ({ timestamp, song_id: '1', title, difficulty: 'SPN', notes: '10', ex_score: '5', pgreat: '1', great: '1', miss_count: '0', clear_lamp: '1', dj_rate_pct: '50', dj_rank: 'A', judge_16: '1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1', settings_p1_11: '', settings_p2_11: '', battle_flag: '0', gauge_p1_w77: '', gauge_p2_w78: '', source: 'playdata', app_version: 'old', game_version: 'old' });
const csv = (...rows) => ['timestamp,song_id,title,difficulty,notes,ex_score,pgreat,great,miss_count,clear_lamp,dj_rate_pct,dj_rank,judge_16,settings_p1_11,settings_p2_11,battle_flag,gauge_p1_w77,gauge_p2_w78,source,app_version,game_version', ...rows.map(r => Object.values(r).map(v => `"${v}"`).join(','))].join('\n');
function setup({ readPlayCsv, gameStates = [true], profileResult = { ok: true }, plays = [row('pending', 'old')] } = {}) {
  const events = []; const saved = [];
  const snapshot = { iidxId: 'C123456789012', appVersion: 'old-pending', capturedAt: 123, plays, profile: {} };
  // Evaluate the extracted callback with its closed-over renderer dependencies.
  const callback = vm.runInNewContext(callbackCode, {
    IS_BROWSER_REMOTE: false, Date, console: { warn() {}, log() {} },
    window: { infohsorry: { session: { getState: async () => ({ pid: 1 }) }, upload: {
      readPlayCsv, savePending: async s => { events.push('save'); saved.push(s); return { ok: true }; },
      clearPending: async () => ({ ok: true }),
    } } },
    readIidxIdFresh: async () => ({ processMissing: false }),
    gameRecognized: undefined,
    APP_VERSION: 'current-app',
    buildUploadPlays: result => result.ok && result.found !== false ? [row('current', 'fresh')] : [{ ...row('2026-01-01T00:00:00.000Z', ''), ...Object.fromEntries(['song_id','title','difficulty','notes','ex_score','pgreat','great','miss_count','clear_lamp','dj_rate_pct','dj_rank','judge_16','settings_p1_11','settings_p2_11','battle_flag','gauge_p1_w77','gauge_p2_w78','source'].map(k => [k, result.ok ? '-8' : '-11'])), app_version: result.appVersion ?? '', game_version: result.gameVersion ?? '' }],
    playsForGame: (p, recognized) => recognized ? p : undefined,
    uploadProfile: async input => { events.push('upload'); events.push({ uploadedPlays: input.plays }); return profileResult; },
    uploadAutomaticDbr: async () => {}, addDiagLine() {}, writeLastUploadAt() {}, Date,
  });
  return { callback, snapshot, events, saved, readPlayCsv };
}

// BuildUploadPlays is exercised through the callback's dependency mock; the upload callback body remains the production source.
test('pending snapshot refreshes plays from current CSV and preserves account identity', async () => {
  const h = setup({ readPlayCsv: async id => { assert.equal(id, 'C123456789012'); return { ok: true, csv: csv(row('now', 'fresh')), appVersion: 'ipc-app', gameVersion: 'game-7' }; } });
  await h.callback(h.snapshot, 'pending');
  assert.equal(h.saved[0].iidxId, 'C123456789012');
  assert.equal(h.saved[0].plays[0].title, 'fresh');
  assert.equal(h.saved[0].appVersion, 'current-app');
  assert.equal(h.saved[0].plays[0].title, 'fresh');
  assert.equal(h.saved[0].plays[0].game_version, 'old');
});

test('pending valid rows are replaced by the current CSV missing error', async () => {
  const h = setup({ readPlayCsv: async () => ({ ok: true, found: false, csv: '' }) });
  await h.callback(h.snapshot, 'pending');
  assert.equal(h.saved[0].plays[0].song_id, '-8');
});

test('read rejection and missing API become read errors while pending save and profile upload continue', async () => {
  for (const readPlayCsv of [async () => { throw Error('rejected'); }, undefined]) {
    const h = setup({ readPlayCsv });
    await h.callback(h.snapshot, 'pending');
    assert.equal(h.saved.length, 1);
    assert.deepEqual(h.events.filter(x => typeof x === 'string'), ['save', 'upload']);
    assert.equal(h.events.find(x => typeof x === 'object').uploadedPlays[0].song_id, '-11');
  }
});

test('game gate false omits old plays and a game exit before upload stays omitted', async () => {
  const h = setup();
  // Harness session gate is adjusted by replacing the recognized-session responses.
  h.callback = vm.runInNewContext(callbackCode, {
    IS_BROWSER_REMOTE: false, Date, console: { warn() {}, log() {} },
    window: { infohsorry: { session: { getState: async () => ({ pid: null }) }, upload: { savePending: async s => { h.saved.push(s); return { ok: true }; }, clearPending: async () => ({ ok: true }) } } },
    readIidxIdFresh: async () => ({ processMissing: false }), APP_VERSION: 'current-app', buildUploadPlays: () => [], playsForGame: (p, gate) => gate ? p : undefined,
    uploadProfile: async input => { h.events.push({ uploadedPlays: input.plays }); return { ok: true }; }, uploadAutomaticDbr: async () => {}, addDiagLine() {}, writeLastUploadAt() {},
  });
  await h.callback(h.snapshot, 'pending');
  assert.equal(h.saved[0].plays, undefined);
  assert.equal(h.events.find(x => typeof x === 'object').uploadedPlays, undefined);
});

test('CSV refresh precedes pending save and upload, using current app version', async () => {
  const h = setup({ readPlayCsv: async () => { h.events.push('read'); return { ok: true, csv: csv(row('now', 'latest')), gameVersion: 'actual-game' }; } });
  await h.callback(h.snapshot, 'auto');
  assert.deepEqual(h.events.filter(x => typeof x === 'string'), ['read', 'save', 'upload']);
  assert.equal(h.saved[0].appVersion, 'current-app');
});

const recentSource = read('./Recent.tsx');
const recentStart = recentSource.indexOf('function subscribeRecentPlays(');
const recentEnd = recentSource.indexOf('\nexport default function Recent', recentStart);
const recentFn = recentSource.slice(recentStart, recentEnd);
const recentCode = ts.transpileModule(`${recentFn}; subscribeRecentPlays`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function recentHarness({ readPlayCsv, onPlayAppend } = {}) {
  const updates = []; const listeners = new Set(); const unsubscriptions = [];
  const subscribe = vm.runInNewContext(recentCode, {
    window: { infohsorry: { upload: { readPlayCsv, onPlayAppend: cb => { listeners.add(cb); const off = () => { listeners.delete(cb); unsubscriptions.push(true); }; return off; } } } },
    buildUploadPlays: result => result.rows,
  });
  return { subscribe, updates, listeners, unsubscriptions };
}
const recentRow = timestamp => ({ timestamp });

test('Recent initially reads play history and retains at most 100 rows', async () => {
  const h = recentHarness({ readPlayCsv: async () => ({ ok: true, rows: Array.from({ length: 105 }, (_, i) => recentRow(String(i))) }) });
  const stop = h.subscribe('A123', (rows, error) => h.updates.push({ rows, error }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.updates[0].rows.length, 100);
  assert.equal(h.updates[0].rows[0].timestamp, '5');
  assert.equal(h.updates[0].error, null);
  stop();
});

test('Recent refreshes after append for the subscribed account', async () => {
  let reads = 0;
  const h = recentHarness({ readPlayCsv: async () => ({ ok: true, rows: [recentRow(String(++reads))] }) });
  h.subscribe('A123', (rows, error) => h.updates.push({ rows, error }));
  await new Promise(resolve => setImmediate(resolve));
  [...h.listeners][0]({ iidxId: 'A123' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(h.updates[1].rows[0].timestamp, '2');
});

test('Recent ignores append events from another account', async () => {
  let reads = 0;
  const h = recentHarness({ readPlayCsv: async () => ({ ok: true, rows: [recentRow(String(++reads))] }) });
  h.subscribe('A123', () => {});
  await new Promise(resolve => setImmediate(resolve));
  [...h.listeners][0]({ iidxId: 'B456' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
});

test('Recent account switch ignores late A response and unsubscribes A listener', async () => {
  let resolveA;
  const h = recentHarness({ readPlayCsv: id => id === 'A123'
    ? new Promise(resolve => { resolveA = resolve; })
    : Promise.resolve({ ok: true, rows: [recentRow('B')] }) });
  const stopA = h.subscribe('A123', (rows, error) => h.updates.push({ account: 'A', rows, error }));
  const listenerA = [...h.listeners][0];
  stopA();
  h.subscribe('B456', (rows, error) => h.updates.push({ account: 'B', rows, error }));
  resolveA({ ok: true, rows: [recentRow('late-A')] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.unsubscriptions.length, 1);
  assert.deepEqual(h.updates.map(update => update.account), ['B']);
  assert.equal(h.updates[0].rows[0].timestamp, 'B');
  assert.equal(h.listeners.has(listenerA), false);
});
