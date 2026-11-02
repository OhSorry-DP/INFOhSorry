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
  assert.match(appSource, /textageByTitle, remotePlaysSig\]/);
});

test('identical plays preserve signature and deduplicate publish', () => {
  assert.match(appSource, /if \(sig === lastRemoteSigRef\.current\) return/);
  assert.match(appSource, /remotePlaysSig/);
});
