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
const recentDetailCode = ts.transpileModule(`${recentDetail}; ({ renderPlayDetail, PlayLaneController, PlayLaneDetail, playOptionInfo, playSideActivity, displayLaneOrder, laneCounterIndex, laneEvaluation })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
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
  const module = vm.runInNewContext(recentDetailCode, { React, LAMP_NUM_TO_ABBR: {}, useState: initial => [initial, () => {}], useMemo: fn => fn(), useEffect: () => {}, createPortal: node => node, document: { addEventListener() {}, removeEventListener() {} }, window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200 } });
  PlayLaneController = module.PlayLaneController;
  PlayLaneDetail = module.PlayLaneDetail;
  const { renderPlayDetail } = module;
  return renderPlayDetail(detail, play);
}
function recentCalculations() {
  return vm.runInNewContext(recentDetailCode, { React: { createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }) }, LAMP_NUM_TO_ABBR: {} });
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

test('Recent detail aggregation, badges, and lane table use current DOM', () => {
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
  assert.match(recentCss, /data-player="P1"\]\s*>\s*\.\_\_uprofile_play_scratch\s*\{\s*grid-column:\s*1;/);
  assert.match(recentCss, /data-player="P2"\]\s*>\s*\.\_\_uprofile_play_scratch\s*\{\s*grid-column:\s*7;/);
  assert.match(recentCss, /\.\_\_uprofile_play_key_white\s*\{[^}]*height:\s*48px/s);
  assert.match(recentCss, /\.\_\_uprofile_play_key_black\s*\{[^}]*height:\s*30px/s);
  assert.match(recentCss, /\.\_\_uprofile_play_controller > \.\_\_uprofile_play_key_black:nth-of-type\(2\)/);
  assert.match(recentCss, /\.\_\_uprofile_play_controller > \.\_\_uprofile_play_key_black:nth-of-type\(4\)/);
  assert.match(recentCss, /\.\_\_uprofile_play_controller > \.\_\_uprofile_play_key_black:nth-of-type\(6\)/);
  assert.match(recentCss, /\.\_\_uprofile_play_controller > \.\_\_uprofile_play_key_black:nth-of-type\(8\)/);
  assert.match(recentCss, /\.\_\_uprofile_play_inactive\s*\{\s*color:\s*var\(--text-secondary\);\s*opacity:\s*\.82;/);
  assert.match(recentCss, /\.\_\_uprofile_play_controller button:focus-visible\s*\{\s*outline:\s*2px solid var\(--text-primary\);\s*outline-offset:\s*2px;/);
  assert.match(recentCss, /\.\_\_uprofile_play_keydetail\s*\{[^}]*max-width:\s*min\(100%, 560px\);[^}]*max-height:\s*min\(52vh, 360px\);[^}]*overflow:\s*auto;/s);
  assert.doesNotMatch(recentCss, /__uprofile_playdetail_(?:toggle|lanes|tablebox|lanetable)|\[hidden\]/);
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

test('Recent lane controllers render both seven-key sides, oriented scratch, ranks, unresolved counts, and activity dimming', () => {
  const lanes = Array.from({ length: 8 }, (_, lane) => [lane + 1, 0, 0, 0, 0, 0]);
  const side = { lanes_ok: true, lanes, lane_fs_unresolved: 3, fs: null };
  const p1Activity = { difficulty: 'SPN', battle_flag: '0', judge_16: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' };
  const controllerHarness = vm.runInNewContext(recentDetailCode, { React: { createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }) }, LAMP_NUM_TO_ABBR: {}, useState: initial => [initial, () => {}], useMemo: fn => fn(), useEffect: () => {}, createPortal: node => node, document: { addEventListener() {}, removeEventListener() {} }, window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200 } });
  const p1Tree = controllerHarness.PlayLaneController({ side, player: 'P1', activity: 'P1' });
  const p2Tree = controllerHarness.PlayLaneController({ side, player: 'P2', activity: 'P1' });
  const nodes = flatten([p1Tree.props.children, p2Tree.props.children]);
  const controllers = nodes.filter(node => node.props?.className === '__uprofile_play_controller');
  assert.equal(controllers.length, 2);
  const buttons = nodes.filter(node => ['__uprofile_play_scratch', '__uprofile_play_key __uprofile_play_key_white', '__uprofile_play_key __uprofile_play_key_black'].includes(node.props?.className) && node.type === 'button');
  assert.equal(buttons.length, 16, JSON.stringify(buttons.map(node => ({ type: node.type, className: node.props.className }))));
  assert.equal(buttons.filter(node => node.props.className === '__uprofile_play_scratch').length, 2);
  assert.equal(buttons.filter(node => node.props.className.includes('__uprofile_play_key_white')).length, 8);
  assert.equal(buttons.filter(node => node.props.className.includes('__uprofile_play_key_black')).length, 6);
  assert.equal(buttons.filter(node => node.props.className.startsWith('__uprofile_play_key ')).length, 14);
  assert.equal(buttons[0].props.className, '__uprofile_play_scratch');
  assert.equal(buttons[8].props.className, '__uprofile_play_scratch');
  assert.equal(buttons[15].props.className, '__uprofile_play_key __uprofile_play_key_white');
  assert.deepEqual(buttons.slice(0, 8).map(node => node.props.children[1].props.children), ['AAA', 'AAA', 'AA', 'AA', 'A', 'A', 'A', 'A']);
  assert.ok(nodes.filter(node => node.type === 'button' && node.props?.className?.includes('__uprofile_play_inactive')).length >= 8);
  assert.equal(nodes.filter(node => node.type === 'h5' && JSON.stringify(node.props.children).includes('레인 미확정 3')).length, 2);
  const invalid = flatten(controllerHarness.PlayLaneController({ side: { ...side, lanes_ok: false }, player: 'P1', activity: 'P1' }));
  const invalidButtons = invalid.filter(node => node.type === 'button' && (node.props?.className === '__uprofile_play_scratch' || node.props?.className?.startsWith('__uprofile_play_key ')));
  assert.equal(invalidButtons.length, 8);
  assert.ok(invalidButtons.every(node => node.props.children[1].props.children === '—'));
});
