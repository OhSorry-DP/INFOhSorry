import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
function load(source, dependencies = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
    return dependencies[name];
  }, console: { log() {}, warn() {} }, ...globals });
  return exports;
}
const shared = load(read('../../shared/uploadSnapshot.ts'));
const keys = Array.from(shared.PLAY_CSV_KEYS);
const source = read('./supabaseSync.ts');
function sync(globals = {}) {
  return load(source, { '../../shared/uploadSnapshot': shared,
    '../../shared/match': { norm: x => x, slotToDiff: x => x }, '../../shared/dataSource': { DATA_BASE: 'https://fixture.invalid' } }, globals);
}
const row = i => Object.fromEntries(keys.map(key => [key, key === 'timestamp' ? String(i) : key === 'title' ? '한글, "곡" \\ 경로\n다음 줄' : key === 'difficulty' ? ['SPN', 'DPA', 'SPA'][i % 3] : key === 'battle_flag' ? String(i % 2) : '001']));
const csvLine = value => keys.map(key => `"${value[key].replaceAll('"', '""')}"`).join(',') + '\r\n';
const csv = rows => keys.join(',') + '\n' + rows.map(csvLine).join('');
const plain = x => JSON.parse(JSON.stringify(x));

test('101판에서 마지막 100판: 혼합 SP/DP/배틀, 원본 문자열과 파일 순서 보존', () => {
  const rows = Array.from({ length: 101 }, (_, i) => row(i));
  assert.deepEqual(plain(sync().parseRecentPlays(csv(rows))), rows.slice(1));
});
test('헤더 제외, 빈 CSV, 따옴표/쉼표/한글/이스케이프, 불완전 마지막 레코드 제외', () => {
  const { parseRecentPlays } = sync();
  assert.deepEqual(plain(parseRecentPlays('')), []);
  assert.deepEqual(plain(parseRecentPlays(csv([]))), []);
  for (const tail of ['"incomplete', csvLine(row(2)).trimEnd(), 'short,row\n']) {
    assert.deepEqual(plain(parseRecentPlays(csv([row(1)]) + tail)), [row(1)]);
  }
});
test('수동/pending/종료 업로드는 게임 없이 계속 실행, pending plays 생략, NULL/[] 계약', async () => {
  const calls = [];
  const api = sync({ window: { infohsorry: { serviceStatus: { get: async () => ({ uploadEnabled: true }) } } },
    fetch: async (url, options) => { calls.push({ url, body: options?.body && JSON.parse(options.body) }); return { ok: true, json: async () => [] }; } });
  const base = { appVersion: 'test', profile: { iidxId: 'C123456789012', djName: '한글' }, starResult: null, charts: [] };
  for (const trigger of ['manual', 'pending', 'final']) {
    calls.length = 0;
    assert.equal((await api.uploadProfile({ ...base, plays: [row(1)], gameRecognized: async () => false })).ok, true, trigger);
    const sent = calls.find(x => x.url.endsWith('/rpc/upsert_user'));
    assert.ok(sent);
    assert.equal('p_plays' in sent.body, false);
  }
  for (const plays of [undefined, null, [], [row(1)]]) {
    calls.length = 0;
    await api.uploadProfile({ ...base, plays, gameRecognized: async () => true });
    const body = calls.find(x => x.url.endsWith('/rpc/upsert_user')).body;
    assert.equal('p_plays' in body, plays !== undefined);
    if (plays !== undefined) assert.deepEqual(body.p_plays, plays);
  }
});
test('전송 순간 재확인: serviceStatus 대기 중 게임이 종료되어도 기존 업로드는 유지', async () => {
  let recognized = true; let body;
  const api = sync({ window: { infohsorry: { serviceStatus: { get: async () => { recognized = false; return { uploadEnabled: true }; } } } },
    fetch: async (url, options) => { if (url.endsWith('/rpc/upsert_user')) body = JSON.parse(options.body); return { ok: true, json: async () => [] }; } });
  assert.equal((await api.uploadProfile({ profile: { iidxId: 'C123456789012' }, charts: [], starResult: null,
    plays: [row(0)], gameRecognized: async () => recognized })).ok, true);
  assert.equal('p_plays' in body, false);
});
test('TODO 변환은 null: DBR 0회, plays 정상', async () => {
  const api = sync(); const rows = api.parseRecentPlays(csv([row(1)])); let requests = 0;
  assert.equal(api.decodeBattleRandomPlay(rows[0]), null);
  await api.uploadAutomaticDbr(rows, 'C123456789012', async () => true, undefined, async () => { requests++; return 'token'; }, async () => { requests++; });
  assert.equal(requests, 0);
  assert.deepEqual(plain(api.playsForGame(rows, true)), [row(1)]);
});
test('확정 후보 테스트 경계: 기존 Bearer API에 improvements_only:true로 클라이언트 전체 직렬 전송', async () => {
  const api = sync(); const calls = []; let active = 0; let maxActive = 0;
  const decode = r => ({ song_id: Number(r.timestamp), diff: 3, lamp: 5, ex_score: 100 });
  const send = async (url, options) => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    calls.push({ url, options, body: JSON.parse(options.body) }); active--;
    return { ok: true };
  };
  await Promise.all([
    api.uploadAutomaticDbr([row(1), row(2)], 'C123456789012', async () => true, decode, async () => 'existing-bearer', send),
    api.uploadAutomaticDbr([row(3)], 'C123456789012', async () => true, decode, async () => 'existing-bearer', send),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map(x => x.body.song_id), [1, 2, 3]);
  for (const call of calls) {
    assert.equal(call.url, 'https://iidx.in/api/me/dbr-scores');
    assert.equal(call.options.headers.Authorization, 'Bearer existing-bearer');
    assert.equal(call.body.improvements_only, true);
    assert.equal('iidx_id' in call.body, false);
    assert.equal('pw' in call.body, false);
  }
});
test('자동 DBR은 게임 미인식/전송 중 종료에서 생략', async () => {
  const api = sync(); let requests = 0; let recognized = false;
  const decode = () => ({ song_id: 1, diff: 3, lamp: 5, ex_score: 100 });
  const bearer = async () => 'token';
  const send = async () => { requests++; recognized = false; return { ok: true }; };
  await api.uploadAutomaticDbr([row(1)], 'C123456789012', async () => recognized, decode, bearer, send);
  assert.equal(requests, 0);
  recognized = true;
  await api.uploadAutomaticDbr([row(1), row(2)], 'C123456789012', async () => recognized, decode, bearer, send);
  assert.equal(requests, 1);
});
test('saveOnce 실제 저장 경계: A→B 경로, 미취득 생략, append 성공 후 해당 계정 알림, 공용 CSV 불변', () => {
  const store = load(read('../../main/accountTsvStore.ts'), { electron: { app: { getPath: () => '/fixture/userData' } }, fs: { promises: {} }, path,
    './tsv': {}, './memory': {}, '../shared/account': {} });
  const logger = read('../../main/playLogger.ts');
  const save = logger.slice(logger.indexOf('  const saveOnce ='), logger.indexOf('  const tick ='));
  const files = new Map([['/fixture/userData/play-log/plays.csv', Buffer.from('공용 원본\r\n')]]);
  const original = Buffer.from(files.values().next().value); const events = []; let id = 'C123456789012'; let fail = false;
  const api = load(`export function save() { ${save} saveOnce(); }`, {}, {
    opts: { getAccount: () => id, onAppend: e => events.push({ ...e }), log() {} }, handle: {},
    accountPlayCsvPath: store.accountPlayCsvPath, dirname: path.dirname, mkdirSync() {},
    existsSync: p => files.has(p), writeFileSync: (p, value) => files.set(p, Buffer.from(value)),
    appendFileSync: (p, value) => { if (fail) throw new Error('append failed'); files.set(p, Buffer.concat([files.get(p), Buffer.from(value)])); },
    PLAY_LOG_HEADER: keys.join(','), buildSnapshotRow: () => ({ row: csvLine(row(1)).trimEnd(), songId: 1 }),
  });
  api.save(); id = 'C999999999999'; api.save(); id = null; api.save();
  assert.deepEqual(events, [{ iidxId: 'C123456789012' }, { iidxId: 'C999999999999' }]);
  for (const account of ['C123456789012', 'C999999999999']) assert.ok(files.has(store.accountPlayCsvPath(account)));
  id = 'C123456789012'; fail = true; assert.throws(() => api.save(), /append failed/); assert.equal(events.length, 2);
  assert.deepEqual(files.get('/fixture/userData/play-log/plays.csv'), original);
  assert.equal(store.accountPlayCsvPath('../outside'), null);
});
test('기존 예약·초기 2초·재시작 pending·종료 흐름과 IPC 연결 유지', () => {
  const app = read('./App.tsx'); const main = read('../../main/index.ts'); const preload = read('../../preload/index.ts');
  assert.match(app, /AUTO_UPLOAD_MIN_GAP_MS = 3 \* 60 \* 1000/);
  assert.equal(load(read('./initialAutoUpload.ts')).INITIAL_AUTO_UPLOAD_STABLE_MS, 2000);
  assert.match(app, /INITIAL_AUTO_UPLOAD_DELAY_MS = INITIAL_AUTO_UPLOAD_STABLE_MS/);
  assert.match(app, /onPlayAppend\?\.\(\(\{ iidxId \}\) => runIfDue\(iidxId\)\)/);
  assert.match(app, /await uploadSnapshot\(snapshot, 'pending'\)/);
  assert.match(app, /await tryUpload\('final'\)/);
  assert.match(app, /finalDone\(outcome\)/);
  assert.match(preload, /ipcRenderer\.invoke\('account:readPlayCsv', iidxId\)/);
  assert.match(preload, /ipcRenderer\.on\('play:appended', listener\)/);
  assert.match(main, /webContents\.send\('play:appended', event\)/);
  assert.equal(main.match(/startPlayLogger\(\{/g).length, 1);
});

test('CSV 증가 알림은 기존 runIfDue 예약을 깨운다: 3분 간격과 초기 안정 대기 2초 유지', async () => {
  const app = read('./App.tsx');
  const scheduling = app.slice(app.indexOf('    let initialTimer: number | null = null;'), app.indexOf('    const runManual ='));
  const id = 'C123456789012'; const scope = { iidxId: id, epoch: 1 };
  const state = { bundleReady: true, scope, rowsRevision: 1, expectedBundle: {} };
  const initialAutoUploadSucceededRef = { current: true }; const autoUploadBusyRef = { current: false };
  const scheduled = []; const uploads = []; let now = 200_000; let last = 100_000;
  const api = load(`export function setup() { ${scheduling} return runIfDue; }`, {}, {
    uploadStateRef: { current: state }, sessionRef: { current: { pid: 123, generation: 1 } },
    lastSnapshotRef: { current: { iidxId: id, generation: 1 } }, accountScopeRef: { current: scope },
    selectedViewerIdRef: { current: id }, initialAutoUploadSucceededRef, autoUploadBusyRef,
    rowsRef: { current: [1] }, isFloorSeedCurrent: (a, b) => a.epoch === b.epoch,
    readLastUploadAt: () => last, isUploadDue: (at, time, gap) => time - at >= gap,
    Date: class extends Date { static now() { return now; } }, AUTO_UPLOAD_MIN_GAP_MS: 180_000, INITIAL_AUTO_UPLOAD_DELAY_MS: 2000,
    uploadIdentityOk: () => ({ ok: true, id }),
    tryUpload: async trigger => { uploads.push(trigger); return { kind: 'success' }; },
    window: { setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimeout() {} },
    setTimeout() {}, setVecRecomputeKey() {},
  });
  const runIfDue = api.setup();
  const onAppend = ({ iidxId }) => runIfDue(iidxId);
  onAppend({ iidxId: 'C999999999999' }); assert.equal(uploads.length, 0);
  onAppend({ iidxId: id }); assert.equal(uploads.length, 0);
  now = last + 180_000;
  onAppend({ iidxId: id }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uploads, ['auto']); assert.equal(scheduled.length, 0);
  initialAutoUploadSucceededRef.current = false; autoUploadBusyRef.current = false; uploads.length = 0;
  onAppend({ iidxId: id }); assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 2000); assert.equal(uploads.length, 0);
  scheduled[0].callback(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uploads, ['auto']);
});

test('계정 CSV 읽기 IPC 저장소는 UTF-8 원본을 반환하고 없는 파일은 빈 CSV', async () => {
  const content = csv([row(1)]); const calls = [];
  const store = load(read('../../main/accountTsvStore.ts'), { electron: { app: { getPath: () => '/fixture/userData' } },
    fs: { promises: { readFile: async (file, encoding) => {
      calls.push({ file, encoding });
      if (file.includes('C999999999999')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    } } }, path, './tsv': {}, './memory': {}, '../shared/account': {} });
  assert.deepEqual(plain(await store.readAccountPlayCsv('C123456789012')), { ok: true, csv: content });
  assert.equal(calls[0].file, store.accountPlayCsvPath('C123456789012'));
  assert.equal(calls[0].encoding, 'utf8');
  assert.deepEqual(plain(await store.readAccountPlayCsv('C999999999999')), { ok: true, csv: '' });
  assert.deepEqual(plain(await store.readAccountPlayCsv('../outside')), { ok: false, error: 'invalid id' });
  assert.equal(calls.length, 2);
});
