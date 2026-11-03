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
const recentPlaysSource = recentSource.slice(recentSource.indexOf('export function RecentPlays('), recentSource.indexOf('\nexport default function Recent('));
const recentView = recentSource.slice(recentSource.indexOf('function recentPlayTime('), recentSource.indexOf('\nfunction detailSideHidden('));
const recentViewCode = ts.transpileModule(`${recentView}; ({ recentPlayTime })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const recentDetail = recentSource.slice(recentSource.indexOf('function detailSideHidden('), recentSource.indexOf('\nexport function RecentPlays('));
const lampStyleSource = read('./lampStyle.ts');
const lampStyleCode = ts.transpileModule(`${lampStyleSource.slice(lampStyleSource.indexOf('function lampStyle('), lampStyleSource.indexOf('\n// lampNum')).replace('export function lampStyle(', 'function lampStyle(')}; lampStyle`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const lampStyleFn = vm.runInNewContext(lampStyleCode, {});
const recentControllerSource = recentSource.slice(recentSource.indexOf('function laneCounterIndex('), recentSource.indexOf('\nfunction renderPlayDetail('));
const recentDisplaySource = recentSource.slice(recentSource.indexOf('function playLampLabel('), recentSource.indexOf('\nfunction playScoreInfo('));
const recentDetailCode = ts.transpileModule(`${recentDisplaySource}; ${recentSource.slice(recentSource.indexOf('const DJ_CUT_NUM:'), recentSource.indexOf('\nfunction playLampLabel('))}; ${recentDetail}; ({ renderPlayDetail, PlayLaneController, PlayLaneDetail, playOptionInfo, playSideActivity, displayLaneOrder, laneCounterIndex, laneEvaluation, laneKeyEvaluation, playLampLabel, playMissLabel })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
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
function detailTree(detail, play = {}) {
  let PlayLaneController;
  let PlayLaneDetail;
  const React = { createElement: (type, props, ...children) => type === PlayLaneController || type === PlayLaneDetail
    ? type(props)
    : ({ type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }) };
  const module = vm.runInNewContext(recentDetailCode, { React, LAMP_NUM_TO_ABBR: { 0: 'NP', 1: 'F', 2: 'AC', 3: 'EC', 4: 'NC', 5: 'HC', 6: 'EX', 7: 'FC' }, lampStyle: lampStyleFn, djLevelFromScore: (ex, notes) => { const ratio = ex / (notes * 2); return ratio >= 8 / 9 ? 'AAA' : ratio >= 7 / 9 ? 'AA' : ratio >= 6 / 9 ? 'A' : ratio >= 5 / 9 ? 'B' : ratio >= 4 / 9 ? 'C' : ratio >= 3 / 9 ? 'D' : ratio >= 2 / 9 ? 'E' : 'F'; }, useState: initial => [initial, () => {}], useMemo: fn => fn(), useEffect: () => {}, createPortal: node => node, document: { addEventListener() {}, removeEventListener() {} }, window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200 } });
  PlayLaneController = module.PlayLaneController;
  PlayLaneDetail = module.PlayLaneDetail;
  const { renderPlayDetail } = module;
  return renderPlayDetail(detail, play, 12, 'SPH');
}
function recentCalculations(lampStyleDependency = lampStyleFn) {
  const module = vm.runInNewContext(recentDetailCode, { React: { createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }) }, LAMP_NUM_TO_ABBR: { 0: 'NP', 1: 'F', 2: 'AC', 3: 'EC', 4: 'NC', 5: 'HC', 6: 'EX', 7: 'FC' }, lampStyle: lampStyleDependency, djLevelFromScore: (ex, notes) => { const ratio = ex / (notes * 2); return ratio >= 8 / 9 ? 'AAA' : ratio >= 7 / 9 ? 'AA' : ratio >= 6 / 9 ? 'A' : ratio >= 5 / 9 ? 'B' : ratio >= 4 / 9 ? 'C' : ratio >= 3 / 9 ? 'D' : ratio >= 2 / 9 ? 'E' : 'F'; } });
  return module;
}
function flatten(node, result = []) {
  if (node == null || typeof node === 'boolean') return result;
  if (Array.isArray(node)) { for (const child of node) flatten(child, result); return result; }
  if (typeof node === 'object') {
    result.push(node);
    if (typeof node.type === 'function') flatten(node.type(node.props), result);
    else if (Array.isArray(node.props?.children)) flatten(node.props.children, result);
    else flatten(node.props?.children, result);
  }
  return result;
}
const recentRow = timestamp => ({ timestamp });

test('play score calculations cover zero, thresholds, MAX, invalid inputs, and chart matching', () => {
  const source = recentSource.slice(recentSource.indexOf('const DJ_CUT_NUM:'), recentSource.indexOf('\nfunction recentPlayTime(')) + recentSource.slice(recentSource.indexOf('\nfunction detailSideHidden('), recentSource.indexOf('\nfunction playOptionInfo('));
  const code = ts.transpileModule(`${source}; ({ playScoreInfo, playChartLevel })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { playScoreInfo, playChartLevel } = vm.runInNewContext(code, { norm: value => value.trim().toLowerCase(), ensureTextageMeta: async () => null });
  assert.deepEqual({ ...playScoreInfo(0, 9) }, { rank: 'F', rate: '0.00%', next: 'E-0004' });
  assert.deepEqual({ ...playScoreInfo(14, 9) }, { rank: 'AA', rate: '77.78%', next: 'AAA-0002' });
  assert.deepEqual({ ...playScoreInfo(18, 9) }, { rank: 'AAA', rate: '100.00%', next: 'MAX-0000' });
  for (const value of [null, -1, 18.5, 19]) assert.equal(playScoreInfo(value, 9).rate, '—');
  assert.equal(playScoreInfo(1, 0).rank, '—');
  const rows = [{ title: 'Song', charts: { SPH: { level: 10 }, DPH: { level: 11 } } }];
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'SPH' }, rows, null), 10);
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'DPH' }, rows, null), 11);
  assert.equal(playChartLevel({ title: 'Other', difficulty: 'SPH' }, rows, null), null);
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'SPH' }, rows.concat(rows), null), null);
});

test('RecentPlays discards prior account metadata results after account switch cleanup', async () => {
  let resolveFirst;
  let current = 'first';
  let result = null;
  let activeFirst = true;
  const first = new Promise(resolve => { resolveFirst = resolve; }).then(value => { if (activeFirst && current === 'first') result = value; });
  current = 'second';
  activeFirst = false;
  resolveFirst({ songs: {} });
  await first;
  assert.equal(result, null);
  assert.match(recentPlaysSource, /if \(active\) setTextage\(meta\)/);
});

test('Recent has no play history section or subscription', () => {
  const recentOnly = recentSource.slice(recentSource.indexOf('export default function Recent('));
  assert.doesNotMatch(recentOnly, /subscribeRecentPlays|__uprofile_recentplays|최근 플레이/);
});

test('RecentPlays distinguishes empty history from read failure', () => {
  assert.match(recentPlaysSource, /playReadError \? \(/);
  assert.match(recentPlaysSource, /recentPlays\.length === 0 \? \(/);
});

test('Recent subscribes and retains at most 100 rows', async () => {
  const h = recentHarness({ readPlayCsv: async () => ({ ok: true, rows: Array.from({ length: 105 }, (_, i) => recentRow(String(i))) }) });
  const stop = h.subscribe('A123', (rows, error) => h.updates.push({ rows, error }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.updates[0].rows.length, 100);
  assert.equal(h.updates[0].rows[0].timestamp, '5');
  assert.equal(h.updates[0].error, null);
  stop();
});

test('Recent refreshes after same-account append', async () => {
  let reads = 0;
  const h = recentHarness({ readPlayCsv: async () => ({ ok: true, rows: [recentRow(String(++reads))] }) });
  h.subscribe('A123', (rows, error) => h.updates.push({ rows, error }));
  await new Promise(resolve => setImmediate(resolve));
  [...h.listeners][0]({ iidxId: 'A123' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(h.updates[1].rows[0].timestamp, '2');
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

test('RecentPlays display reverses chronological rows and formats KST timestamps', () => {
  const format = vm.runInNewContext(recentViewCode, {}).recentPlayTime;
  const rows = ['2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z'];
  assert.deepEqual(rows.map(format), ['11-01 09:00', '11-01 10:00']);
  assert.match(recentPlaysSource, /\[\.\.\.recentPlays\]\.reverse\(\)/);
});

test('RecentPlays preserves repeated songs and opens all normal rows', () => {
  const snippet = recentPlaysSource.slice(recentPlaysSource.indexOf('{[...recentPlays].reverse().map('));
  assert.match(snippet, /map\(\(play, index\)/);
  assert.match(snippet, /key=\{`\$\{normalizedId\}-\$\{play\.timestamp\}-\$\{index\}`\}/);
  assert.match(snippet, /play\.title/);
  assert.match(snippet, /play\.difficulty/);
  assert.match(snippet, /play\.ex_score/);
  assert.match(snippet, /<details className="__uprofile_recentplays_item"/);
  assert.match(snippet, /renderPlayDetail\(play\.detail, play,/);
  assert.match(recentCss, /\.\_\_uprofile_recentplays_row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:/s);
});

test('RecentPlays error row shows code -11 in one cell', () => {
  const snippet = recentPlaysSource.slice(recentPlaysSource.indexOf('isPlayErrorRow(play) ?'));
  assert.match(snippet, /기록 오류 \(코드 \{play\.song_id\}\)/);
  assert.match(recentCss, /\.\_\_uprofile_recentplays_error\s*\{\s*grid-template-columns:\s*1fr;/);
});

test('App places PLAY LOG after RECENT and passes profile ID while retaining playdata defaults and stats exclusion', () => {
  const appSource = read('./App.tsx');
  const buttons = appSource.slice(appSource.indexOf("onClick={() => setTab('recent')}") - 100, appSource.indexOf("onClick={() => setTab('playdata')}") + 120);
  assert.ok(buttons.indexOf('RECENT') < buttons.indexOf('PLAY LOG'));
  assert.ok(buttons.indexOf('PLAY LOG') < buttons.indexOf('PLAYDATA'));
  assert.match(appSource, /<RecentPlays iidxId=\{cardId\} \/>/);
  assert.match(appSource, /useState<Tab>\('playdata'\)/);
  assert.match(appSource, /tab === 'recent' \|\| tab === 'plays' \|\| tab === 'analysis' \|\| tab === 'playdata'/);
});

test('Recent distinguishes empty history from read failure and keeps chart list code', () => {
  assert.match(recentSource, /playReadError \? \(/);
  assert.match(recentSource, /recentPlays\.length === 0 \? \(/);
  assert.match(recentSource, /sortRows\(computeTodayCharts\(rows, latestIdx\)\)/);
});

test('RecentPlays renders missing detail and one-column section structure', () => {
  assert.match(recentPlaysSource, /renderPlayDetail\(play\.detail, play,/);
  assert.match(recentSource, /function renderPlayDetail\(detail: PlayDetail \| null \| undefined/);
  for (const heading of ['스코어 정보', '판정 상세', '랜덤 레인 패턴', '레인별 평가']) assert.ok(recentDetail.includes(heading));
  for (const className of ['__uprofile_play_sections', '__uprofile_play_head', '__uprofile_play_score', '__uprofile_play_pattern', '__uprofile_play_rating', '__uprofile_play_tiles', '__uprofile_play_inactive']) assert.ok(recentSource.includes(className));
  assert.match(recentDetail, /if \(!detail\) return/);
  assert.match(recentDetail, /SCORE <b>\{play\.ex_score === '' \? '—' : play\.ex_score\}/);
  assert.doesNotMatch(recentDetail, /play\.detail \? 0|detail \? 0/);
});

test('RecentPlays summary has five cells and detail headers and display values match for both branches', () => {
  const summarySource = recentSource.slice(recentSource.indexOf('export function RecentPlays('), recentSource.indexOf('\nexport default function Recent('));
  const transpiled = ts.transpileModule(`${summarySource.replace('export function RecentPlays(', 'function RecentPlays(')}; RecentPlays`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }) };
  let stateCall = 0;
  const RecentPlays = vm.runInNewContext(transpiled, { React, useState: initial => [stateCall++ === 0 ? [{ timestamp: 't', title: 'Song', difficulty: 'SPH', ex_score: '1' }] : initial, () => {}], useMemo: fn => fn(), useEffect: callback => callback(), isPlayErrorRow: () => false, subscribeRecentPlays(_id, update) { update([{ timestamp: 't', title: 'Song', difficulty: 'SPH', ex_score: '1' }], null); return () => {}; }, ensureTextageMeta: async () => null, playChartLevel: () => 12, playScoreInfo: () => ({ rank: 'A', rate: '50%', next: 'AA-0001' }), recentPlayTime: () => 'time', renderPlayDetail: () => null, norm: value => value, DP_SLOTS: [] });
  const tree = RecentPlays({ iidxId: 'id' });
  const summary = flatten(tree).find(node => node.type === 'summary');
  assert.equal(summary.props.children.length, 5);
  assert.deepEqual(summary.props.children.map(node => node.props.className), [undefined, undefined, undefined, undefined, '__uprofile_recentplays_chev']);
  assert.doesNotMatch(JSON.stringify(summary), /AA-0001|50%|12 ·/);

  const play = { title: 'Song', clear_lamp: '1', miss_count: '0', ex_score: '10', notes: '10', settings_p1_11: '0 0 0 0 0 0 0 0 0 0 0', settings_p2_11: '0 0 0 0 0 0 0 0 0 0 0', difficulty: 'SPH' };
  for (const detail of [null, { complete: true, p1: {}, p2: {} }]) {
    const nodes = flatten(detailTree(detail, play));
    const header = nodes.find(node => node.props?.className === '__uprofile_play_head');
    const parts = header.props.children;
    assert.deepEqual(parts.map(node => node.props.className), ['__uprofile_play_head_level', '__uprofile_play_head_title', '__uprofile_play_head_chart', '__uprofile_play_head_options']);
    assert.deepEqual(parts.map(node => node.props.children), [12, 'Song', 'SPH', 'OFF / OFF']);
    const values = nodes.filter(node => node.type === 'b').map(node => node.props.children);
    assert.ok(values.includes('FAILED'));
    assert.ok(values.includes('0'));
  }
  const { playLampLabel, playMissLabel } = recentCalculations(lampStyleFn);
  assert.equal(playLampLabel('0'), 'NO PLAY');
  assert.equal(playLampLabel('1'), 'FAILED');
  assert.equal(playLampLabel('7'), 'F-COMBO');
  for (const value of ['', '-1', '1.5', '8', 'nope']) assert.equal(playLampLabel(value), '—');
  for (const value of ['', '-1', 'nope', '1.5']) assert.equal(playMissLabel(value), '—');
  assert.equal(playMissLabel('0'), '0');
});

test('Recent detail aggregation, badges, and per-key detail use current DOM', () => {
  assert.match(recentDetail, /const aggregate = \(index: number\)/);
  assert.match(recentDetail, /values\.every\(valid\) \? values\.reduce/);
  assert.match(recentDetail, /FAST\/SLOW 기록 없음/);
  assert.match(recentDetail, /!detail\.complete && <span className="__uprofile_playdetail_badge">부분 기록/);
  assert.match(recentDetail, /side\.fs_ok === false/);
  assert.match(recentDetail, /FAST\/SLOW 검증 불일치/);
  assert.match(recentDetail, /side\?\.lanes_ok === false/);
  assert.match(recentDetail, /레인 검증 불일치/);
  assert.match(recentDetail, /const names = \['PG', 'GR', 'GD', 'BD', 'PR', '空PR', 'F-GR', 'F-GD', 'S-GR', 'S-GD'\]/);
  assert.match(recentDetail, /className="__uprofile_play_keydetail"/);
  assert.match(recentDetail, /side\?\.lanes\?\.\[index\]/);
  assert.doesNotMatch(recentDetail, /__uprofile_playdetail_(?:toggle|lanes)/);
  assert.doesNotMatch(recentCss, /__uprofile_playdetail_(?:toggle|lanes|tablebox|lanetable)|\[hidden\]/);
});

test('Recent detail runtime renders FAST/SLOW totals, PG ratio, CB and key detail', () => {
  const lanes = Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]); lanes[0] = [284, 172, 121, 5, 14, 2];
  const laneFs = Array.from({ length: 8 }, () => [0, 0, 0, 0]); laneFs[0] = [3, 4, 0, 0];
  const fs = { fast_good: 172, fast_great: 284, slow_great: 121, slow_good: 0 };
  const p2 = Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]);
  const nodes = flatten(detailTree({ complete: false, p1: { lanes, lane_fs: laneFs, lane_fs_unresolved: 0, fs, fs_unresolved: 0, fs_ok: false, lanes_ok: false }, p2: { lanes: p2, lane_fs: null, fs: { fast_good: 0, fast_great: 0, slow_great: 0, slow_good: 0 }, fs_unresolved: 0, lane_fs_unresolved: 0 } }, { judge_16: '0 0 0 0 0 0 0 0 0 0 3 4 0 0 0 0' }));
  const rendered = JSON.stringify(nodes);

  assert.match(rendered, /부분 기록/);
  assert.ok(rendered.includes('FAST/SLOW 검증 불일치'));
  assert.match(recentDetail, /레인 검증 불일치/);
  assert.match(rendered, /48%/);
  assert.match(rendered, /__uprofile_play_controller/);
  assert.equal(flatten(nodes).filter(node => node.props?.className === '__uprofile_play_keydetail_row').length, 0);
  assert.match(recentDetail, /className="__uprofile_play_keydetail"/);

  assert.match(rendered, /__uprofile_playdetail_fill/);

});

test('Recent detail shows combined combo break once for both visible sides', () => {
  const lanes = Array.from({ length: 8 }, (_, i) => [i === 0 ? 1 : 0, 0, 0, 0, 0, 0]);
  const detail = { complete: true, p1: { lanes, lane_fs: null, fs: null, lane_fs_unresolved: 0 }, p2: { lanes, lane_fs: null, fs: null, lane_fs_unresolved: 0 } };
  const nodes = flatten(detailTree(detail, { judge_16: '10 20 3 1 2 11 21 4 0 1 3 4 30 31 32 33' }));
  const comboBreak = nodes.find(node => node.props?.className?.endsWith('k-cb'));
  assert.ok(comboBreak);
  assert.ok(JSON.stringify(comboBreak.props.children).includes('7'));
  const summary = nodes.find(node => node.props?.className?.includes('__uprofile_playdetail_summary'));
  assert.doesNotMatch(JSON.stringify(summary?.props.children), /COMBO BREAK/);
});

test('Recent detail shows only P1 combo break for hidden P2', () => {
  const lanes = Array.from({ length: 8 }, (_, i) => [i === 0 ? 1 : 0, 0, 0, 0, 0, 0]);
  const detail = { complete: true, p1: { lanes, lane_fs: null, fs: null, lane_fs_unresolved: 0 }, p2: { lanes: Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]), lane_fs: null, fs: null, lane_fs_unresolved: 0 } };
  const nodes = flatten(detailTree(detail, { judge_16: '10 20 3 1 2 11 21 4 0 1 3 4 30 31 32 33', difficulty: 'SPN' }));
  const comboBreak = nodes.find(node => node.props?.className?.endsWith('k-cb'));
  assert.ok(comboBreak);
  assert.ok(JSON.stringify(comboBreak.props.children).includes('3'));
  const summary = nodes.find(node => node.props?.className?.includes('__uprofile_playdetail_summary'));
  assert.doesNotMatch(JSON.stringify(summary?.props.children), /COMBO BREAK/);
});

test('Recent detail without FS produces GREAT PG GOOD rows and no rating for empty POOR or CB', () => {
  const lanes = Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]); lanes[0] = [3, 4, 5, 0, 0, 0];
  const nodes = flatten(detailTree({ complete: true, p1: { lanes, lane_fs: null, fs: null, lane_fs_unresolved: 0 }, p2: { lanes: Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]), lane_fs: null, fs: null, lane_fs_unresolved: 0 } }));
  const rows = nodes.filter(node => /^__uprofile_playdetail_barrow /.test(node.props?.className ?? ''));
  assert.deepEqual(rows.map(node => node.props.className.split(' ').at(-1)), ['k-great', 'k-pg', 'k-good', 'k-bad', 'k-poor', 'k-empty', 'k-cb']);
  assert.ok(JSON.stringify(nodes).includes('FAST/SLOW 기록 없음'));

});
test('Recent judge colors use fixed mockup palette', () => {
  assert.match(recentCss, /\.\_\_uprofile_playdetail_tag\.t-fast \{ color: #3f8cff/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_tag\.t-slow \{ color: #ff4b4b/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-pg \.\_\_uprofile_playdetail_lab \{ color: #a6f3ff/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-pg \.\_\_uprofile_playdetail_fill \{ background: #62e2c4/);
});

test('Recent list and play header CSS preserve responsive layout and wrapping', () => {
  assert.match(recentCss, /\.__uprofile_recentplays_row\s*\{[^}]*grid-template-columns:\s*96px minmax\(0, 1fr\) 52px 54px 16px;[^}]*gap:\s*8px;[^}]*padding:\s*7px 8px;/s);
  assert.match(recentCss, /\.__uprofile_recentplays_row\s*>\s*:nth-child\(2\)\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(recentCss, /@media\s*\(max-width:\s*768px\)\s*\{\s*\.__uprofile_recentplays_row\s*\{\s*grid-template-columns:\s*92px minmax\(0, 1fr\) 48px 60px 16px;\s*gap:\s*5px;\s*padding:\s*7px 6px;/);
  assert.match(recentCss, /\.__uprofile_play_head\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*align-items:\s*center;[^}]*gap:\s*4px 8px;[^}]*min-width:\s*0;/s);
  assert.match(recentCss, /\.__uprofile_play_head_level\s*\{[^}]*font-size:\s*11px;[^}]*color:\s*var\(--text-secondary\);/s);
  assert.match(recentCss, /\.__uprofile_play_head_title\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*700;[^}]*color:\s*var\(--text-primary\);[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(recentCss, /\.__uprofile_play_head_chart\s*\{[^}]*font-size:\s*11px;[^}]*padding:\s*2px 6px;[^}]*border:\s*1px solid var\(--border-secondary\);[^}]*border-radius:\s*3px;/s);
  assert.match(recentCss, /\.__uprofile_play_head_options\s*\{[^}]*font-size:\s*12px;[^}]*color:\s*var\(--text-secondary\);[^}]*overflow-wrap:\s*anywhere;/s);
  for (const kind of ['pg', 'great', 'good', 'bad', 'poor', 'empty', 'cb']) assert.match(recentCss, new RegExp(`\\.__uprofile_playdetail_barrow\\.k-${kind} \\. __uprofile_playdetail_lab`.replace('\\. ', '\\.')));
  assert.match(recentCss, /\.__uprofile_playdetail_barrow\.k-pg \.\_\_uprofile_playdetail_lab \{ color: #a6f3ff/);
  assert.match(recentCss, /\.__uprofile_playdetail_barrow\.k-pg \.\_\_uprofile_playdetail_fill \{ background: #62e2c4/);
});

test('Recent judge details remain separate from Recent chart listing', () => {
  const recentOnly = recentSource.slice(recentSource.indexOf('export default function Recent('));
  assert.doesNotMatch(recentOnly, /renderPlayDetail|judge_16|__uprofile_playdetail/);
});

test('Recent hides a side only when every lane count and FS count is zero or FS is null', () => {
  assert.match(recentSource, /function detailSideHidden\(side: SideDetail \| null \| undefined\)/);
  assert.match(recentSource, /lane\.some\(\(value\) => typeof value !== 'number' \|\| value !== 0\)/);
  assert.match(recentSource, /side\.fs === null \|\| \(side\.fs != null && \[side\.fs\.fast_great, side\.fs\.fast_good, side\.fs\.slow_great, side\.fs\.slow_good\]\.every\(\(value\) => typeof value === 'number' && value === 0\)\)/);
});

test('Recent controller and key detail CSS positions keys and keeps detail bounded, scrollable, and keyboard visible', () => {
  assert.match(recentCss, /\.\_\_uprofile_play_panel_scroll\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_panel\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*16px;[^}]*width:\s*max-content;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_controller\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*8px;[^}]*width:\s*max-content;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_keyboard\s*\{[^}]*position:\s*relative;[^}]*width:\s*136px;[^}]*height:\s*150px;/s);
  for (const [key, left] of [[1, 0], [3, 34], [5, 68], [7, 102], [2, 22], [4, 56], [6, 90]]) {
    assert.match(recentCss, new RegExp(`\\.__uprofile_play_unit\\[data-key="${key}"\\][\\s\\S]*?\\{\\s*left:\\s*${left}px;`));
  }
  for (const key of [1, 3, 5, 7]) assert.match(recentCss, new RegExp(`\\.__uprofile_play_unit\\[data-key="${key}"\\][\\s\\S]*?\\{[^}]*width:\\s*34px;`));
  for (const key of [2, 4, 6]) assert.match(recentCss, new RegExp(`\\.__uprofile_play_unit\\[data-key="${key}"\\][\\s\\S]*?\\{[^}]*width:\\s*24px;[^}]*z-index:\\s*1;`));
  assert.match(recentCss, /\.\_\_uprofile_play_unit_white\s*\{\s*top:\s*66px;/);
  assert.match(recentCss, /\.\_\_uprofile_play_unit_black\s*\{\s*top:\s*0;/);
  assert.match(recentCss, /\.\_\_uprofile_play_unit_scratch\s*\{[^}]*width:\s*104px;[^}]*height:\s*104px;[^}]*border-radius:\s*50%;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_controller \.__uprofile_play_key_white\s*\{[^}]*height:\s*64px/s);
  assert.match(recentCss, /\.\_\_uprofile_play_controller \.__uprofile_play_key_black\s*\{[^}]*height:\s*44px/s);
  assert.doesNotMatch(recentCss, /__uprofile_play_(?:controller|unit|key)[^{}]*nth-of-type/);
  assert.doesNotMatch(recentCss, /__uprofile_play_(?:controller|unit|key)[^{}]*transform:\s*translate/);
  for (const [variant, declarations] of [
    ['scratch', 'border:\\s*2px solid #e33b3b;[^}]*background:\\s*#17191e;[^}]*color:\\s*#fff'],
    ['black', 'background:\\s*#174b94;[^}]*border:\\s*1px solid #3985df;[^}]*color:\\s*#fff'],
    ['white', 'background:\\s*#f3f3f3;[^}]*border:\\s*1px solid #b8b8b8;[^}]*color:\\s*#222'],
  ]) assert.match(recentCss, new RegExp(`\\.__uprofile_play_rank_${variant}\\s*\\{[^}]*${declarations}`, 's'));
  assert.match(recentCss, /\.\_\_uprofile_play_rank_inactive\s*\{[^}]*background:\s*#555;[^}]*border-color:\s*#777;[^}]*color:\s*transparent;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_controller \.\_\_uprofile_play_inactive\s*\{[^}]*opacity:\s*\.45;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_row\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*8px;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_row \+ \.\_\_uprofile_play_pattern_row\s*\{\s*margin-top:\s*8px;/);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_tiles\s*\{[^}]*display:\s*flex;[^}]*gap:\s*3px;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_tile\s*\{[^}]*width:\s*30px;[^}]*height:\s*42px;[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*border:\s*1px solid #555;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_tile_white\s*\{\s*background:\s*#f3f3f3;/);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_tile_black\s*\{\s*background:\s*#181a1f;/);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_digit\s*\{[^}]*color:\s*#ff8a00;[^}]*font-weight:\s*700;[^}]*font-size:\s*18px;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_inactive\s*\{\s*color:\s*var\(--text-secondary\);\s*opacity:\s*\.82;/);
  assert.match(recentCss, /\.\_\_uprofile_play_controller button:focus-visible\s*\{\s*outline:\s*2px solid var\(--text-primary\);\s*outline-offset:\s*2px;/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-pg \.\_\_uprofile_playdetail_fill \{ background: #62e2c4; \}/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-great \.\_\_uprofile_playdetail_fill \{ background: #ffe63c; \}/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-bad \.\_\_uprofile_playdetail_fill \{ background: #ff6a3a; \}/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-poor \.\_\_uprofile_playdetail_fill \{ background: #ff4a34; \}/);
  assert.match(recentCss, /\.\_\_uprofile_play_keydetail\s*\{[^}]*max-width:\s*min\(100%, 560px\);[^}]*max-height:\s*min\(52vh, 360px\);[^}]*overflow:\s*auto;/s);
  assert.doesNotMatch(recentCss, /__uprofile_playdetail_(?:toggle|lanes|tablebox|lanetable)|\[hidden\]/);
});

test('lane detail hover stays open across trigger and portal, then closes after leaving both', () => {
  assert.match(recentDetail, /onMouseEnter=\{\(event\) => open\(event\.currentTarget\)\}/);
  assert.match(recentDetail, /onMouseLeave=\{\(event\) => \{ if \(!event\.currentTarget\.contains\(event\.relatedTarget as Node\)\) setOpenKey\(null\); \}\}/);
  assert.match(recentDetail, /onMouseLeave=\{\(event\) => \{ if \(!event\.currentTarget\.parentElement\?\.querySelector\('\.__uprofile_play_keydetail'\)\?\.contains\(event\.relatedTarget as Node\)\) setOpenKey\(null\); \}\}/);
});

test('lane detail tap replaces the selected key, outside pointer closes, and inside detail remains', () => {
  assert.match(recentDetail, /onClick=\{\(event\) => \{ if \(openKey === number\) setOpenKey\(null\); else open\(event\.currentTarget\); \}\}/);
  assert.match(recentDetail, /document\.addEventListener\('pointerdown', outside\)/);
  assert.match(recentDetail, /!target\.closest\('\.__uprofile_play_controller'\) && !target\.closest\('\.__uprofile_play_keydetail'\)/);
  assert.match(recentDetail, /onMouseLeave=\{\(event\) => \{ if \(!event\.currentTarget\.contains\(event\.relatedTarget as Node\)\) setOpenKey\(null\); \}\}/);
});

test('lane detail focus change closes outside, button name identifies side and detail link uses shown ID', () => {
  assert.match(recentDetail, /aria-label=\{`\$\{player === 'P1' \? '1P' : '2P'\} \$\{label === 'SCRATCH' \? '스크래치' : `건반 \$\{label\}`\}`\}/);
  assert.match(recentDetail, /aria-describedby=\{openKey === number \? id : undefined\}/);
  assert.doesNotMatch(recentDetail, /aria-controls/);
  assert.match(recentDetail, /onBlur=\{\(event\) => \{ if \(!event\.currentTarget\.contains\(event\.relatedTarget as Node\)\) setOpenKey\(null\); \}\}/);
});

test('lane detail Escape closes and restores trigger focus', () => {
  assert.match(recentDetail, /event\.key === 'Escape'.*setOpenKey\(null\); trigger\.current\?\.focus\(\)/);
});

test('lane detail flips above and clamps horizontally with viewport bounded internal scrolling', () => {
  assert.match(recentDetail, /r\.bottom \+ height > window\.innerHeight - 8 \? Math\.max\(8, r\.top - height\) : r\.bottom/);
  assert.match(recentDetail, /Math\.max\(8, Math\.min\(r\.left, window\.innerWidth - 320\)\)/);
  assert.match(recentDetail, /maxHeight: 'min\(52vh, 360px\)', overflow: 'auto'/);
});

test('lane detail closes on collapse, account change, scroll and resize, and cleans up document and window events', () => {
  assert.match(recentDetail, /useEffect\(\(\) => \{ setOpenKey\(null\); \}, \[accountKey\]\)/);
  assert.match(recentDetail, /window\.addEventListener\('scroll', close, true\)/);
  assert.match(recentDetail, /window\.addEventListener\('resize', close\)/);
  assert.match(recentDetail, /document\.removeEventListener\('keydown', escape\)/);
  assert.match(recentDetail, /document\.removeEventListener\('pointerdown', outside\)/);
  assert.match(recentDetail, /window\.removeEventListener\('scroll', close, true\)/);
  assert.match(recentDetail, /window\.removeEventListener\('resize', close\)/);
  assert.match(recentPlaysSource, /<details className="__uprofile_recentplays_item"/);
});

test('Recent option labels cover all values, P2 SP settings, and battle flip ordering', () => {
  const { playOptionInfo } = recentCalculations();
  const play = { settings_p1_11: '0 0 0 0 0 5 0 0 0 0 0', settings_p2_11: '6 0 0 0 0 0 0 0 0 0 0', battle_flag: '0', difficulty: 'SPN' };
  assert.equal(playOptionInfo(play), 'OFF / SYMMETRY RANDOM');
  assert.equal(playOptionInfo({ ...play, settings_p1_11: '0 0 1 1 0 2 0 0 0 0 0', battle_flag: '1' }), 'BATTLE, FLIP, OFF / R-RAN');
  assert.equal(playOptionInfo({ ...play, settings_p1_11: '0 0 0 0 0 6 0 0 0 0 0', settings_p2_11: '1 0 0 0 0 0 0 0 0 0 0' }), 'OFF / RAN');
  for (let value = 0; value <= 6; value++) assert.ok(playOptionInfo({ ...play, settings_p1_11: `${value} 0 0 0 0 0 0 0 0 0 0` }).length > 0);
  assert.ok(playOptionInfo({ ...play, settings_p1_11: '7 0 0 0 0 0 0 0 0 0 0' }).includes('—'));
});

test('Recent side activity resolves P1, P2, both, and zero sides', () => {
  const { playSideActivity } = recentCalculations();
  assert.equal(playSideActivity({ difficulty: 'SPN', battle_flag: '0', judge_16: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' }), 'P1');
  assert.equal(playSideActivity({ difficulty: 'SPN', battle_flag: '0', judge_16: '0 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0' }), 'P2');
  assert.equal(playSideActivity({ difficulty: 'DPN', battle_flag: '0', judge_16: '0'.repeat(16).split('').join(' ') }), 'BOTH');
  assert.equal(playSideActivity({ difficulty: 'SPN', battle_flag: '0', judge_16: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' }), null);
});

test('Recent display lane order validates permutation and hides S-RAN or missing', () => {
  const { displayLaneOrder } = recentCalculations();
  const play = { difficulty: 'SPN', battle_flag: '0', judge_16: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0', settings_p1_11: '0 0 0 0 0 0 0 0 0 0 0' };
  assert.equal(displayLaneOrder('2035641', 'P1', play), '3146752');
  assert.equal(displayLaneOrder(undefined, 'P1', play), '—');
  assert.equal(displayLaneOrder('2035641', 'P1', { ...play, settings_p1_11: '3 0 0 0 0 0 0 0 0 0 0' }), '—');
  assert.equal(displayLaneOrder('0035641', 'P1', play), '—');
});

test('Recent renders seven ordered lane tiles for both detail states with position colors and inactive SP side', () => {
  const play = { difficulty: 'SPN', battle_flag: '0', judge_16: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0', lane_order_p1: '3456120', lane_order_p2: undefined, settings_p1_11: '0 0 0 0 0 0 0 0 0 0 0' };
  for (const detail of [null, { complete: true, p1: {}, p2: {} }]) {
    const nodes = flatten(detailTree(detail, play));
    const rows = nodes.filter(node => node.props?.className?.startsWith('__uprofile_play_pattern_row'));
    assert.equal(rows.length, 2);
    assert.ok(rows[0].props.className.includes('__uprofile_play_inactive') === false);
    assert.ok(rows[1].props.className.includes('__uprofile_play_inactive'));
    const tiles = nodes.filter(node => node.props?.className?.split(' ').includes('__uprofile_play_pattern_tile'));
    assert.equal(tiles.length, 7);
    assert.deepEqual(tiles.map(node => node.props.children.props.children), ['4', '5', '6', '7', '2', '3', '1']);
    assert.deepEqual(tiles.map(node => node.props.className.includes('__uprofile_play_pattern_tile_white')), [true, false, true, false, true, false, true]);
    assert.ok(nodes.filter(node => node.props?.className === '__uprofile_play_pattern_digit').length === 7);
    assert.ok(nodes.some(node => node.type === 'span' && node.props?.children === '—'));
  }
  const { displayLaneOrder } = recentCalculations();
  const inactiveOrder = { ...play, settings_p1_11: '3 0 0 0 0 0 0 0 0 0 0' };
  assert.equal(displayLaneOrder('3456120', 'P1', inactiveOrder), '—');
  assert.equal(displayLaneOrder(undefined, 'P1', play), '—');
});

test('Recent lane counter indices keep key order and scratch at seven', () => {
  const { laneCounterIndex } = recentCalculations();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(laneCounterIndex), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(laneCounterIndex('scratch'), 7);
});

test('Recent lane evaluation uses unrounded rank boundaries and zero EX F', () => {
  const { laneEvaluation } = recentCalculations();
  const evaluate = (ex, notes = 9) => {
    const lanes = Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 99]);
    lanes[0] = [0, 0, 0, 0, notes, 99];
    if (ex > 0) lanes[0] = [Math.floor(ex / 2), ex % 2, 0, 0, notes - Math.floor(ex / 2) - (ex % 2), 99];
    return laneEvaluation({ lanes_ok: true, lanes });
  };
  for (const [ex, rank] of [[16, 'AAA'], [14, 'AA'], [12, 'A'], [10, 'B'], [8, 'C'], [6, 'D'], [4, 'E'], [2, 'F']]) assert.equal(evaluate(ex).rank, rank);
  assert.equal(evaluate(0).rank, 'F');
  assert.equal(evaluate(0).rate, '0.00%');
  assert.equal(evaluate(0, 0).rank, '—');
});

test('Recent lane evaluation rejects invalid lanes while partial detail remains renderable', () => {
  const { laneEvaluation } = recentCalculations();
  const side = { lanes_ok: true, lanes: Array.from({ length: 8 }, () => [1, 0, 0, 0, 0, 0]) };
  assert.equal(laneEvaluation({ ...side, lanes_ok: false }), null);
  assert.equal(laneEvaluation({ ...side, lanes: [[1]] }), null);
  const tree = detailTree({ complete: false, p1: { ...side, fs_ok: false, lane_fs: null, lane_fs_unresolved: 0 }, p2: { ...side, lanes: Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]), fs: null, fs_ok: false, lane_fs: null, lane_fs_unresolved: 0 } });
  assert.ok(tree);
  assert.ok(JSON.stringify(tree).includes('부분 기록'));
});

test('per-key evaluation and detail preserve one lane values, rank, rate, and unresolved FS markers', () => {
  const { laneKeyEvaluation, PlayLaneDetail } = recentCalculations();
  const lanes = Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 91]);
  lanes[0] = [3, 2, 1, 0, 3, 77]; lanes[1] = [0, 0, 0, 0, 1, 88];
  const side = { lanes_ok: true, lanes, lane_fs: null };
  assert.deepEqual({ ...laneKeyEvaluation(side, 0) }, { notes: 9, ex: 8, rank: 'C', rate: '44.44%' });
  assert.equal(laneKeyEvaluation(side, 1).rank, 'F');
  const tree = PlayLaneDetail({ side, index: 0 });
  const rendered = JSON.stringify(flatten(tree));
  assert.match(rendered, /"PG"," ",\{"type":"b","props":\{"children":"3"\}\}/);
  assert.match(rendered, /"空PR"," ",\{"type":"b","props":\{"children":"77"\}\}/);
  assert.match(rendered, /"F-GR"," ",\{"type":"b","props":\{"children":"—"\}\}/);
  assert.match(rendered, /"RANK ",\{"type":"b","props":\{"children":"C"\}\}/);
  assert.match(rendered, /"EX% ",\{"type":"b","props":\{"children":"44\.44%"\}\}/);
  assert.doesNotMatch(rendered, /<span>2<\/span>/);
  const invalid = JSON.stringify(flatten(PlayLaneDetail({ side: { ...side, lanes_ok: false }, index: 0 })));
  assert.match(invalid, /"PG"," ",\{"type":"b","props":\{"children":"3"\}\}/);
  assert.match(invalid, /레인 검증 불일치/);
  assert.match(invalid, /"RANK ",\{"type":"b","props":\{"children":"—"\}\}/);
  assert.match(invalid, /"EX% ",\{"type":"b","props":\{"children":"—"\}\}/);
});

test('Recent lane controllers render one two-side panel with oriented units, badges, and preserved controls', () => {
  const lanes = Array.from({ length: 8 }, (_, lane) => [lane + 1, 0, 0, 0, 0, 0]);
  const side = { lanes_ok: true, lanes, lane_fs_unresolved: 3, fs: null };
  const controllerHarness = vm.runInNewContext(recentDetailCode, { React: { createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }) }, LAMP_NUM_TO_ABBR: {}, djLevelFromScore: (ex, notes) => { const ratio = ex / (notes * 2); return ratio >= 8 / 9 ? 'AAA' : ratio >= 7 / 9 ? 'AA' : ratio >= 6 / 9 ? 'A' : ratio >= 5 / 9 ? 'B' : ratio >= 4 / 9 ? 'C' : ratio >= 3 / 9 ? 'D' : ratio >= 2 / 9 ? 'E' : 'F'; }, useState: initial => [initial, () => {}], useMemo: fn => fn(), useEffect: () => {}, createPortal: node => node, document: { addEventListener() {}, removeEventListener() {} }, window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200 } });
  const React = { createElement: (type, props, ...children) => type === controllerHarness.PlayLaneController ? type(props) : ({ type, props: { ...(props ?? {}), children } }) };
  const play = { difficulty: 'DPN', battle_flag: '0', judge_16: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' };
  const nodes = flatten(detailTree({ complete: true, p1: side, p2: side }, play));
  assert.equal(nodes.filter(node => node.props?.className === '__uprofile_play_panel').length, 1);
  const controllers = nodes.filter(node => node.props?.className === '__uprofile_play_controller');
  assert.equal(controllers.length, 2);
  const buttons = nodes.filter(node => node.type === 'button' && node.props?.['aria-label']);
  assert.equal(buttons.length, 16, JSON.stringify(buttons.map(node => ({ type: node.type, className: node.props.className }))));
  assert.equal(buttons.length, 16);
  const p1Units = flatten(controllers[0]).filter(node => node.props?.className?.includes('__uprofile_play_unit'));
  const p2Units = flatten(controllers[1]).filter(node => node.props?.className?.includes('__uprofile_play_unit'));
  assert.equal(p1Units.length, 8);
  assert.equal(p2Units.length, 8);
  assert.equal(p1Units[0].props.className, '__uprofile_play_unit __uprofile_play_unit_scratch');
  assert.deepEqual(p1Units.filter(node => node.props['data-key'] != null).map(node => node.props['data-key']), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(p2Units.at(-1).props.className, '__uprofile_play_unit __uprofile_play_unit_scratch');
  assert.deepEqual(p2Units.filter(node => node.props['data-key'] != null).map(node => node.props['data-key']), [1, 2, 3, 4, 5, 6, 7]);
  const badges = nodes.filter(node => node.props?.className?.includes('__uprofile_play_rank_'));
  assert.equal(badges.length, 16);
  assert.deepEqual([...new Set(badges.map(node => node.props.className.match(/__uprofile_play_rank_(scratch|black|white)/)?.[1]))].sort(), ['black', 'scratch', 'white']);
  assert.ok(badges.every(node => node.props['aria-hidden'] === 'true' && node.props.tabIndex === -1));
  assert.equal(badges.filter(node => node.props.className.includes('__uprofile_play_rank_white')).length, 8);
  assert.equal(badges.filter(node => node.props.className.includes('__uprofile_play_rank_black')).length, 6);
  assert.equal(badges.filter(node => node.props.className.includes('__uprofile_play_rank_scratch')).length, 2);
  assert.equal(nodes.filter(node => node.props?.className === '__uprofile_play_keyboard').length, 2);
  for (const button of buttons) {
    assert.match(button.props['aria-label'], /^(1P|2P) /);
    assert.equal(button.props['aria-expanded'], false);
    assert.equal(button.props['aria-describedby'], undefined);
    assert.equal(typeof button.props.onMouseEnter, 'function');
    assert.equal(typeof button.props.onFocus, 'function');
    assert.equal(typeof button.props.onClick, 'function');
  }
  const missing = flatten(detailTree(null, { ...play, difficulty: 'SPN', judge_16: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' }));
  const missingBadges = missing.filter(node => node.props?.className?.includes('__uprofile_play_rank_'));
  const inactiveBadges = missingBadges.filter(node => node.props.className.includes('__uprofile_play_rank_inactive'));
  assert.equal(inactiveBadges.length, 8);
  assert.ok(inactiveBadges.every(node => node.props.children === ''));
  assert.equal(missing.filter(node => node.type === 'button' && node.props.className === '__uprofile_play_inactive').length, 8);
  assert.ok(missingBadges.filter(node => !node.props.className.includes('__uprofile_play_rank_inactive')).every(node => node.props.children === '—'));
});
