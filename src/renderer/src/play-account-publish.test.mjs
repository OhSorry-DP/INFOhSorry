import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const source = read('./useProfile.ts');
const appSource = read('./App.tsx');
function profile({ text = 'A123456789012', readOk = true, pids = [123, 123], publish = async () => ({ ok: true }), diag = () => {} } = {}) {
  const calls = [];
  const timers = [];
  const globals = {
    localStorage: { getItem: () => null },
    window: { infohsorry: {
      memory: {
        readString: async (...args) => { calls.push(['readString', ...args]); return { ok: readOk, text, error: 'read failed' }; },
        readViaAnchor: async (...args) => { calls.push(['readViaAnchor', ...args]); return { ok: readOk, text, error: 'read failed' }; },
        setPlayAccount: async account => { calls.push(['setPlayAccount', account]); return publish(account); },
      },
      session: { getState: async () => ({ pid: pids.length ? pids.shift() : 123 }) },
    }, setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {} },
  };
  const dependencies = {
    react: { useEffect(callback) { callback(); }, useRef: value => ({ current: value }), useState: value => [value, () => {}] },
    '../../shared/profileOffsets': { PROFILE_OFFSETS: { iidxId: { offset: '4096', encoding: 'ascii', maxBytes: 64 } }, PROFILE_NUMERIC_OFFSETS: {}, RADAR_AXIS_ORDER: [], DAN_NAMES: [], danIndexToRankInt: () => null, isRemoteNumericOffset: () => false, isRemoteStringOffset: () => false },
    './NotesRadar': {}, '../../shared/types': {}, './diagLog': { addDiagLine: diag },
  };
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
    return dependencies[name];
  }, console: { log() {}, warn() {} }, ...globals });
  return { api: exports, calls, timers };
}

test('주기 fresh 성공 pid123와 ID를 기존 setPlayAccount로 전달', async () => {
  const { api, calls, timers } = profile();
  api.useProfile({ stage: 'ready' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call[0] === 'setPlayAccount'))), [['setPlayAccount', { pid: 123, iidxId: 'A123456789012' }]]);
});

test('readIidxIdFresh 성공도 실제 읽은 ID를 전달', async () => {
  const { api, calls } = profile();
  const result = await api.readIidxIdFresh();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true, iidxId: 'A123456789012', processMissing: false });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(call => call[0] === 'setPlayAccount'))), [['setPlayAccount', { pid: 123, iidxId: 'A123456789012' }]]);
});

test('잘못된 ID, read 실패, pid 불일치 또는 없음이면 전달하지 않음', async () => {
  for (const setup of [
    { text: 'bad-id' },
    { readOk: false },
    { pids: [123, 124] },
    { pids: [undefined] },
  ]) {
    const { calls } = profile(setup);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.some(call => call[0] === 'setPlayAccount'), false);
  }
});

test('publish reject는 ID 읽기 성공을 보존하고 같은 오류 진단은 억제', async () => {
  const diagnostics = [];
  const setup = { publish: async () => { throw new Error('IPC unavailable'); }, diag: message => diagnostics.push(message) };
  const { api } = profile(setup);
  const first = await api.readIidxIdFresh();
  const second = await api.readIidxIdFresh();
  assert.equal(first.ok, true);
  assert.equal(first.iidxId, 'A123456789012');
  assert.equal(second.ok, true);
  assert.equal(second.iidxId, 'A123456789012');
  assert.deepEqual(diagnostics, ['플레이 계정 ID 전달 실패: IPC unavailable']);
});

test('remote plays는 11행에서 마지막 10행만 보관', () => {
  assert.match(appSource, /buildUploadPlays\(result\.ok[\s\S]*?\)\.slice\(-10\)/);
});

test('append 이벤트는 CSV를 다시 읽어 remote plays를 갱신', () => {
  const append = appSource.slice(appSource.indexOf('const handlePlaysAppend'), appSource.indexOf('const handlePlayAppend'));
  assert.match(append, /refreshRemotePlays\(iidxId, sessionRef\.current\.generation\)/);
  assert.match(appSource, /await readPlayCsv\(iidxId\)/);
});

test('append DBR은 마지막 완결 행 하나만 전송', () => {
  const append = appSource.slice(appSource.indexOf('const handlePlaysAppend'), appSource.indexOf('const handlePlayAppend'));
  assert.match(append, /uploadAutomaticDbr\(\[parsed\.rows\[parsed\.rows\.length - 1\]\]/);
  assert.match(append, /onDbrSaved, false\)/);
});

test('append 마지막 비DBR 행에서 과거 적격 행을 고르지 않는다', () => {
  const append = appSource.slice(appSource.indexOf('const handlePlaysAppend'), appSource.indexOf('const handlePlayAppend'));
  assert.match(append, /parsed\.rows\[parsed\.rows\.length - 1\]/);
  assert.doesNotMatch(append, /findLast|\.reverse\(\)|\.sort\(/);
});

test('append 마지막 형식 오류는 DBR을 생략한다', async () => {
  const append = appSource.slice(appSource.indexOf('const handlePlaysAppend'), appSource.indexOf('const handlePlayAppend'));
  assert.match(append, /parsed\.errorCode == null && parsed\.lastCompleteError == null && parsed\.rows\.length > 0/);
  const cases = [
    { read: { ok: true, csv: 'csv' }, parsed: { rows: [{ marker: 'A' }], lastCompleteError: { columns: 1 }, errorCode: null } },
    { read: { ok: true, csv: 'csv' }, parsed: { rows: [{ marker: 'A' }], lastCompleteError: null, errorCode: -9 } },
    { read: { ok: true, csv: 'csv' }, parsed: { rows: [], lastCompleteError: null, errorCode: null } },
    { read: { ok: true, found: false, csv: 'csv' }, parsed: { rows: [{ marker: 'A' }], lastCompleteError: null, errorCode: null } },
    { read: { ok: false }, parsed: { rows: [{ marker: 'A' }], lastCompleteError: null, errorCode: null } },
    { read: { ok: true, csv: 'csv' }, throws: true },
  ];
  for (const item of cases) {
    const calls = [];
    const globals = {
      APP_VERSION: 'test', refreshRemotePlays: async () => {}, sessionRef: { current: { generation: 1 } },
      window: { infohsorry: { upload: { readPlayCsv: async () => item.read }, session: { getState: async () => ({ pid: 5 }) } } },
      buildUploadPlays: () => [], parsePlayHistoryDetailed: () => { if (item.throws) throw new Error('parse'); return item.parsed; },
      readIidxIdFresh: async () => ({ iidxId: 'C123456789012', processMissing: false }),
      uploadAutomaticPlays: async () => {}, uploadAutomaticDbr: async (...args) => calls.push(args),
      onDbrSaved() {}, addDiagLine() {}, console: { warn() {} },
    };
    const code = ts.transpileModule(`export function setup() { const playsChainByAccount = new Map(); ${append} return handlePlaysAppend; }`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, ...globals });
    exports.setup()({ iidxId: 'C123456789012' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 0);
  }
});

function appendFixture({ readPlayCsv, uploadAutomaticPlays, uploadAutomaticDbr }) {
  const append = appSource.slice(appSource.indexOf('const handlePlaysAppend'), appSource.indexOf('const handlePlayAppend'));
  const globals = {
    APP_VERSION: 'test', refreshRemotePlays: async () => {}, sessionRef: { current: { generation: 1 } },
    window: { infohsorry: { upload: { readPlayCsv }, session: { getState: async () => ({ pid: 5 }) } } },
    buildUploadPlays: () => [], parsePlayHistoryDetailed: () => ({ rows: [{ marker: 'last' }], errorCode: null, lastCompleteError: null }),
    readIidxIdFresh: async () => ({ iidxId: 'C123456789012', processMissing: false }),
    uploadAutomaticPlays, uploadAutomaticDbr, onDbrSaved() {}, addDiagLine() {}, console: { warn() {} },
  };
  const code = ts.transpileModule(`export function setup() { const playsChainByAccount = new Map(); ${append} return handlePlaysAppend; }`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, ...globals });
  return exports.setup();
}

test('append PUT 완료 뒤 DBR을 호출한다', async () => {
  for (const throws of [false, true]) {
    let release; let started;
    const gate = new Promise(resolve => { release = resolve; });
    const putStarted = new Promise(resolve => { started = resolve; });
    const calls = [];
    const handle = appendFixture({
      readPlayCsv: async () => ({ ok: true, csv: 'csv' }),
      uploadAutomaticPlays: async () => { calls.push('plays'); started(); await gate; if (throws) throw new Error('PUT 실패'); },
      uploadAutomaticDbr: async () => { calls.push('dbr'); },
    });
    handle({ iidxId: 'C123456789012' });
    try {
      await putStarted;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(calls, ['plays']);
    } finally {
      release();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(calls, ['plays', 'dbr']);
  }
});

test('append CSV 읽기는 계정 체인 안에 남는다', async () => {
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; });
  const putStarted = new Promise(resolve => { started = resolve; });
  let reads = 0; let puts = 0;
  const handle = appendFixture({
    readPlayCsv: async () => { reads++; return { ok: true, csv: 'csv' }; },
    uploadAutomaticPlays: async () => { if (++puts === 1) { started(); await gate; } },
    uploadAutomaticDbr: async () => {},
  });
  handle({ iidxId: 'C123456789012' });
  await putStarted;
  handle({ iidxId: 'C123456789012' });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
  } finally {
    release();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(reads, 2);
});

test('auto initial 전체 대상과 기존 플레이 창을 유지한다', () => {
  assert.match(appSource, /uploadAutomaticDbr\(snapshot\.plays, snapshot\.iidxId, gameRecognized,/);
  assert.match(appSource, /buildUploadPlays\(result\.ok[\s\S]*?\)\.slice\(-10\)/);
});

test('append 한 번으로 플레이 결과와 무관하게 동일 판 DBR 저장을 실행', async () => {
  const append = appSource.slice(appSource.indexOf('const handlePlaysAppend'), appSource.indexOf('const handlePlayAppend'));
  assert.match(append, /parsePlayHistoryDetailed\(result\.csv \?\? ''\)/);
  const calls = []; const diagnostics = []; const savedIds = [];
  const globals = {
    APP_VERSION: 'test', refreshRemotePlays: async () => {}, sessionRef: { current: { generation: 1 } },
    window: { infohsorry: {
      upload: { readPlayCsv: async id => ({ ok: true, csv: '80121,Fixture Song,SPA,3,1,99,1\n', appVersion: 'test', gameVersion: 'fixture' }) },
      session: { getState: async () => ({ pid: 5 }) },
    } },
    buildUploadPlays: () => [{ timestamp: '2026-01-01T00:00:00.000Z', song_id: '80121', title: 'Fixture Song', difficulty: 'SPA', notes: '10', ex_score: '5' }],
    parsePlayHistoryDetailed: () => ({ rows: [{ song_id: '80121', marker: 'last' }], lastCompleteError: null }),
    readIidxIdFresh: async () => ({ iidxId: 'C123456789012', processMissing: false }),
    uploadAutomaticPlays: async (...args) => { calls.push(['plays', ...args]); return { ok: true }; },
    uploadAutomaticDbr: async (...args) => { calls.push(['dbr', ...args]); args[7]?.(args[1]); return { ok: true }; },
    onDbrSaved: id => savedIds.push(id),
    addDiagLine: line => diagnostics.push(line), console: { warn() {} },
  };
  const code = ts.transpileModule(`export function setup() { const playsChainByAccount = new Map(); const revisions = {}; const onDbrSaved = id => { revisions[id] = (revisions[id] ?? 0) + 1; }; ${append} return { handlePlaysAppend, revisions }; }`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, ...globals });
  const h = exports.setup();
  h.handlePlaysAppend({ iidxId: 'C123456789012' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(call => call[0]), ['plays', 'dbr']);
  assert.notEqual(calls[0][1], calls[1][1]);
  assert.equal(calls[1][1][0].marker, 'last');
  assert.equal(calls[0][2], 'C123456789012'); assert.equal(calls[1][2], 'C123456789012');
  assert.equal(await calls[1][3](), true);
  assert.equal(h.revisions['C123456789012'], 1);
  assert.equal(h.revisions['A123456789012'], undefined);
  assert.deepEqual(diagnostics, []);
});

test('remote plays 갱신은 자동 전송 성공이나 Bearer 유무에 의존하지 않음', () => {
  const refresh = appSource.slice(appSource.indexOf('const refreshRemotePlays'), appSource.indexOf('function uploadIdentityOk'));
  assert.match(refresh, /remotePlaysRef\.current = \{ iidxId, plays \}/);
  assert.doesNotMatch(refresh, /uploadAutomaticPlays|Bearer/);
});

test('계정 또는 세션 전환과 역순 응답은 오래된 결과를 버림', () => {
  const refresh = appSource.slice(appSource.indexOf('const refreshRemotePlays'), appSource.indexOf('function uploadIdentityOk'));
  assert.match(refresh, /request !== remotePlaysRequestRef\.current/);
  assert.match(refresh, /current\.iidxId !== iidxId/);
  assert.match(refresh, /current\.generation !== generation/);
  assert.match(refresh, /sessionRef\.current\.generation !== generation/);
  assert.match(refresh, /remotePlaysRequestRef\.current \+= 1/);
});

test('matched account publishes plays with detail', () => {
  assert.match(appSource, /remotePlays\?\.iidxId === gate\.id \? remotePlays\.plays : \[\]/);
  assert.match(appSource, /Object\.assign\(remoteUser, \{ plays \}\)/);
});

test('mismatched account publishes empty plays', () => {
  assert.match(appSource, /remotePlays\?\.iidxId === gate\.id \? remotePlays\.plays : \[\]/);
});

test('new play timestamp changes signature and republishes', () => {
  assert.match(appSource, /setRemotePlaysSig\(JSON\.stringify\(\{ iidxId, plays \}\)\)/);
  assert.match(appSource, /remotePlaysSig,[\s\S]*?\]\.join\('\|'\)/);
  assert.match(appSource, /textageByTitle, remotePlaysSig, dbrSavedRevisionByAccount\]/);
});

test('identical plays preserve signature and deduplicate publish', () => {
  assert.match(appSource, /if \(sig === lastRemoteSigRef\.current\) return/);
  assert.match(appSource, /remotePlaysSig/);
});

test('DBR saved 완료는 해당 계정 revision만 올리고 현재 gate 계정 push 서명에만 포함', () => {
  assert.match(appSource, /setDbrSavedRevisionByAccount\(\(current\) => \(\{ \.\.\.current, \[iidxId\]: \(current\[iidxId\] \?\? 0\) \+ 1 \}\)\)/);
  assert.match(appSource, /dbrSavedRevisionByAccount\[gate\.id\] \?\? 0/);
  assert.match(appSource, /remotePlays\?\.iidxId === gate\.id \? remotePlays\.plays : \[\]/);
  assert.match(appSource, /Object\.assign\(remoteUser, \{ plays \}\)/);
  assert.doesNotMatch(appSource.slice(appSource.indexOf('const remoteUser = buildRemoteUser'), appSource.indexOf('void window.infohsorry.remote.setUser')), /dbrSavedRevisionByAccount|dbrRevision/);
  const append = appSource.slice(appSource.indexOf('const handlePlaysAppend'), appSource.indexOf('const handlePlayAppend'));
  assert.match(append, /uploadAutomaticDbr\(\[parsed\.rows\[parsed\.rows\.length - 1\]\], iidxId, gameRecognized, undefined, undefined, undefined, undefined, onDbrSaved, false\)/);
  assert.equal((append.match(/onDbrSaved, false\)/g) ?? []).length, 1);
});

test('saved revision은 동일 plays payload publish를 한 번 재실행하고 unchanged와 다른 계정은 제외', () => {
  const publish = (revision, last, account = 'C123456789012') => {
    const sig = ['same-profile', 'same-plays', revision[account] ?? 0].join('|');
    if (sig === last.sig) return { calls: last.calls, sig };
    return { calls: [...last.calls, { account, plays: [{ timestamp: '2026-01-01T00:00:00.000Z', song_id: '80121', ex_score: '5' }] }], sig };
  };
  const initial = publish({}, { sig: '', calls: [] });
  const aSaved = publish({ 'C123456789012': 1 }, initial);
  const duplicate = publish({ 'C123456789012': 1 }, aSaved);
  const bOnly = publish({ 'C123456789012': 1, D123456789012: 1 }, duplicate);
  assert.equal(initial.calls.length, 1);
  assert.equal(aSaved.calls.length, 2);
  assert.equal(duplicate.calls.length, 2);
  assert.equal(bOnly.calls.length, 2);
  assert.deepEqual(aSaved.calls[1].plays, initial.calls[0].plays);
  assert.deepEqual(Object.keys(aSaved.calls[1]), ['account', 'plays']);
});
