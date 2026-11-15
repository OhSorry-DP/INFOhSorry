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

function loadSessionHarness() {
  const declarations = new Map(sourceFile.statements
    .filter(ts.isFunctionDeclaration)
    .filter((node) => node.name)
    .map((node) => [node.name.text, node]));
  const extract = (name) => {
    const node = declarations.get(name);
    assert.ok(node, `missing function ${name}`);
    return node.getFullText(sourceFile);
  };
  const getProfileProperty = sourceFile.statements
    .find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(sourceFile) === 'ipcHandlers'))
    ?.declarationList.declarations[0].initializer.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(sourceFile).includes('offsets:getProfile'));
  assert.ok(getProfileProperty, 'missing offsets:getProfile handler');
  const startCalls = [];
  const visitStartCalls = (child) => {
    if (ts.isCallExpression(child) && child.expression.getText(sourceFile) === 'sessionMonitor.on'
      && child.arguments[0]?.getText(sourceFile) === "'start'") startCalls.push(child);
    ts.forEachChild(child, visitStartCalls);
  };
  visitStartCalls(sourceFile);
  const startCall = startCalls.find((call) => call.arguments[1]?.getText(sourceFile).includes('playAccountSource = null'));
  assert.ok(startCall, 'missing session start listener');
  const startCallback = startCall.arguments[1].getText(sourceFile);
  const source = [
    'let profilePreparation = null;',
    'let playProfileOffsets = null;',
    'let playAccountSource = null;',
    'let mainWindow = null;',
    'let probedGameVersion = null;',
    'let abortFinalUpload = null;',
    extract('sameProfileSession'),
    extract('prepareSessionProfile'),
    extract('blockedProfileResult'),
    extract('getPlayAccount'),
    `const offsetsGetProfile = ${getProfileProperty.initializer.getText(sourceFile)};`,
    `const startListener = (${startCallback});`,
    'exports.api = { startListener, getPlayAccount, offsetsGetProfile, getProfilePreparation: () => profilePreparation, getPlayProfileOffsets: () => playProfileOffsets, setPlayAccountSource: value => { playAccountSource = value; } };',
  ].join('\n');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const pending = [];
  const listeners = {};
  const contextState = { session: { pid: 123, generation: 1 }, probes: 0, reads: 0, decodes: 0 };
  const globals = {
    exports: {},
    sessionMonitor: {
      getState: () => contextState.session,
      on: (name, fn) => { listeners[name] = fn; },
    },
    probeGameDatecode: () => { contextState.probes++; return `date-${contextState.session.generation}`; },
    getRemoteProfileOffsets: (session, datecode) => new Promise((resolve) => pending.push({ session, datecode, resolve })),
    PROFILE_OFFSETS: { iidxId: { offset: '8', encoding: 'ascii', maxBytes: 32 } },
    isRemoteStringOffset: (entry) => entry?.mode === 'direct',
    readBytes: () => { contextState.reads++; return Buffer.alloc(1); },
    decodeString: () => { contextState.decodes++; return 'A123456789012'; },
    StringEncoding: {},
    Buffer,
    console,
    pushSessionState: () => {},
    sessionOpChain: Promise.resolve(),
    onSessionStart: () => Promise.resolve(),
  };
  const context = vm.createContext(globals);
  vm.runInContext(compiled, context);
  return {
    api: context.exports.api,
    state: contextState,
    pending,
    start(session) {
      contextState.session = session;
      context.exports.api.startListener(session);
    },
    resolve(index, session, profileLabel) {
      const source = {
        session,
        profile: { iidxId: { mode: 'direct', offset: `remote-${profileLabel}`, encoding: 'ascii', maxBytes: 32 }, marker: profileLabel },
        profilePolicy: 'normal',
        buildVersion: profileLabel,
        confidence: profileLabel,
        gameDatecode: `date-${session.generation}`,
      };
      pending[index].resolve(source);
      return source;
    },
  };
}

function accountHarness({ session = { pid: 123, generation: 1 }, direct = 'A123456789012', readThrows = false } = {}) {
  const context = { session, stored: null, direct, readThrows, policy: { session: { pid: session.pid, generation: session.generation }, state: 'ready', result: { profilePolicy: 'normal' } } };
  const sessionMonitor = { getState: () => context.session };
  const mainWindow = { webContents: { id: 'main' } };
  const values = {
    sessionMonitor,
    sameProfileSession: (a, b) => !!a && !!b && a.pid !== null && a.pid === b.pid && a.generation === b.generation,
    get profilePreparation() { return context.policy; },
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
    profilePreparation: context.policy,
    sameProfileSession: (a, b) => !!a && !!b && a.pid !== null && a.pid === b.pid && a.generation === b.generation,
    playProfileOffsets: { iidxId: { mode: 'direct', offset: '16', encoding: 'ascii', maxBytes: 32 } },
    PROFILE_OFFSETS: { iidxId: { offset: '8', encoding: 'ascii', maxBytes: 32 } },
    isRemoteStringOffset: () => false,
    readBytes: () => { context.session = { pid: 124, generation: 4 }; return Buffer.alloc(1); },
    decodeString: () => 'A123456789012',
  }).fn;
  assert.equal(readBytes({ pid: 123, handle: {}, modBaseAddr: 0n }), null);
  assert.match(indexSource, /sessionMonitor\.on\('start',\s*\(session: ProfileSession\)\s*=>\s*\{\s*playAccountSource = null;\s*probedGameVersion = null;\s*profilePreparation = null;\s*prepareSessionProfile\(session\)/);
  assert.match(indexSource, /sessionMonitor\.on\('end',\s*\(\)\s*=>\s*\{\s*playAccountSource = null;\s*probedGameVersion = null;\s*profilePreparation = null;/);
});

test('missing renderer ID and two failed sources return null', () => {
  const { getAccount } = accountHarness({ direct: 'invalid' });
  assert.equal(getAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), null);
});

test('pending and blocked profile policy prevents direct and renderer ID sources', () => {
  for (const policy of [
    { session: { pid: 123, generation: 1 }, state: 'pending', result: null },
    { session: { pid: 123, generation: 1 }, state: 'ready', result: { profilePolicy: 'blocked' } },
    { session: { pid: 123, generation: 0 }, state: 'ready', result: { profilePolicy: 'normal' } },
  ]) {
    const { context, getAccount, setAccount } = accountHarness();
    context.policy = policy;
    setAccount({ sender: context.mainWindow.webContents }, { pid: 123, iidxId: 'B123456789012' });
    assert.equal(getAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), null);
  }
});

test('generation-only session replacement reprobes and gates account reads while pending', async () => {
  const harness = loadSessionHarness();
  harness.start({ pid: 123, generation: 1 });
  harness.resolve(0, { pid: 123, generation: 1 }, 'A');
  await harness.api.getProfilePreparation().promise;
  assert.equal(harness.api.getProfilePreparation().state, 'ready');
  harness.api.setPlayAccountSource({ pid: 123, iidxId: 'B123456789012' });

  harness.start({ pid: 123, generation: 2 });
  assert.equal(harness.state.probes, 2);
  assert.equal(harness.pending.length, 2);
  assert.equal(harness.api.getProfilePreparation().state, 'pending');
  assert.equal(harness.api.getPlayAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), null);
  assert.equal(harness.state.reads, 0);
  assert.equal(harness.state.decodes, 0);
});

test('late prior-session result is discarded and waiting IPC returns blocked, new IPC returns the replacement profile', async () => {
  const harness = loadSessionHarness();
  const sessionA = { pid: 123, generation: 1 };
  const sessionB = { pid: 123, generation: 2 };
  harness.start(sessionA);
  const ipcFromA = harness.api.offsetsGetProfile();
  harness.start(sessionB);
  const bPreparation = harness.api.getProfilePreparation();
  assert.equal(harness.pending.length, 2);

  harness.resolve(0, sessionA, 'A');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(bPreparation.state, 'pending');
  assert.equal(harness.api.getPlayProfileOffsets(), null);

  const expectedB = harness.resolve(1, sessionB, 'B');
  await bPreparation.promise;
  const ipcResult = await ipcFromA;
  assert.equal(bPreparation.state, 'ready');
  assert.equal(harness.api.getPlayProfileOffsets().marker, 'B');
  assert.notEqual(ipcResult.profile.marker, 'A');
  assert.notEqual(ipcResult.buildVersion, 'A');
  assert.equal(ipcResult.profilePolicy, 'blocked');
  for (const key of ['iidxId', 'djName', 'radar', 'dan', 'spRank', 'dpRank']) {
    assert.equal(ipcResult.profile[key], null);
  }
  const ipcFromB = await harness.api.offsetsGetProfile();
  assert.equal(ipcFromB.profile.marker, 'B');
  assert.equal(ipcFromB.buildVersion, 'B');
  assert.equal(expectedB.profile.marker, 'B');
});

test('constants-only matching policy permits existing direct and renderer ID reads', () => {
  const { context, getAccount, setAccount } = accountHarness({ readThrows: true });
  context.policy.result.profilePolicy = 'constants-only';
  setAccount({ sender: context.mainWindow.webContents }, { pid: 123, iidxId: 'B123456789012' });
  assert.equal(getAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), 'B123456789012');
  context.readThrows = false;
  assert.equal(getAccount({ pid: 123, handle: {}, modBaseAddr: 0n }), 'A123456789012');
});

test('session start independently begins profile preparation and end invalidates it', () => {
  assert.match(indexSource, /sessionMonitor\.on\('start',[\s\S]*?prepareSessionProfile\(session\)/);
  assert.match(indexSource, /sessionMonitor\.on\('end',[\s\S]*?profilePreparation = null/);
  assert.match(indexSource, /function prepareSessionProfile\(session: ProfileSession\)[\s\S]*?probeGameDatecode\(\)[\s\S]*?getRemoteProfileOffsets\(preparation\.session, datecode\)/);
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
