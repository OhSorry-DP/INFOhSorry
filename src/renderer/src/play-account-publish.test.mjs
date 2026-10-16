import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const source = read('./useProfile.ts');
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
