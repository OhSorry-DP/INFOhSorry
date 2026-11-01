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
const recentView = recentSource.slice(recentSource.indexOf('function recentPlayTime('), recentSource.indexOf('\nfunction detailSideHidden('));
const recentViewCode = ts.transpileModule(`${recentView}; ({ recentPlayTime })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const recentCss = read('./index.css');
const recentStart = recentSource.indexOf('function subscribeRecentPlays(');
const recentEnd = recentSource.indexOf('\nfunction recentPlayTime(', recentStart);
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

test('Recent display reverses chronological rows and formats KST timestamps', () => {
  const format = vm.runInNewContext(recentViewCode, {}).recentPlayTime;
  const rows = ['2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z'];
  assert.deepEqual([...rows].reverse().map(format), ['11-01 10:00', '11-01 09:00']);
});

test('Recent display preserves repeated songs as separate rows', () => {
  const snippet = recentSource.slice(recentSource.indexOf('{[...recentPlays].reverse().map('), recentSource.indexOf('</div>\n        )}', recentSource.indexOf('{[...recentPlays].reverse().map(')));
  assert.match(snippet, /map\(\(play, index\)/);
  assert.match(snippet, /key=\{`\$\{play\.timestamp\}-\$\{index\}`\}/);
});

test('Recent rows display title, difficulty, EX score in four grid columns', () => {
  const snippet = recentSource.slice(recentSource.indexOf('<span>{recentPlayTime(play.timestamp)}</span>'), recentSource.indexOf('</div>\n            ))}', recentSource.indexOf('<span>{recentPlayTime(play.timestamp)}</span>')));
  assert.match(snippet, /play\.title/);
  assert.match(snippet, /play\.difficulty/);
  assert.match(snippet, /play\.ex_score/);
  assert.match(recentCss, /\.\_\_uprofile_recentplays_row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*104px minmax\(0, 1fr\) 58px 72px;[^}]*gap:\s*8px;/s);
});

test('Recent error row shows its code in one cell', () => {
  const snippet = recentSource.slice(recentSource.indexOf('isPlayErrorRow(play) ?'), recentSource.indexOf(': (\n              <div className="__uprofile_recentplays_row"', recentSource.indexOf('isPlayErrorRow(play) ?')));
  assert.match(snippet, /기록 오류 \(코드 \{play\.song_id\}\)/);
  assert.match(recentCss, /\.\_\_uprofile_recentplays_error\s*\{\s*grid-template-columns:\s*1fr;/);
});

test('Recent distinguishes empty history from read failure and keeps chart list code', () => {
  assert.match(recentSource, /playReadError \? \(/);
  assert.match(recentSource, /recentPlays\.length === 0 \? \(/);
  assert.match(recentSource, /sortRows\(computeTodayCharts\(rows, latestIdx\)\)/);
});

test('Recent only renders expandable play detail when detail exists and is non-null', () => {
  assert.match(recentSource, /play\.detail != null && renderPlayDetail\(play\.detail\)/);
  assert.match(recentSource, /function renderPlayDetail\(detail: PlayDetail\)/);
  assert.match(recentSource, /return <details className="__uprofile_playdetail"><summary>상세 기록<\/summary>/);
});

test('Recent FS summary prints four counts and unresolved count without coercing missing values', () => {
  assert.match(recentSource, /FAST&nbsp; GREAT \{side\.fs\.fast_great \?\? '—'\} · GOOD \{side\.fs\.fast_good \?\? '—'\}　SLOW&nbsp; GREAT \{side\.fs\.slow_great \?\? '—'\} · GOOD \{side\.fs\.slow_good \?\? '—'\}　미확정 \{side\.fs_unresolved \?\? '—'\}/);
});

test('Recent detail shows partial and validation states beside their sections', () => {
  assert.match(recentSource, /!detail\.complete && <span className="__uprofile_playdetail_state">부분 기록<\/span>/);
  assert.match(recentSource, /side\.fs_ok === false && <span className="__uprofile_playdetail_state">검증 불일치<\/span>/);
  assert.match(recentSource, /side\.lanes_ok === false && <span className="__uprofile_playdetail_state">검증 불일치<\/span>/);
});

test('Recent detail table lays out lane indices and six judge plus four lane FS columns', () => {
  assert.match(recentSource, /Array\.from\(\{ length: 8 \}, \(_, lane\)/);
  assert.match(recentSource, /\['PG','GR','GD','BD','PR','空PR','F-GR','F-GD','S-GR','S-GD'\]/);
  assert.match(recentSource, /side\.lane_fs == null \? '—' : side\.lane_fs\[lane\]\?\.\[col\] \?\? '—'/);
});

test('Recent hides a side only when every lane count and FS count is zero or FS is null', () => {
  assert.match(recentSource, /function detailSideHidden\(side: SideDetail \| null \| undefined\)/);
  assert.match(recentSource, /lane\.some\(\(value\) => typeof value !== 'number' \|\| value !== 0\)/);
  assert.match(recentSource, /side\.fs === null \|\| \(side\.fs != null && \[side\.fs\.fast_great, side\.fs\.fast_good, side\.fs\.slow_great, side\.fs\.slow_good\]\.every\(\(value\) => typeof value === 'number' && value === 0\)\)/);
});
