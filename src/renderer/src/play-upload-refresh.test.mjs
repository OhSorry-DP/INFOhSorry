import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const app = read('./App.tsx');
const start = app.indexOf('  const uploadSnapshot = useCallback(async (snapshot: UploadSnapshot, trigger: string)');
const end = app.indexOf('\n  // IIDX ID 전환은', start);
const fn = app.slice(start, end).replace('  const uploadSnapshot = useCallback(', '').replace(/, \[onDbrSaved\]\);\s*$/, '');
const callbackCode = ts.transpileModule(`(${fn})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const row = (timestamp, title) => ({ timestamp, song_id: '1', title, difficulty: 'SPN', notes: '10', ex_score: '5', pgreat: '1', great: '1', miss_count: '0', clear_lamp: '1', dj_rate_pct: '50', dj_rank: 'A', judge_16: '1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1', settings_p1_11: '', settings_p2_11: '', battle_flag: '0', gauge_p1_w77: '', gauge_p2_w78: '', source: 'playdata', app_version: 'old', game_version: 'old' });
const csv = (...rows) => ['timestamp,song_id,title,difficulty,notes,ex_score,pgreat,great,miss_count,clear_lamp,dj_rate_pct,dj_rank,judge_16,settings_p1_11,settings_p2_11,battle_flag,gauge_p1_w77,gauge_p2_w78,source,app_version,game_version', ...rows.map(r => Object.values(r).map(v => `"${v}"`).join(','))].join('\n');
function setup({ readPlayCsv, gameStates = [true], profileResult = { ok: true }, plays = [row('pending', 'old')], dbrResult = 'saved' } = {}) {
  const events = []; const saved = []; const savedIds = [];
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
    onDbrSaved: id => events.push(['saved', id]),
    buildUploadPlays: result => result.ok && result.found !== false ? [row('current', 'fresh')] : [{ ...row('2026-01-01T00:00:00.000Z', ''), ...Object.fromEntries(['song_id','title','difficulty','notes','ex_score','pgreat','great','miss_count','clear_lamp','dj_rate_pct','dj_rank','judge_16','settings_p1_11','settings_p2_11','battle_flag','gauge_p1_w77','gauge_p2_w78','source'].map(k => [k, result.ok ? '-8' : '-11'])), app_version: result.appVersion ?? '', game_version: result.gameVersion ?? '' }],
    playsForGame: (p, recognized) => recognized ? p : undefined,
    uploadProfile: async input => { events.push('upload'); events.push({ uploadedPlays: input.plays }); return profileResult; },
    uploadAutomaticDbr: async (...args) => { events.push(['dbr', ...args]); }, addDiagLine() {}, writeLastUploadAt() {}, Date,
  });
  const wrappedCallback = async (...args) => callback(...args);
  return { callback: wrappedCallback, snapshot, events, saved, savedIds, readPlayCsv };
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

test('auto/initial DBR는 마지막 onSaved 인자로 저장 완료만 한 번 통지', async () => {
  for (const trigger of ['auto', 'initial']) {
    const h = setup();
    await h.callback(h.snapshot, trigger);
    const dbr = h.events.find(event => Array.isArray(event) && event[0] === 'dbr');
    assert.equal(typeof dbr[8], 'function');
    dbr[8](dbr[1]);
    assert.equal(dbr[8] instanceof Function, true);
    assert.deepEqual(h.events.filter(event => typeof event === 'string'), ['save', 'upload']);
    assert.equal(h.events.filter(event => Array.isArray(event) && event[0] === 'dbr').length, 1);
  }
});

test('auto/initial unchanged와 미확정 DBR 응답은 완료 통지를 발생시키지 않음', async () => {
  for (const dbrResult of ['unchanged', 'unknown', 'failure']) {
    const h = setup({ dbrResult });
    await h.callback(h.snapshot, 'auto');
    const dbr = h.events.find(event => Array.isArray(event) && event[0] === 'dbr');
    assert.equal(typeof dbr[8], 'function');
    assert.deepEqual(h.events.filter(event => typeof event === 'string'), ['save', 'upload']);
  }
});

const recentSource = read('./Recent.tsx');
const recentPlaysSource = recentSource.slice(recentSource.indexOf('export function RecentPlays('), recentSource.indexOf('\nexport default function Recent('));
const recentListHelpers = recentSource.slice(recentSource.indexOf('type RecentPlayListState'), recentSource.indexOf('\nfunction playOptionDisplay('));
const recentView = recentSource.slice(recentSource.indexOf('function recentPlayTime('), recentSource.indexOf('\nfunction detailSideHidden('));
const recentViewCode = ts.transpileModule(`${recentView}; ({ recentPlayTime })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const recentDetail = recentSource.slice(recentSource.indexOf('function detailSideHidden('), recentSource.indexOf('\nexport function RecentPlays('));
const lampStyleSource = read('./lampStyle.ts');
const lampStyleCode = ts.transpileModule(`${lampStyleSource.slice(lampStyleSource.indexOf('function lampStyle('), lampStyleSource.indexOf('\n// lampNum')).replace('export function lampStyle(', 'function lampStyle(')}; lampStyle`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const lampStyleFn = vm.runInNewContext(lampStyleCode, {});
const recentControllerSource = recentSource.slice(recentSource.indexOf('function laneCounterIndex('), recentSource.indexOf('\nfunction renderPlayDetail('));
const recentDisplaySource = recentSource.slice(recentSource.indexOf('function playLampLabel('), recentSource.indexOf('\n// diff'));
const recentDetailCode = ts.transpileModule(`${recentDisplaySource}; ${recentSource.slice(recentSource.indexOf('const DJ_CUT_NUM:'), recentSource.indexOf('\nfunction playLampLabel('))}; ${recentDetail}; ({ renderPlayDetail, PlayLaneController, PlayLaneDetail, playOptionInfo, playOptionDisplay, playSideActivity, displayLaneOrder, laneCounterIndex, laneEvaluation, laneKeyEvaluation, playLampLabel, playMissLabel })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
const placementSource = recentSource.slice(recentSource.indexOf('function placeLaneDetail('), recentSource.indexOf('\ntype LaneSelection'));
const placeLaneDetail = vm.runInNewContext(ts.transpileModule(placementSource + '; placeLaneDetail', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
const playChartLevelSource = recentSource.slice(recentSource.indexOf('function playChartLevel('), recentSource.indexOf('\nfunction playOptionInfo('));
const playChartLevelCode = ts.transpileModule(`${playChartLevelSource}; playChartLevel`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const getPlayChartLevel = vm.runInNewContext(playChartLevelCode, { norm: value => value.trim().toLowerCase(), ensureTextageMeta: async () => null });
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
function detailTree(detail, play = {}, level = 12) {
  let PlayLaneController;
  let PlayLaneDetail;
  const React = { createElement: (type, props, ...children) => type === PlayLaneController || type === PlayLaneDetail
    ? type(props)
    : ({ type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } }) };
  const module = vm.runInNewContext(recentDetailCode, { React, LAMP_NUM_TO_ABBR: { 0: 'NP', 1: 'F', 2: 'AC', 3: 'EC', 4: 'NC', 5: 'HC', 6: 'EX', 7: 'FC' }, lampStyle: lampStyleFn, djLevelFromScore: (ex, notes) => { const ratio = ex / (notes * 2); return ratio >= 8 / 9 ? 'AAA' : ratio >= 7 / 9 ? 'AA' : ratio >= 6 / 9 ? 'A' : ratio >= 5 / 9 ? 'B' : ratio >= 4 / 9 ? 'C' : ratio >= 3 / 9 ? 'D' : ratio >= 2 / 9 ? 'E' : 'F'; }, useState: initial => [initial, () => {}], useMemo: fn => fn(), useEffect: () => {}, createPortal: node => node, document: { addEventListener() {}, removeEventListener() {} }, window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200 } });
  PlayLaneController = module.PlayLaneController;
  PlayLaneDetail = module.PlayLaneDetail;
  const { renderPlayDetail } = module;
  return renderPlayDetail(detail, play, level);
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

test('play chart level selects unique SP and DP metadata by mode, difficulty, and normalized title', () => {
  const playChartLevel = getPlayChartLevel;
  const rows = [{ title: 'Song', charts: { SPH: { level: 10 }, DPH: { level: 11 } } }];
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'SPH' }, rows, null), 10);
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'DPH' }, rows, null), 11);
  assert.equal(playChartLevel({ title: 'Other', difficulty: 'SPH' }, rows, null), null);
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'SPH' }, rows.concat(rows), null), null);
  const textage = { songs: { one: { title: 'Song', levels: { SH: 10, DH: 11 } } } };
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'SPH' }, [], textage), 10);
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'DPH' }, [], textage), 11);
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'SPH' }, [], null), null);
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'SPH' }, [], { songs: { a: { title: 'Song', levels: { SH: 10 } }, b: { title: ' Song ', levels: { SH: 12 } } } }), null);
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'SPH' }, [], textage), 10);
  assert.equal(playChartLevel({ title: 'Song', difficulty: 'SPH' }, [{ title: 'Song', charts: {} }, rows[0]], textage), null);
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
  assert.match(recentPlaysSource, /renderedRows\.map\(/);
});

test('RecentPlays keys rows from full contents and preserves detail rendering', () => {
  const snippet = recentPlaysSource.slice(recentPlaysSource.indexOf('{renderedRows.map('));
  assert.match(recentSource, /function recentPlayRows\(rows: PlayCsvRow\[\], normalizedId: string\)/);
  assert.match(recentSource, /JSON\.stringify\(\[normalizedId, rowText, occurrence\]\)/);
  assert.match(snippet, /play\.title/);
  assert.match(snippet, /play\.difficulty/);
  assert.match(snippet, /play\.ex_score/);
  assert.match(snippet, /<details className="__uprofile_recentplays_item"/);
  assert.match(snippet, /open=\{listState\.openKeys\.has\(rowKey\)\}/);
  assert.match(snippet, /event\.currentTarget\.open/);
  assert.match(snippet, /current\.signature !== listState\.signature/);
  assert.match(snippet, /renderPlayDetail\(play\.detail, play,/);
  assert.match(recentCss, /\.\_\_uprofile_recentplays_row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:/s);
});

function createRecentPlaysHarness({ ensureTextageMeta = async () => null, playChartLevel = () => null } = {}) {
  const source = recentPlaysSource.replace('export function RecentPlays(', 'function RecentPlays(');
  const code = ts.transpileModule(`${recentListHelpers}; ${source}; ({ RecentPlays, recentPlayRows, initialRecentOpenKeys })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const slots = [];
  const effects = [];
  const listeners = [];
  let cursor = 0;
  let props;
  let api;
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const React = { createElement: (type, values, ...children) => ({ type, props: { ...(values ?? {}), children: children.length === 1 ? children[0] : children } }) };
  const context = {
    React,
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, update => { slots[index].value = typeof update === 'function' ? update(slots[index].value) : update; }];
    },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || !depsEqual(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: { current: initial } }; return slots[index].value; },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !depsEqual(slots[index].deps, deps)) {
        effects.push(() => {
          slots[index]?.cleanup?.();
          const cleanup = callback();
          slots[index] = { deps, cleanup };
        });
      }
    },
    isPlayErrorRow: play => play.error === true,
    subscribeRecentPlays(id, update) { const entry = { id, update, active: true }; listeners.push(entry); return () => { entry.active = false; }; },
    ensureTextageMeta,
    playChartLevel,
    recentPlayTime: () => 'time',
    renderPlayDetail: () => null,
    norm: value => value,
    DP_SLOTS: [],
  };
  const module = vm.runInNewContext(code, context);
  api = { ...module, listeners, render(nextProps = props) { props = nextProps; cursor = 0; const tree = module.RecentPlays(props); while (effects.length) effects.shift()(); return tree; } };
  api.state = () => slots[0].value;
  return api;
}

test('RecentPlays initially opens only newest row for 1, 2, 10, and 100 rows', () => {
  for (const count of [1, 2, 10, 100]) {
    const h = createRecentPlaysHarness();
    h.render({ iidxId: 'account' });
    h.listeners[0].update(Array.from({ length: count }, (_, index) => ({ timestamp: `t${index}`, value: index })), null);
    const tree = h.render();
    const details = flatten(tree).filter(node => node.type === 'details');
    assert.equal(details.length, count);
    assert.equal(details.filter(node => node.props.open).length, 1);
    if (count === 10) {
      assert.equal(details[0].props.open, true);
      assert.equal(details.slice(1).filter(node => node.props.open).length, 0);
    }
  }
});

test('RecentPlays closes on newest error, all errors, and empty rows; same signature preserves manual toggles', () => {
  for (const rows of [[{ timestamp: 'normal' }, { timestamp: 'error', error: true }], [{ timestamp: 'error', error: true }], []]) {
    const h = createRecentPlaysHarness(); h.render({ iidxId: 'account' }); h.listeners[0].update(rows, null);
    assert.equal(flatten(h.render()).filter(node => node.type === 'details' && node.props.open).length, 0);
  }
  const h = createRecentPlaysHarness(); h.render({ iidxId: 'account' });
  const rows = [{ timestamp: 'a' }, { timestamp: 'b' }, { timestamp: 'c' }];
  h.listeners[0].update(rows, null);
  let details = flatten(h.render()).filter(node => node.type === 'details');
  details[1].props.onToggle({ currentTarget: { open: true } });
  details = flatten(h.render()).filter(node => node.type === 'details');
  details[2].props.onToggle({ currentTarget: { open: true } });
  details = flatten(h.render()).filter(node => node.type === 'details');
  details[0].props.onToggle({ currentTarget: { open: false } });
  h.listeners[0].update(rows.map(row => ({ ...row })), null);
  details = flatten(h.render()).filter(node => node.type === 'details');
  assert.deepEqual(details.map(node => node.props.open), [false, true, true]);
});

test('RecentPlays resets on changed content and makes row keys collision safe', () => {
  const h = createRecentPlaysHarness(); h.render({ iidxId: 'account' });
  let rows = Array.from({ length: 100 }, (_, index) => ({ timestamp: 'same', value: index }));
  h.listeners[0].update(rows, null);
  let tree = h.render();
  const before = flatten(tree).filter(node => node.type === 'details').map(node => node.props.key);
  h.listeners[0].update([...rows, { timestamp: 'new', value: 100 }], null);
  tree = h.render();
  let details = flatten(tree).filter(node => node.type === 'details');
  assert.equal(details.filter(node => node.props.open).length, 1);
  assert.equal(details[0].props.open, true);
  assert.ok(details.slice(1).some(node => before.includes(node.props.key)));
  rows = [{ timestamp: 't', value: 1 }, { timestamp: 't', value: 2 }, { timestamp: 't', value: 1 }, { timestamp: 't', error: true }];
  h.listeners[0].update(rows, null);
  details = flatten(h.render()).filter(node => node.type === 'details');
  assert.equal(new Set(details.map(node => node.props.key)).size, 3);
  assert.equal(details.filter(node => node.props.open).length, 0);
});

test('RecentPlays ignores stale toggles and prior account callbacks after account switch', () => {
  const h = createRecentPlaysHarness(); h.render({ iidxId: 'first' });
  const oldCallback = h.listeners[0].update;
  oldCallback([{ timestamp: 'old' }], null);
  const oldDetails = flatten(h.render()).filter(node => node.type === 'details');
  h.render({ iidxId: 'second' });
  oldCallback([{ timestamp: 'late' }], null);
  h.listeners[1].update([{ timestamp: 'new' }], null);
  const details = flatten(h.render()).filter(node => node.type === 'details');
  oldDetails[0].props.onToggle({ currentTarget: { open: true } });
  assert.equal(flatten(h.render()).filter(node => node.type === 'details')[0].props.open, true);
  assert.equal(details[0].props.key, JSON.stringify(['second', JSON.stringify({ timestamp: 'new' }), 0]));
});

test('RecentPlays ignores prior signature toggles and refreshes details when Textage resolves', async () => {
  let resolveTextage;
  const meta = { songs: {} };
  const levels = [];
  const h = createRecentPlaysHarness({ ensureTextageMeta: () => new Promise(resolve => { resolveTextage = resolve; }), playChartLevel: (_play, _rows, textage) => { levels.push(textage); return textage ? 12 : null; } });
  h.render({ iidxId: 'account' });
  h.listeners[0].update([{ timestamp: 'old', detail: null }], null);
  const oldToggle = flatten(h.render()).find(node => node.type === 'details').props.onToggle;
  h.listeners[0].update([{ timestamp: 'new', detail: null }], null);
  const expectedOpenKeys = h.state().openKeys;
  oldToggle({ currentTarget: { open: true } });
  let details = flatten(h.render()).filter(node => node.type === 'details');
  assert.equal(details[0].props.open, true);
  assert.equal(h.state().openKeys, expectedOpenKeys);
  resolveTextage(meta);
  await Promise.resolve();
  h.render();
  assert.equal(levels[levels.length - 1], meta);
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
  assert.doesNotMatch(recentDetail, /<h4>판정 상세<\/h4>/);
  for (const heading of ['랜덤 레인 패턴', '레인별 평가']) assert.ok(recentDetail.includes(heading));
  for (const className of ['__uprofile_play_sections', '__uprofile_play_head', '__uprofile_play_pattern', '__uprofile_play_rating', '__uprofile_play_tiles', '__uprofile_play_inactive']) assert.ok(recentSource.includes(className));
  assert.doesNotMatch(recentDetail, /스코어 정보|__uprofile_play_score/);
  assert.match(recentDetail, /if \(!detail\) return/);
  assert.doesNotMatch(recentDetail, /play\.detail \? 0|detail \? 0/);
});

test('RecentPlays summary has five cells and detail headers and display values match for both branches', () => {
  const summarySource = recentSource.slice(recentSource.indexOf('export function RecentPlays('), recentSource.indexOf('\nexport default function Recent('));
  const transpiled = ts.transpileModule(`${recentListHelpers}; ${summarySource.replace('export function RecentPlays(', 'function RecentPlays(')}; RecentPlays`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const plays = [
    { timestamp: 't1', song_id: 'game-42-dp', title: '未完成ノ蒸氣驅動乙女', difficulty: 'DPH', ex_score: '1684', notes: '2000', settings_p1_11: '0 0 0 0 0 0', settings_p2_11: '0 0 0 0 0 0', battle_flag: '0' },
    { timestamp: 't2', song_id: 'game-42-sp', title: '未完成ノ蒸氣驅動乙女', difficulty: 'SPA', ex_score: '1684', notes: '2000', settings_p1_11: '0 0 0 0 0 0', settings_p2_11: '0 0 0 0 0 0', battle_flag: '0' },
  ];
  const actualTextage = { songs: { gameSong42: { title: '未完成ノ蒸氣驅動乙女', levels: { DH: 11, SA: 12 } } } };
  const h = createRecentPlaysHarness();
  h.render({ iidxId: 'id' });
  h.listeners[0].update(plays, null);
  const tree = h.render();
  const summary = flatten(tree).find(node => node.type === 'summary');
  assert.equal(summary.props.children.length, 5);
  assert.deepEqual(summary.props.children.map(node => node.props.className), [undefined, undefined, undefined, undefined, '__uprofile_recentplays_chev']);
  assert.doesNotMatch(JSON.stringify(summary), /AA-0001|50%|12 ·/);

  const levels = plays.map(play => getPlayChartLevel(play, [], actualTextage));
  assert.deepEqual(levels, [11, 12]);
  assert.notEqual(plays[0].song_id, 'gameSong42');
  assert.notEqual(plays[1].song_id, 'gameSong42');
  const details = [null, { complete: true, p1: {}, p2: {} }];
  for (const play of plays) for (const detail of details) {
    const nodes = flatten(detailTree(detail, play, getPlayChartLevel(play, [], actualTextage)));
    const header = nodes.find(node => node.props?.className?.split(' ').includes('__uprofile_play_head'));
    const head = header.props.children;
    assert.equal(head.length, 2);
    assert.deepEqual(head.map(node => node.props.className), ['__uprofile_play_head_level', '__uprofile_play_head_options']);
    const expected = getPlayChartLevel(play, [], actualTextage);
    assert.equal(head[0].props.children, expected);
    if (detail === null) assert.equal(JSON.stringify(nodes).includes(play.title), false);
    assert.ok(head[1].props.children);
  }
  const absent = plays.map(play => getPlayChartLevel(play, [], null));
  assert.deepEqual(absent, [null, null]);
  for (const [play, level] of plays.map((play, index) => [play, levels[index]])) {
    const loadingHead = flatten(detailTree(null, play, null)).find(node => node.props?.className?.split(' ').includes('__uprofile_play_head'));
    assert.equal(loadingHead.props.children[0].props.children, '—');
    const resolved = getPlayChartLevel(play, [], actualTextage);
    assert.equal(resolved, level);
    const detailTreeWithLevel = flatten(detailTree(null, play, resolved));
    assert.equal(detailTreeWithLevel.find(node => node.props?.className?.split(' ').includes('__uprofile_play_head')).props.children[0].props.children, level);
  }
  const duplicateMeta = { songs: { a: { title: plays[0].title, levels: { DH: 11 } }, b: { title: ` ${plays[0].title} `, levels: { DH: 13 } } } };
  assert.equal(getPlayChartLevel(plays[0], [], duplicateMeta), null);
  assert.equal(getPlayChartLevel(plays[0], [], { songs: { only: { title: plays[0].title, levels: { DH: 0 } } } }), 0);
  assert.equal(getPlayChartLevel(plays[1], [], { songs: { only: { title: plays[1].title, levels: { DH: 11 } } } }), null);

  const play = { title: 'Song', clear_lamp: '1', miss_count: '-1', ex_score: '0', dj_rate_pct: '0', dj_rank: 'A', notes: '10', settings_p1_11: '0 0 0 0 0 0 0 0 0 0 0', settings_p2_11: '0 0 0 0 0 0 0 0 0 0 0', difficulty: 'DPH', judge_16: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' };
  for (const detail of [null, { complete: true, p1: {}, p2: {} }]) {
    const nodes = flatten(detailTree(detail, play));
    const header = nodes.find(node => node.props?.className?.split(' ').includes('__uprofile_play_head'));
    const parts = header.props.children;
    assert.deepEqual(parts.map(node => node.props.className), ['__uprofile_play_head_level', '__uprofile_play_head_options']);
    assert.deepEqual(parts.map(node => node.props.children), [12, 'OFF / OFF']);
    assert.equal(nodes.some(node => ['__uprofile_play_head_title', '__uprofile_play_head_chart'].some(className => node.props?.className?.split(' ').includes(className))), false);
    if (!detail) assert.equal(JSON.stringify(nodes).includes('Song'), false);
    const summaryNode = nodes.find(node => node.props?.className?.split(' ').includes('__uprofile_playdetail_summary'));
    const summaryText = JSON.stringify(summaryNode);
    for (const value of ['램프', 'EX 스코어', 'Rate', 'DJ LEVEL', 'BP', 'FAILED', '0%', 'A', '—']) assert.ok(summaryText.includes(value));
    const entries = summaryNode.props.children.map(entry => {
      const descendants = flatten(entry);
      return [descendants.find(node => node.type === 'span' && typeof node.props.children === 'string')?.props.children, descendants.find(node => node.type === 'b')?.props.children];
    });
    assert.deepEqual(entries, [['램프', 'FAILED'], ['EX 스코어', '0'], ['Rate', '0%'], ['DJ LEVEL', 'A'], ['BP', '—']]);
    assert.doesNotMatch(summaryText, /콤보 브레이크|P1\+P2 합산/);
    assert.equal(nodes.filter(node => node.type === 'h4' && node.props.children === '판정 상세').length, 0);
    for (const heading of ['랜덤 레인 패턴', '레인별 평가']) assert.ok(nodes.some(node => node.type === 'h4' && node.props.children === heading));
    if (!detail) assert.ok(JSON.stringify(nodes).includes('상세 기록 없음'));
    else assert.ok(JSON.stringify(nodes).includes('FAST/SLOW 검증 불일치') === false);
    if (detail) assert.ok(nodes.some(node => node.props?.className?.split(' ').includes('k-cb')));
  }
  const judgmentRows = flatten(detailTree({ complete: true, p1: { lanes: Array.from({ length: 8 }, () => [1, 2, 3, 4, 5, 6]), fs: { fast_great: 7, fast_good: 8, slow_great: 9, slow_good: 10 } }, p2: { lanes: Array.from({ length: 8 }, () => [1, 1, 1, 1, 1, 1]), fs: { fast_great: 2, fast_good: 3, slow_great: 4, slow_good: 5 } } }, { judge_16: '0 0 0 0 0 0 0 0 0 0 2 3 0 0 0 0' })).filter(node => node.props?.className?.split(' ').includes('__uprofile_playdetail_barrow'));
  assert.deepEqual(judgmentRows.map(node => [node.props.className.split(' ').at(-1), node.props.children[0].props.children.at(-1), node.props.children[1].props.children]), [
    ['k-good', 'GOOD', '11'], ['k-great', 'GREAT', '9'], ['k-pg', 'PERFECT GREAT', '16'], ['k-great', 'GREAT', '13'], ['k-good', 'GOOD', '15'],
    ['k-bad', 'BAD', '40'], ['k-poor', 'POOR', '48'], ['k-empty', '空POOR', '56'], ['k-cb', 'COMBO BREAK', '5'],
  ]);
  const blankSummaryNodes = flatten(detailTree(null, { ...play, clear_lamp: '', miss_count: '', ex_score: '', dj_rate_pct: '', dj_rank: '' }));
  const blankSummary = blankSummaryNodes.find(node => node.props?.className?.split(' ').includes('__uprofile_playdetail_summary'));
  assert.deepEqual(blankSummary.props.children.map(entry => flatten(entry).find(node => node.type === 'b')?.props.children), ['—', '—', '—', '—', '—']);
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
  assert.doesNotMatch(recentDetail, /FAST\/SLOW 미확정|fs_unresolved/);
  assert.match(recentDetail, /!hasFs && <small className="__uprofile_playdetail_foot">FAST\/SLOW 기록 없음/);
  assert.doesNotMatch(recentDetail, /P1\+P2 합산/);
  assert.match(recentDetail, /!detail\.complete && <span className="__uprofile_playdetail_badge">부분 기록/);
  assert.match(recentDetail, /side\.fs_ok === false/);
  assert.match(recentDetail, /FAST\/SLOW 검증 불일치/);
  assert.match(recentDetail, /side\?\.lanes_ok === false/);
  assert.match(recentDetail, /레인 검증 불일치/);
  assert.match(recentDetail, /cells\.join\(' · '\).*evaluation\?\.rank/);
  assert.match(recentDetail, /return <>\{text\}<\/>;/);
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
  assert.match(recentDetail, /return <>\{text\}<\/>;/);

  assert.match(rendered, /__uprofile_playdetail_fill/);
  assert.doesNotMatch(rendered, /FAST\/SLOW 미확정/);

});

test('Recent detail shows combined combo break once for both visible sides', () => {
  const lanes = Array.from({ length: 8 }, (_, i) => [i === 0 ? 1 : 0, 0, 0, 0, 0, 0]);
  const detail = { complete: true, p1: { lanes, lane_fs: null, fs: null, lane_fs_unresolved: 0 }, p2: { lanes, lane_fs: null, fs: null, lane_fs_unresolved: 0 } };
  const nodes = flatten(detailTree(detail, { judge_16: '10 20 3 1 2 11 21 4 0 1 3 4 30 31 32 33' }));
  const comboBreak = nodes.find(node => node.props?.className?.split(' ').includes('k-cb'));
  assert.ok(comboBreak);
  assert.ok(JSON.stringify(comboBreak.props.children).includes('7'));
  const summary = nodes.find(node => node.props?.className?.split(' ').includes('__uprofile_playdetail_summary'));
  assert.doesNotMatch(JSON.stringify(summary?.props.children), /COMBO BREAK/);
});

test('Recent detail shows only P1 combo break for hidden P2', () => {
  const lanes = Array.from({ length: 8 }, (_, i) => [i === 0 ? 1 : 0, 0, 0, 0, 0, 0]);
  const detail = { complete: true, p1: { lanes, lane_fs: null, fs: null, lane_fs_unresolved: 0 }, p2: { lanes: Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]), lane_fs: null, fs: null, lane_fs_unresolved: 0 } };
  const nodes = flatten(detailTree(detail, { judge_16: '10 20 3 1 2 11 21 4 0 1 3 4 30 31 32 33', difficulty: 'SPN' }));
  const comboBreak = nodes.find(node => node.props?.className?.split(' ').includes('k-cb'));
  assert.ok(comboBreak);
  assert.ok(JSON.stringify(comboBreak.props.children).includes('3'));
  const summary = nodes.find(node => node.props?.className?.split(' ').includes('__uprofile_playdetail_summary'));
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
  assert.doesNotMatch(recentCss, /\.__uprofile_play_head_(?:title|chart)\s*\{/);
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
  assert.match(recentCss, /\.\_\_uprofile_play_panel\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*gap:\s*calc\(16 \* var\(--rating-u\)\);[^}]*width:\s*max-content;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_controller\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*calc\(8 \* var\(--rating-u\)\);[^}]*width:\s*max-content;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_keyboard\s*\{[^}]*position:\s*relative;[^}]*width:\s*calc\(124 \* var\(--rating-u\)\);[^}]*height:\s*calc\(96 \* var\(--rating-u\)\);/s);
  for (const [key, left] of [[1, 0], [3, 32], [5, 64], [7, 96], [2, 16], [4, 48], [6, 80]]) {
    assert.match(recentCss, new RegExp(`\\.__uprofile_play_unit\\[data-key="${key}"\\]\\s*\\{\\s*left:\\s*calc\\(${left} \\* var\\(--rating-u\\)\\);`));
  }
  assert.match(recentCss, /\.\_\_uprofile_play_unit_white\s*\{\s*top:\s*calc\(40 \* var\(--rating-u\)\);/);
  assert.match(recentCss, /\.\_\_uprofile_play_unit_black\s*\{\s*top:\s*0;/);
  assert.match(recentCss, /\.\_\_uprofile_play_unit_scratch\s*\{[^}]*width:\s*calc\(96 \* var\(--rating-u\)\);[^}]*height:\s*calc\(96 \* var\(--rating-u\)\);[^}]*border-radius:\s*50%;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_controller button\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;/s);
  assert.doesNotMatch(recentCss, /__uprofile_play_(?:controller|unit|key)[^{}]*nth-of-type/);
  assert.doesNotMatch(recentCss, /__uprofile_play_(?:controller|unit|key)[^{}]*transform:\s*translate/);
  for (const [variant, declarations] of [
    ['scratch', 'border:\\s*calc\\(1 \\* var\\(--rating-u\\)\\) solid #ff4b4b;[^}]*background:\\s*#30151a;[^}]*color:\\s*#fff'],
    ['black', 'border:\\s*calc\\(1 \\* var\\(--rating-u\\)\\) solid #3f8cff;[^}]*background:\\s*#133263;[^}]*color:\\s*#fff'],
    ['white', 'border:\\s*calc\\(1 \\* var\\(--rating-u\\)\\) solid #cbd5e1;[^}]*background:\\s*#f8fafc;[^}]*color:\\s*#172033'],
  ]) assert.match(recentCss, new RegExp(`\\.__uprofile_play_rank_${variant}\\s*\\{[^}]*${declarations}`, 's'));
  assert.match(recentCss, /\.__uprofile_play_unit_scratch\s*\{[^}]*position:\s*relative;[^}]*width:\s*calc\(96 \* var\(--rating-u\)\);/s);
  assert.match(recentCss, /\.\_\_uprofile_play_rank_inactive\s*\{[^}]*background:\s*#4b5563;[^}]*border-color:\s*#6b7280;[^}]*color:\s*transparent;[^}]*opacity:\s*1;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_controller \.\_\_uprofile_play_inactive\s*\{[^}]*color:\s*var\(--text-secondary\);/s);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_row\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*align-items:\s*center;[^}]*gap:\s*calc\(4 \* var\(--u\)\);[^}]*flex:\s*none;/s);
  assert.doesNotMatch(recentCss, /\.\_\_uprofile_play_pattern_row \+ \.\_\_uprofile_play_pattern_row\s*\{/);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_tiles\s*\{[^}]*display:\s*flex;[^}]*gap:\s*calc\(3 \* var\(--u\)\);/s);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_tile\s*\{[^}]*width:\s*calc\(30 \* var\(--u\)\);[^}]*height:\s*calc\(42 \* var\(--u\)\);[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*border:\s*calc\(1 \* var\(--u\)\) solid #555;/s);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_tile_white\s*\{\s*background:\s*#f3f3f3;/);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_tile_black\s*\{\s*background:\s*#181a1f;/);
  assert.match(recentCss, /\.\_\_uprofile_play_pattern_digit\s*\{[^}]*color:\s*#ff8a00;[^}]*font-weight:\s*700;[^}]*font-size:\s*calc\(18 \* var\(--u\)\);/s);
  assert.match(recentCss, /\.\_\_uprofile_play_inactive\s*\{\s*color:\s*var\(--text-secondary\);\s*opacity:\s*\.82;/);
  assert.match(recentCss, /\.\_\_uprofile_play_controller button:focus-visible\s*\{\s*outline:\s*2px solid var\(--text-primary\);\s*outline-offset:\s*2px;/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-pg \.\_\_uprofile_playdetail_fill \{ background: #62e2c4; \}/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-great \.\_\_uprofile_playdetail_fill \{ background: #ffe63c; \}/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-bad \.\_\_uprofile_playdetail_fill \{ background: #ff6a3a; \}/);
  assert.match(recentCss, /\.\_\_uprofile_playdetail_barrow\.k-poor \.\_\_uprofile_playdetail_fill \{ background: #ff4a34; \}/);
  assert.match(recentCss, /width:\s*max-content;[^}]*overflow:\s*auto;[^}]*padding:\s*8px;/s);
  assert.match(recentCss, /\.__uprofile_play_unit\s*\{[^}]*position:\s*absolute;[^}]*cursor:\s*pointer;/);
  assert.doesNotMatch(recentCss, /__uprofile_playdetail_(?:toggle|lanes|tablebox|lanetable)|\[hidden\]/);
});

test('lane detail opens from pointer and focus and keeps touch selection until dismissed', () => {
  assert.match(recentDetail, /onPointerOver=.*event\.pointerType !== 'touch'/);
  assert.match(recentDetail, /onPointerDown=.*event\.preventDefault\(\).*if \(!active\)/);
  assert.match(recentDetail, /onPointerOut=.*selection\?\.touch/);
  assert.match(recentDetail, /onFocus=\{side != null \? \(event\) => open\(event\.currentTarget, false\)/);
});

test('lane detail is globally singular and external pointer and focus events close it', () => {
  assert.match(recentPlaysSource, /const \[selection, setSelection\] = useState<LaneSelection \| null>/);
  assert.match(recentPlaysSource, /document\.addEventListener\('pointerdown', outside\)/);
  assert.match(recentPlaysSource, /document\.addEventListener\('focusin', focusOutside\)/);
  assert.match(recentPlaysSource, /!target\.closest\('\.__uprofile_play_unit'\) && !target\.closest\('\.__uprofile_play_keydetail'\)/);
});

test('lane detail focus change closes outside, button name identifies side and detail link uses shown ID', () => {
  assert.match(recentDetail, /const labelText = `\$\{player\} \$\{label === 'SCRATCH' \? '스크래치' : `건반 \$\{label\}`\}`/);
  assert.match(recentDetail, /aria-describedby=\{side != null && active \? id : undefined\}/);
  assert.doesNotMatch(recentDetail, /aria-controls/);
  assert.match(recentPlaysSource, /document\.addEventListener\('focusin', focusOutside\)/);
});

test('lane detail Escape closes and restores trigger focus', () => {
  assert.match(recentPlaysSource, /event\.key === 'Escape'.*selection\.button\.focus\(\)/);
});

test('lane detail flips above and clamps horizontally with viewport bounded internal scrolling', () => {
  assert.match(recentDetail, /const width = Math\.min\(box\.width, viewportW - gap \* 2\)/);
  assert.match(recentDetail, /const height = Math\.min\(box\.height, viewportH - gap \* 2\)/);
  assert.match(recentDetail, /below >= height \|\| below >= anchor\.top - gap/);
  assert.match(recentPlaysSource, /detail\.getBoundingClientRect\(\)/);
  assert.deepEqual({ ...placeLaneDetail({ left: 10, top: 10, bottom: 20 }, { width: 180, height: 140 }, 360, 240) }, { left: 10, top: 28 });
  assert.deepEqual({ ...placeLaneDetail({ left: 1150, top: 700, bottom: 720 }, { width: 700, height: 500 }, 1200, 900) }, { left: 492, top: 192 });
  assert.deepEqual({ ...placeLaneDetail({ left: 0, top: 5, bottom: 10 }, { width: 700, height: 224 }, 360, 240) }, { left: 8, top: 8 });
});

test('lane detail closes on collapse, account change, scroll and resize, and cleans up document and window events', () => {
  assert.match(recentPlaysSource, /setSelection\(null\); }, \[normalizedId, listState\.signature\]/);
  assert.match(recentPlaysSource, /window\.addEventListener\('scroll', close, true\)/);
  assert.match(recentPlaysSource, /window\.addEventListener\('resize', close\)/);
  assert.match(recentPlaysSource, /document\.removeEventListener\('keydown', escape\)/);
  assert.match(recentPlaysSource, /document\.removeEventListener\('pointerdown', outside\)/);
  assert.match(recentPlaysSource, /window\.removeEventListener\('scroll', close, true\)/);
  assert.match(recentPlaysSource, /window\.removeEventListener\('resize', close\)/);
  assert.match(recentPlaysSource, /<details className="__uprofile_recentplays_item"/);
});

test('Recent option labels cover all values, P2 SP settings, and battle flip ordering', () => {
  const { playOptionInfo, playOptionDisplay } = recentCalculations();
  const play = { settings_p1_11: '0 0 0 0 0 5 0 0 0 0 0', settings_p2_11: '6 0 0 0 0 0 0 0 0 0 0', battle_flag: '0', difficulty: 'SPN' };
  assert.equal(playOptionInfo(play), 'OFF / SYMMETRY RANDOM');
  assert.equal(playOptionInfo({ ...play, settings_p1_11: '0 0 1 1 0 2 0 0 0 0 0', battle_flag: '1' }), 'BATTLE, FLIP, OFF / R-RAN');
  assert.equal(playOptionInfo({ ...play, settings_p1_11: '0 0 0 0 0 6 0 0 0 0 0', settings_p2_11: '1 0 0 0 0 0 0 0 0 0 0' }), 'OFF / RAN');
  for (let value = 0; value <= 6; value++) assert.ok(playOptionInfo({ ...play, settings_p1_11: `${value} 0 0 0 0 0 0 0 0 0 0` }).length > 0);
  assert.ok(playOptionInfo({ ...play, settings_p1_11: '7 0 0 0 0 0 0 0 0 0 0' }).includes('—'));
  const labels = ['OFF', 'RANDOM', 'R-RANDOM', 'S-RANDOM', 'MIRROR', 'SYNCHRONIZE RANDOM', 'SYMMETRY RANDOM'];
  const p1 = judge_16 => ({ ...play, judge_16, settings_p1_11: '1 0 0 0 0 0 0 0 0 0 0', settings_p2_11: '4 0 0 0 0 0 0 0 0 0 0' });
  const p2Judge = '0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0';
  assert.equal(playOptionDisplay(p1('1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0')), 'RANDOM');
  assert.equal(playOptionDisplay({ ...p1(p2Judge), settings_p2_11: '4 0 0 0 0 0 0 0 0 0 0' }), 'MIRROR');
  for (let value = 0; value <= 6; value++) assert.equal(playOptionDisplay({ ...p1('1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'), settings_p1_11: `${value} 0 0 0 0 0 0 0 0 0 0` }), labels[value]);
  for (const raw of [undefined, '', 'bad', '7 0 0 0 0 0 0 0 0 0 0']) assert.equal(playOptionDisplay({ ...p1('1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'), settings_p1_11: raw }), '—');
  assert.equal(playOptionDisplay({ ...p1('1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'), settings_p1_11: '3 0 0 0 0 0 0 0 0 0 0', lane_order_p1: '2035641' }), 'S-RANDOM');
  assert.equal(playOptionDisplay({ ...play, difficulty: 'DPN', settings_p1_11: '1 0 0 0 0 1 0 0 0 0 0', settings_p2_11: '0 0 0 0 0 1 0 0 0 0 0' }), 'RAN / RAN');
  assert.equal(playOptionDisplay({ ...play, battle_flag: '1', settings_p1_11: '1 0 0 1 0 1 0 0 0 0 0' }), 'BATTLE, FLIP, RAN / RAN');
  assert.equal(playOptionDisplay(p1('0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0')), 'RAN / MIR');
  assert.equal(playOptionDisplay(p1('1 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0')), 'RAN / MIR');
});

test('Recent detail omits unresolved FAST/SLOW notice for present counts and retains missing-data guidance', () => {
  const lanes = Array.from({ length: 8 }, () => [1, 1, 0, 0, 0, 0]);
  const fs = { fast_great: 1, fast_good: 1, slow_great: 0, slow_good: 0 };
  for (const unresolved of [0, 4, undefined]) {
    const side = { lanes, fs, ...(unresolved === undefined ? {} : { fs_unresolved: unresolved }) };
    const nodes = flatten(detailTree({ complete: true, p1: side, p2: { ...side } }));
    const rendered = JSON.stringify(nodes);
    assert.doesNotMatch(rendered, /FAST\/SLOW 미확정/);
    assert.doesNotMatch(rendered, /짝짓지 못한 수/);
  }
  const noFs = flatten(detailTree({ complete: true, p1: { lanes, fs: null }, p2: { lanes, fs: null } }));
  assert.ok(JSON.stringify(noFs).includes('FAST/SLOW 기록 없음 — 플레이 시작부터 관찰하지 못한 판'));
});

test('Recent detail omits unresolved FAST/SLOW notice for present counts and retains missing-data guidance', () => {
  const lanes = Array.from({ length: 8 }, () => [1, 1, 0, 0, 0, 0]);
  const fs = { fast_great: 1, fast_good: 1, slow_great: 0, slow_good: 0 };
  for (const unresolved of [0, 4, undefined]) {
    const side = { lanes, fs, ...(unresolved === undefined ? {} : { fs_unresolved: unresolved }) };
    const nodes = flatten(detailTree({ complete: true, p1: side, p2: { ...side } }));
    const rendered = JSON.stringify(nodes);
    assert.doesNotMatch(rendered, /FAST\/SLOW 미확정/);
    assert.doesNotMatch(rendered, /짝짓지 못한 수/);
  }
  const noFs = flatten(detailTree({ complete: true, p1: { lanes, fs: null }, p2: { lanes, fs: null } }));
  assert.ok(JSON.stringify(noFs).includes('FAST/SLOW 기록 없음 — 플레이 시작부터 관찰하지 못한 판'));
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

test('Recent lane pattern arranges active and inactive rows for SP, DP, battle, and missing side data', () => {
  const exact = (node, name) => node?.props?.className?.split(' ').includes(name) === true;
  const textContent = value => Array.isArray(value) ? value.map(textContent).join('') : value && typeof value === 'object' ? textContent(value.props?.children) : value ?? '';
  const inspect = (detail, play) => {
    const nodes = flatten(detailTree(detail, play));
    const layouts = nodes.filter(node => exact(node, '__uprofile_play_lane_layout'));
    assert.equal(layouts.length, 1);
    assert.deepEqual(Array.from(layouts[0].props.children, node => node.props.className.split(' ').find(token => ['__uprofile_play_pattern', '__uprofile_play_rating'].includes(token))), ['__uprofile_play_pattern', '__uprofile_play_rating']);
    const groups = nodes.filter(node => exact(node, '__uprofile_play_pattern_groups'));
    assert.equal(groups.length, 1);
    const rows = groups[0].props.children;
    assert.deepEqual(Array.from(rows, row => textContent(row.props.children[1])), ['PLAYER 1 LANE', 'PLAYER 2 LANE']);
    for (const [index, label] of ['PLAYER 1 LANE', 'PLAYER 2 LANE'].entries()) {
      const row = rows[index];
      assert.ok(exact(row, '__uprofile_play_pattern_row'));
      const [tileContainer, rowLabel] = row.props.children;
      assert.ok(exact(tileContainer, '__uprofile_play_pattern_tiles'));
      assert.ok(exact(rowLabel, '__uprofile_play_pattern_label'));
      assert.equal(textContent(rowLabel), label);
      assert.equal(row.props.children.length, 2);
      const tiles = tileContainer.props.children;
      if (Array.isArray(tiles)) {
        assert.equal(tiles.length, 7);
        assert.ok(tiles.every(tile => exact(tile, '__uprofile_play_pattern_tile')));
      }
    }
    assert.equal(nodes.filter(node => exact(node, '__uprofile_play_pattern_label')).length, 2);
    assert.equal(nodes.filter(node => node.type === 'span' && node.props?.children === 'PLAYER 1 LANE' && exact(node, '__uprofile_play_pattern_tiles')).length, 0);
    return { nodes, rows };
  };
  const activeSp = { difficulty: 'SPN', battle_flag: '0', judge_16: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0', lane_order_p1: '3456120', lane_order_p2: undefined, settings_p1_11: '0 0 0 0 0 0 0 0 0 0 0' };
  for (const detail of [null, { complete: true, p1: {}, p2: {} }]) {
    const { rows } = inspect(detail, activeSp);
    const p1 = rows[0].props.children[0].props.children;
    const p2 = rows[1].props.children[0].props.children;
    assert.deepEqual(Array.from(p1, tile => tile.props.children.props.children), ['4', '5', '6', '7', '2', '3', '1']);
    assert.deepEqual(Array.from(p1, tile => exact(tile, '__uprofile_play_pattern_tile_white') ? 'white' : 'black'), ['black', 'white', 'black', 'white', 'black', 'white', 'white']);
    assert.deepEqual(Array.from(p2, tile => tile.props.children.props.children), ['', '', '', '', '', '', '']);
    assert.ok(exact(rows[1], '__uprofile_play_pattern_inactive'));
    assert.equal(p2.length, 7);
  }
  for (const extra of [{ lane_order_p2: '0123456' }, { lane_order_p2: '0123456', settings_p2_11: '3 0 0 0 0 0 0 0 0 0 0' }]) {
    const { rows } = inspect(null, { ...activeSp, ...extra });
    assert.deepEqual(Array.from(rows[1].props.children[0].props.children, tile => tile.props.children.props.children), ['', '', '', '', '', '', '']);
  }
  const p2Sp = { ...activeSp, judge_16: '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0', lane_order_p1: '0123456', lane_order_p2: '6543210' };
  for (const detail of [null, { complete: true, p1: {}, p2: {} }]) {
    const { rows } = inspect(detail, p2Sp);
    assert.deepEqual(Array.from(rows[0].props.children[0].props.children, tile => tile.props.children.props.children), ['', '', '', '', '', '', '']);
    assert.deepEqual(Array.from(rows[1].props.children[0].props.children, tile => tile.props.children.props.children), ['7', '6', '5', '4', '3', '2', '1']);
    assert.ok(exact(rows[0], '__uprofile_play_pattern_inactive'));
  }
  for (const play of [
    { ...activeSp, difficulty: 'DPN', lane_order_p2: '0123456', settings_p2_11: '0 0 0 0 0 0 0 0 0 0 0' },
    { ...activeSp, difficulty: 'SPN', battle_flag: '1', lane_order_p2: '0123456', settings_p2_11: '0 0 0 0 0 0 0 0 0 0 0' },
  ]) {
    const { rows } = inspect({ complete: true, p1: {}, p2: {} }, play);
    assert.deepEqual(Array.from(rows, row => Array.from(row.props.children[0].props.children, tile => tile.props.children.props.children)), [
      ['4', '5', '6', '7', '2', '3', '1'], ['1', '2', '3', '4', '5', '6', '7'],
    ]);
  }
  const ascending = inspect({ complete: true, p1: {}, p2: {} }, { ...activeSp, lane_order_p1: '0123456' }).rows[0].props.children[0].props.children;
  assert.deepEqual(Array.from(ascending, tile => exact(tile, '__uprofile_play_pattern_tile_white') ? 'white' : 'black'), ['white', 'black', 'white', 'black', 'white', 'black', 'white']);
  for (const play of [
    { ...activeSp, settings_p1_11: '3 0 0 0 0 0 0 0 0 0 0' },
    { ...activeSp, lane_order_p1: '0035641' },
    { ...activeSp, judge_16: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' },
  ]) {
    const { rows } = inspect(null, play);
    assert.equal(rows[0].props.children[0].props.children, '—');
  }
  const cssRule = selector => recentCss.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  const declaration = (body, property) => body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim();
  assert.equal(declaration(cssRule('\\.__uprofile_play_pattern'), 'container'), 'infplaypattern / inline-size');
  assert.equal(declaration(cssRule('\\.__uprofile_play_rating'), 'container'), 'infplayrating / inline-size');
  assert.equal(declaration(cssRule('\\.__uprofile_play_rating_scale'), '--rating-u'), 'clamp(.5px, 0.185185cqi, 1px)');
  assert.equal(declaration(cssRule('\\.__uprofile_play_rating_scale'), '--tile-u'), 'var(--rating-u)');
  for (const selector of ['\\.__uprofile_play_pattern_scale']) {
    const body = cssRule(selector);
    assert.match(declaration(body, '--u'), /clamp\(0\.5px, calc\(100cqi \/ 540\), 1px\)/);
    assert.equal(Math.max(.5, Math.min(1, 540 / 540)), 1);
    assert.equal(Math.max(.5, Math.min(1, 270 / 540)), .5);
    assert.equal(270 * Math.max(.5, Math.min(1, 270 / 540)), 135);
    assert.equal(269 * Math.max(.5, Math.min(1, 269 / 540)), 134.5);
  }
  assert.match(cssRule('\\.__uprofile_play_panel_scroll'), /max-width:\s*100%;[^}]*overflow-x:\s*auto/);
  assert.match(recentCss, /\.__uprofile_play_pattern_scale\s*\{[^}]*--u:\s*clamp\(0\.5px, calc\(100cqi \/ 540\), 1px\)/s);
  assert.match(recentCss, /\.__uprofile_play_lane_layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(recentCss, /@media\s*\(min-width:\s*900px\),\s*\(min-width:\s*600px\) and \(pointer:\s*fine\)\s*\{\s*\.__uprofile_play_lane_layout\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.equal(declaration(cssRule('\\.__uprofile_play_pattern_scroll'), 'max-width'), '100%');
  assert.equal(declaration(cssRule('\\.__uprofile_play_pattern_scroll'), 'min-width'), '0');
  assert.match(declaration(cssRule('\\.__uprofile_play_pattern_groups'), 'gap'), /calc\(16 \* var\(--u\)\)/);
  assert.equal(declaration(cssRule('\\.__uprofile_play_pattern_groups'), 'flex-wrap'), 'nowrap');
  assert.equal(declaration(cssRule('\\.__uprofile_play_rating \\.__uprofile_play_pattern_tile_white'), 'background'), '#f8fafc');
  assert.equal(declaration(cssRule('\\.__uprofile_play_rating \\.__uprofile_play_pattern_tile_black'), 'background'), '#252b36');
  assert.equal(declaration(cssRule('\\.__uprofile_play_pattern_digit'), 'color'), '#ff8a00');
  const inactiveTile = cssRule('\\.__uprofile_play_pattern_inactive\\s+\\.__uprofile_play_pattern_tile');
  assert.equal(declaration(inactiveTile, 'background'), '#3a3f47');
  assert.equal(declaration(inactiveTile, 'border-color'), '#4b5563');
  assert.equal(declaration(inactiveTile, 'opacity'), '.45');
  assert.equal(declaration(cssRule('\\.__uprofile_play_pattern_inactive\\s+\\.__uprofile_play_pattern_label'), 'opacity'), '.45');
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
  assert.equal(tree.props.children, 'key 1 · 3 · 2 · 1 · 0 · 3 · 77 · — · — · — · — · C · 44.44%');
  const tooltip = { type: 'div', props: { role: 'tooltip', className: '__uprofile_play_keydetail', children: tree } };
  assert.equal(flatten(tooltip).filter(node => node.props?.className === '__uprofile_play_keydetail').length, 1);
  assert.equal(flatten(tooltip).filter(node => node.props?.role === 'tooltip' && node.props?.className === '__uprofile_play_keydetail').length, 1);
  assert.match(recentPlaysSource, /role="tooltip"[^>]*className="__uprofile_play_keydetail"/);
  assert.match(recentPlaysSource, /<PlayLaneDetail side=\{selectedSide\}/);
  const p1 = PlayLaneDetail({ side, index: 0 });
  assert.equal(p1.props.children, 'key 1 · 3 · 2 · 1 · 0 · 3 · 77 · — · — · — · — · C · 44.44%');
  assert.equal(PlayLaneDetail({ side: { lanes: [[null, undefined, 'x', 4, -1, null], ...lanes.slice(1)], lane_fs: [[undefined, null, 'fast', 0]] }, index: 0 }).props.children, 'key 1 · — · — · x · 4 · -1 · — · — · — · fast · 0 · — · —');
  assert.equal(PlayLaneDetail({ side: { ...side, lane_fs: null }, index: 0 }).props.children, 'key 1 · 3 · 2 · 1 · 0 · 3 · 77 · — · — · — · — · C · 44.44%');
  assert.equal(PlayLaneDetail({ side: { lanes: Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]), lanes_ok: true }, index: 0 }).props.children, 'key 1 · 0 · 0 · 0 · 0 · 0 · 0 · — · — · — · — · — · —');
  assert.equal(PlayLaneDetail({ side: { ...side, lane_fs: [...Array.from({ length: 7 }, () => [0, 0, 0, 0]), [1, 2, 3, 4]] }, index: 7 }).props.children, 'scratch · 0 · 0 · 0 · 0 · 0 · 91 · 1 · 2 · 3 · 4 · — · —');
  const invalid = JSON.stringify(flatten(PlayLaneDetail({ side: { ...side, lanes_ok: false }, index: 0 })));
  assert.equal(flatten(PlayLaneDetail({ side: { ...side, lanes_ok: false }, index: 0 }))[0].props.children, 'key 1 · 3 · 2 · 1 · 0 · 3 · 77 · — · — · — · — · — · — · 레인 검증 불일치');
});

test('Recent lane controllers render one two-side panel with oriented units, badges, and preserved controls', () => {
  const textContentForTest = value => Array.isArray(value) ? value.map(textContentForTest).join('') : value && typeof value === 'object' ? textContentForTest(value.props?.children) : value ?? '';
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
  const p1Units = flatten(controllers[0]).filter(node => node.props?.className?.split(' ').includes('__uprofile_play_unit'));
  const p2Units = flatten(controllers[1]).filter(node => node.props?.className?.split(' ').includes('__uprofile_play_unit'));
  assert.equal(p1Units.length, 8);
  assert.equal(p2Units.length, 8);
  assert.equal(p1Units[0].props.className, '__uprofile_play_unit __uprofile_play_unit_scratch');
  assert.deepEqual(p1Units.map(node => node.props['data-key']), [8, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(p2Units.at(-1).props.className, '__uprofile_play_unit __uprofile_play_unit_scratch');
  assert.deepEqual(p2Units.map(node => node.props['data-key']), [1, 2, 3, 4, 5, 6, 7, 8]);
  const badges = nodes.filter(node => ['__uprofile_play_rank_white', '__uprofile_play_rank_black', '__uprofile_play_rank_scratch'].some(name => node.props?.className?.split(' ').includes(name)));
  assert.equal(badges.length, 16);
  assert.deepEqual([...new Set(badges.map(node => node.props.className.split(' ').find(token => ['__uprofile_play_rank_scratch', '__uprofile_play_rank_black', '__uprofile_play_rank_white'].includes(token))?.replace('__uprofile_play_rank_', '')))].sort(), ['black', 'scratch', 'white']);
  assert.ok(badges.every(node => node.props['aria-hidden'] === 'true' && [...p1Units, ...p2Units].some(unit => flatten(unit).includes(node))));
  assert.equal(badges.filter(node => node.props.className.split(' ').includes('__uprofile_play_rank_white')).length, 8);
  assert.equal(badges.filter(node => node.props.className.split(' ').includes('__uprofile_play_rank_black')).length, 6);
  assert.equal(badges.filter(node => node.props.className.split(' ').includes('__uprofile_play_rank_scratch')).length, 2);
  assert.equal(nodes.filter(node => node.props?.className === '__uprofile_play_keyboard').length, 2);
  const controllerText = [...p1Units, ...p2Units].map(unit => textContentForTest(unit)).join(' ');
  assert.doesNotMatch(controllerText, /PLAYER|SCRATCH|[1-7]/);
  for (const unit of [...p1Units, ...p2Units]) {
    const button = flatten(unit).find(node => node.type === 'button');
    const buttonChild = Array.isArray(button.props.children) ? button.props.children.filter(Boolean)[0] : button.props.children;
    if (unit.props['data-key'] === 8) {
      assert.ok(buttonChild.props.className.split(' ').includes('__uprofile_play_rank_scratch'));
      assert.equal(buttonChild.props.children, 'AAA');
      continue;
    }
    const number = Number(unit.props['data-key']);
    const tile = buttonChild;
    assert.ok(tile.props.className.split(' ').includes('__uprofile_play_pattern_tile'));
    assert.ok(tile.props.className.split(' ').includes(number % 2 ? '__uprofile_play_pattern_tile_white' : '__uprofile_play_pattern_tile_black'));
    assert.ok(flatten(tile).some(node => node.props?.className?.split(' ').includes('__uprofile_play_pattern_digit') && textContentForTest(node) === ''));
  }
  for (const button of buttons) {
    assert.match(button.props['aria-label'], /^P[12] (?:건반 [1-7]|스크래치)$/);
    assert.equal(button.props['aria-expanded'], false);
    assert.equal(button.props['aria-describedby'], undefined);
    assert.equal(typeof button.props.onPointerOver, 'function');
    assert.equal(typeof button.props.onPointerDown, 'function');
    assert.equal(typeof button.props.onFocus, 'function');
    assert.equal(button.props.onClick, undefined);
  }
  assert.deepEqual(buttons.map(button => button.props['aria-label']), ['P1 스크래치', 'P1 건반 1', 'P1 건반 2', 'P1 건반 3', 'P1 건반 4', 'P1 건반 5', 'P1 건반 6', 'P1 건반 7', 'P2 건반 1', 'P2 건반 2', 'P2 건반 3', 'P2 건반 4', 'P2 건반 5', 'P2 건반 6', 'P2 건반 7', 'P2 스크래치']);
  const missing = flatten(detailTree(null, { ...play, difficulty: 'SPN', judge_16: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' }));
  const missingBadges = missing.filter(node => ['__uprofile_play_rank_white', '__uprofile_play_rank_black', '__uprofile_play_rank_scratch'].some(name => node.props?.className?.split(' ').includes(name)));
  const inactiveBadges = missingBadges.filter(node => node.props.className.split(' ').includes('__uprofile_play_rank_inactive'));
  assert.equal(inactiveBadges.length, 16);
  assert.ok(inactiveBadges.every(node => node.props.children === '—'));
  const missingButtons = missing.filter(node => node.type === 'button' && node.props.className.includes('__uprofile_play_inactive'));
  assert.equal(missingButtons.length, 16);
  assert.ok(missingButtons.every(button => button.props['aria-label'] === undefined && button.props['aria-describedby'] === undefined && button.props.onPointerOver === undefined && button.props.onPointerDown === undefined && button.props.onFocus === undefined));
  const activeSp = flatten(detailTree({ complete: true, p1: side, p2: side }, { ...play, difficulty: 'SPN', judge_16: '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0' }));
  const spInactive = activeSp.filter(node => node.type === 'button' && node.props.className?.includes('__uprofile_play_inactive'));
  assert.equal(spInactive.length, 8);
  assert.ok(spInactive.every(button => button.props['aria-label'].startsWith('P2 ')));
  const renderedRanks = laneSide => flatten(controllerHarness.PlayLaneController({ side: laneSide, player: 'P1', activity: 'BOTH' })).filter(node => node.props?.className?.split(' ').includes('__uprofile_play_rank')).map(node => textContentForTest(node.props.children));
  const sevenLanes = Array.from({ length: 7 }, () => [0, 0, 0, 0, 0, 0]); sevenLanes[0] = [3, 2, 1, 0, 3, 0];
  assert.deepEqual(renderedRanks({ lanes: sevenLanes }), Array(8).fill('—'));
  assert.match(textContentForTest(controllerHarness.PlayLaneDetail({ side: { lanes: sevenLanes }, index: 0 }).props.children), /· C · 44\.44%$/);
  const emptyLanes = Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(renderedRanks({ lanes: emptyLanes }), Array(8).fill('—'));
  const zeroExLanes = Array.from({ length: 8 }, () => [0, 0, 0, 0, 1, -1]);
  assert.deepEqual(renderedRanks({ lanes: zeroExLanes }), Array(8).fill('F'));
  const boundaryEx = [16, 14, 12, 10, 8, 6, 4, 2];
  const boundaryLanes = boundaryEx.map(ex => [Math.floor(ex / 2), ex % 2, 0, 0, 9 - Math.floor(ex / 2) - (ex % 2), 999]);
  assert.deepEqual(renderedRanks({ lanes: boundaryLanes }), ['F', 'AAA', 'AA', 'A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(renderedRanks({ lanes: boundaryLanes, lanes_ok: false }), Array(8).fill('—'));
  const invalidFront = boundaryLanes.map(lane => [...lane]);
  invalidFront[0][4] = -1;
  assert.equal(renderedRanks({ lanes: invalidFront })[1], '—');
});

test('lane controller pointer handlers preserve or replace the one selected lane', () => {
  let selected = null;
  const module = vm.runInNewContext(recentDetailCode, {
    React: { createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }) },
    LAMP_NUM_TO_ABBR: {}, djLevelFromScore: () => 'C',
    document: { addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {}, innerHeight: 900, innerWidth: 1200 },
  });
  const side = { lanes_ok: true, lanes: Array.from({ length: 8 }, () => [1, 1, 1, 1, 1, 1]), lane_fs: null };
  const render = selection => module.PlayLaneController({ side, player: 'P1', activity: 'BOTH', rowKey: 'row-a', selection, onSelect: value => { selected = value; } });
  const getButton = (tree, key) => flatten(tree).find(node => node.type === 'button' && node.props['data-key'] === key);
  const firstTarget = { getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 20 }) };
  let first = getButton(render(null), 1);
  let prevented = false;
  first.props.onPointerDown({ pointerType: 'touch', currentTarget: firstTarget, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(selected.lane, 1);
  assert.equal(selected.touch, true);
  first = getButton(render(selected), 1);
  first.props.onPointerDown({ pointerType: 'touch', currentTarget: firstTarget, preventDefault() {} });
  assert.equal(selected.lane, 1);
  const secondTarget = { getBoundingClientRect: () => ({ left: 20, top: 10, bottom: 20 }) };
  const second = getButton(render(selected), 2);
  second.props.onPointerDown({ pointerType: 'touch', currentTarget: secondTarget, preventDefault() {} });
  assert.equal(selected.lane, 2);
  assert.equal(selected.touch, true);
  const detailTarget = { closest: selector => selector === '.__uprofile_play_keydetail' ? {} : null };
  second.props.onPointerOut({ currentTarget: secondTarget, relatedTarget: detailTarget });
  assert.equal(selected.lane, 2);
  const mouse = getButton(render(null), 3);
  const mouseTarget = { getBoundingClientRect: () => ({ left: 30, top: 10, bottom: 20 }) };
  mouse.props.onPointerOver({ pointerType: 'mouse', currentTarget: mouseTarget });
  assert.equal(selected.lane, 3);
  assert.equal(selected.touch, false);
  const activeMouse = getButton(render(selected), 3);
  activeMouse.props.onPointerOut({ currentTarget: mouseTarget, relatedTarget: null });
  assert.equal(selected, null);
});

test('Recent lane rating keeps side names and omits unresolved lane counts for missing, zero, and positive values', () => {
  for (const value of [undefined, 0, 3]) {
    const detail = value === undefined ? { complete: true, p1: {}, p2: {} } : { complete: true, p1: { lane_fs_unresolved: value }, p2: { lane_fs_unresolved: value } };
    const ratingHeadings = flatten(detailTree(detail)).filter(node => node.props?.className === '__uprofile_play_rating').flatMap(node => flatten(node).filter(child => child.type === 'h5'));
    assert.equal(ratingHeadings.length, 0);
  }
  const missingRatingHeadings = flatten(detailTree(null)).filter(node => node.props?.className === '__uprofile_play_rating').flatMap(node => flatten(node).filter(child => child.type === 'h5'));
  assert.equal(missingRatingHeadings.length, 0);
});
