import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const indexSource = readFileSync(indexPath, 'utf8');
const sourceFile = ts.createSourceFile(indexPath, indexSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function loadFunction(name, globals) {
  const declaration = sourceFile.statements.find((node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration, `missing function ${name}`);
  const source = declaration.getFullText(sourceFile);
  const compiled = ts.transpileModule(`${source}\nexports.fn = ${name};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  globals.exports = {};
  const context = vm.createContext(globals);
  vm.runInContext(compiled, context);
  return { fn: context.exports.fn, context };
}

function accountHarness({ session = { pid: 123, generation: 1 }, direct = 'A123456789012', readThrows = false } = {}) {
  const context = { session, stored: null, direct, readThrows };
  const sessionMonitor = { getState: () => context.session };
  const mainWindow = { webContents: { id: 'main' } };
  const values = {
    sessionMonitor,
    playProfileOffsets: { iidxId: { mode: 'direct', offset: '16', encoding: 'ascii', maxBytes: 32 } },
    PROFILE_OFFSETS: { iidxId: { offset: '8', encoding: 'ascii', maxBytes: 32 } },
    isRemoteStringOffset: (entry) => entry?.mode === 'direct' && entry.offset !== '16',
    readBytes: () => { if (context.readThrows) throw new Error('read failed'); return Buffer.alloc(1); },
    decodeString: () => context.direct,
    StringEncoding: {},
    get playAccountSource() { return context.stored; },
  };
  const getAccount = loadFunction('getPlayAccount', values).fn;
  const setterGlobals = {
    sessionMonitor,
    mainWindow,
    get playAccountSource() { return context.stored; },
    set playAccountSource(value) { context.stored = value; },
  };
  const setAccount = loadFunction('setPlayAccount', setterGlobals).fn;
  context.mainWindow = mainWindow;
  return { context, getAccount, setAccount };
}

test('main direct ID wins without an initial renderer IPC value', () => {
  const { getAccount } = accountHarness();
  assert.equal(getAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), 'A123456789012');
});

test('same-pid renderer ID is used after direct read failure, exception, or invalid value', () => {
  for (const setup of [{ direct: null }, { direct: 'bad' }, { readThrows: true }]) {
    const { context, getAccount, setAccount } = accountHarness(setup);
    assert.equal(setAccount({ sender: context.mainWindow.webContents }, { pid: 123, iidxId: 'B123456789012' }).ok, true);
    assert.equal(getAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), 'B123456789012');
    context.direct = 'C123456789012';
    context.readThrows = false;
    assert.equal(getAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), 'C123456789012');
  }
});

test('set-account rejects other senders, stale pids, and malformed values', () => {
  const { setAccount, context } = accountHarness();
  assert.equal(setAccount({ sender: {} }, { pid: 123, iidxId: 'A123456789012' }).ok, false);
  assert.equal(setAccount({ sender: context.mainWindow.webContents }, { pid: 124, iidxId: 'A123456789012' }).ok, false);
  assert.equal(setAccount({ sender: context.mainWindow.webContents }, { pid: 123, iidxId: 'a123456789012' }).ok, false);
  assert.equal(setAccount({ sender: context.mainWindow.webContents }, { pid: 123.5, iidxId: 'A123456789012' }).ok, false);
  assert.equal(context.stored, null);
});

test('session pid changes before or during direct read block results and lifecycle clears stored IDs', () => {
  const { context, getAccount, setAccount } = accountHarness();
  setAccount({ sender: context.mainWindow.webContents }, { pid: 123, iidxId: 'B123456789012' });
  context.session = { pid: 124, generation: 2 };
  assert.equal(getAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), null);
  context.session = { pid: 123, generation: 3 };
  const readBytes = loadFunction('getPlayAccount', {
    sessionMonitor: { getState: () => context.session },
    playProfileOffsets: { iidxId: { mode: 'direct', offset: '16', encoding: 'ascii', maxBytes: 32 } },
    PROFILE_OFFSETS: { iidxId: { offset: '8', encoding: 'ascii', maxBytes: 32 } },
    isRemoteStringOffset: () => false,
    readBytes: () => { context.session = { pid: 124, generation: 4 }; return Buffer.alloc(1); },
    decodeString: () => 'A123456789012',
  }).fn;
  assert.equal(readBytes({ pid: 123, handle: {}, modBaseAddr: 0n }), null);
  assert.match(indexSource, /sessionMonitor\.on\('start',\s*\(\)\s*=>\s*\{\s*playAccountSource = null;\s*probedGameVersion = null;/);
  assert.match(indexSource, /sessionMonitor\.on\('end',\s*\(\)\s*=>\s*\{\s*playAccountSource = null;\s*probedGameVersion = null;/);
});

test('missing renderer ID and two failed sources return null', () => {
  const { getAccount } = accountHarness({ direct: 'invalid' });
  assert.equal(getAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), null);
});

test('game version is probed once per pid generation and metadata uses real app version', () => {
  let state = { pid: 123, generation: 1 };
  let probes = 0;
  const { fn: getVersion, context } = loadFunction('getPlayGameVersion', {
    sessionMonitor: { getState: () => state },
    probeGameDatecode: () => { probes++; return '2026101700'; },
    probedGameVersion: null,
  });
  assert.equal(getVersion(123), '2026101700');
  assert.equal(getVersion(123), '2026101700');
  assert.equal(probes, 1);
  state = { pid: 123, generation: 2 };
  assert.equal(getVersion(123), '2026101700');
  assert.equal(probes, 2);
  assert.match(indexSource, /appVersion:\s*app\.getVersion\(\)/);
  assert.match(indexSource, /probeGameDatecode/);
  assert.doesNotMatch(indexSource, /probedGameVersion\s*=\s*null;[^\n]*offsets/);
  assert.ok(context);
});
