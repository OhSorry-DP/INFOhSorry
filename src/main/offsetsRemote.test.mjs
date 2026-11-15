import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
function load(source, dependencies = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
    return dependencies[name];
  }, Buffer, structuredClone, ...globals });
  return exports;
}
const datecodeNum = load(read('./gameBuild.ts'), { './memory': {} }).datecodeNum;
const source = read('./offsetsRemote.ts');
const profileConstants = load(read('../shared/profileOffsets.ts'), {});
const defaults = { log: { markerScanFromJudge:144, markerDelta:24, settingsStateDelta:0x18, p2SettingsDelta:0x48, battleFlagDelta:0x28, gaugeWordP1:77, gaugeWordP2:78, playSpeedFromSettings:0x17a0, laneOrderP1FromSettings:0x37cc, laneOrderP2FromSettings:0x37ec, songStride:0x730, songIdOffset:0x5b0, songNoteOffset:0x370 }, detail: { laneWordsP1:3448385, laneWordsP2:3452299 } };

function harness({ response, fail = false, failImmediate = false, datecode = '2026111100', cachedDatecode = '2026111100' } = {}) {
  const urls = [];
  let finish;
  const fetch = url => { urls.push(url); if (failImmediate) return Promise.reject(new Error('offline')); return new Promise((resolve, reject) => { finish = () => fail ? reject(new Error('offline')) : resolve({ ok: true, json: async () => response }); }); };
  let gameDatecodeCalls = 0;
  const api = load(source, { './gameBuild': { getGameDatecode: () => { gameDatecodeCalls++; return cachedDatecode; }, datecodeNum }, '../shared/profileOffsets': profileConstants }, { fetch, Date, console: { warn() {} } });
  return { api, urls, finish: () => finish(), datecode, gameDatecodeCalls: () => gameDatecodeCalls };
}

test('defaults agree with current play logger constants', () => {
  const log = read('./playLog.ts');
  const detail = read('./playDetail.ts');
  const numeric = v => typeof v === 'number' ? `(?:${v}|0x${v.toString(16)})` : String(v);
  for (const [key, value] of Object.entries(defaults.log)) assert.match(log, new RegExp(`${key}:\\s*${key.startsWith('laneOrder') ? `0x${value.toString(16)}` : numeric(value)}\\b`, 'i'));
  for (const [key, value] of Object.entries(defaults.detail)) assert.match(detail, new RegExp(`${key}:\\s*${value}\\b`));
});

test('unstarted request is ready; started request waits, exact and first datecode match', async () => {
  const response = { version: 'x', builds: [{ version:'P2D:J:B:A:2026111100',playLogger:{log:{markerDelta:28}} }, { version:'2026111100',playLogger:{log:{markerDelta:32}} }] };
  const h = harness({ response });
  assert.equal(h.api.selectPlayLoggerLayout('2026111100', 0, 0).state, 'ready');
  assert.equal(h.api.selectPlayLoggerLayout('2026111100', 0, 0).defaults[0].reason, 'remote-unavailable');
  h.api.startPlayLoggerOffsetsPreparation();
  assert.equal(h.api.selectPlayLoggerLayout('2026111100', 0, 999).state, 'waiting');
  assert.equal(h.urls.length, 1);
  h.finish(); await h.api.getRemoteOffsets();
  const selected = h.api.selectPlayLoggerLayout('P2D:J:B:A:2026111100', 0, 1000);
  assert.equal(selected.layout.log.markerDelta, 28);
  assert.equal(h.api.selectPlayLoggerLayout('0', 0, 1000).defaults[0].reason, 'version-unavailable');
  assert.equal(h.api.selectPlayLoggerLayout('2026101400', 0, 1000).defaults[0].reason, 'build-not-found');
});

test('omission defaults, explicit null, types, ranges, combinations, and unknown keys', async () => {
  const cases = [
    [{}, 'ready'], [{ log: null }, 'blocked'], [{ log: { markerDelta: null } }, 'blocked'],
    [{ log: { markerDelta: '24' } }, 'blocked'], [{ log: { markerDelta: 3 } }, 'blocked'],
    [{ log: { songStride: 4 } }, 'blocked'], [{ custom: { foo: 1 }, log: { custom: 2 } }, 'ready'],
  ];
  for (const [playLogger, state] of cases) {
    const h = harness({ response: { version:'x', builds:[{ version:'2026111100', playLogger }] } });
    h.api.startPlayLoggerOffsetsPreparation(); h.finish(); await h.api.getRemoteOffsets();
    const selection = h.api.selectPlayLoggerLayout('2026111100', 0, 1000);
    assert.equal(selection.state, state);
    if (playLogger.custom) assert.deepEqual(Array.from(selection.unknownKeys), ['playLogger.custom', 'playLogger.log.custom']);
  }
});

test('deadline defaults and late success populate shared cache; failure settles immediately', async () => {
  const h = harness({ response:{version:'x',builds:[{version:'2026111100',playLogger:{log:{markerDelta:28}}}]} });
  h.api.startPlayLoggerOffsetsPreparation();
  const timed = h.api.selectPlayLoggerLayout('2026111100', 10, 1010);
  assert.equal(timed.timedOut, true); assert.equal(timed.layout.log.markerDelta, 24);
  h.finish(); await h.api.getRemoteOffsets();
  assert.equal(h.api.selectPlayLoggerLayout('2026111100', 2000, 2001).layout.log.markerDelta, 28);
  const failed = harness({ fail:true }); failed.api.startPlayLoggerOffsetsPreparation(); failed.finish(); await failed.api.getRemoteOffsets();
  assert.equal(failed.api.selectPlayLoggerLayout('2026111100', 0, 1).defaults[0].reason, 'remote-unavailable');
});

test('requests only the configured gist URL and preserves existing resolver/profile behavior', async () => {
  const h = harness({ response:{version:'x',builds:[{version:'P2D:J:B:A:2026111100',profile:{djName:null}}]} });
  h.api.startPlayLoggerOffsetsPreparation(); h.finish(); await h.api.getRemoteOffsets();
  assert.equal(h.urls.length, 1); assert.match(h.urls[0], /^https:\/\/gist\.githubusercontent\.com\/OhSorry-DP\/b586710a7a6efc3a245da2c85db8d1f2\/raw\/offsets\.json\?t=/);
  assert.equal((await h.api.resolveBuild()).confidence, 'matched');
  const profileResult = await h.api.getRemoteProfileOffsets();
  assert.equal(profileResult.profile.djName, null);
  assert.equal(profileResult.buildVersion, 'P2D:J:B:A:2026111100');
  assert.equal(profileResult.confidence, 'matched');
});

async function profileHarness(response, gameDatecode, session = { pid: 1234, generation: 1 }, cachedDatecode = '2026111100') {
  const h = harness({ response, gameDatecode, cachedDatecode });
  h.api.startPlayLoggerOffsetsPreparation(); h.finish(); await h.api.getRemoteOffsets();
  return { h, result: await h.api.getRemoteProfileOffsets(session, gameDatecode) };
}

async function unavailableProfileHarness(gameDatecode, session = { pid: 1234, generation: 1 }, cachedDatecode = '2026111100', constants = profileConstants) {
  const h = harness({ fail: true, failImmediate: true, gameDatecode, cachedDatecode });
  if (constants === profileConstants) return { h, result: await h.api.getRemoteProfileOffsets(session, gameDatecode) };
  const api = load(source, { './gameBuild': { getGameDatecode: () => cachedDatecode, datecodeNum }, '../shared/profileOffsets': constants }, { fetch: async () => { throw new Error('offline'); }, Date, console: { warn() {} } });
  return { h, result: await api.getRemoteProfileOffsets(session, gameDatecode) };
}

test('gist unavailable with matching constants build returns explicit constants-only map', async () => {
  const { result } = await unavailableProfileHarness('P2D:J:B:A:2026111100');
  assert.equal(result.profilePolicy, 'constants-only');
  assert.deepEqual(JSON.parse(JSON.stringify(result.profile)), JSON.parse(JSON.stringify({ iidxId: profileConstants.PROFILE_OFFSETS.iidxId, djName: profileConstants.PROFILE_OFFSETS.djName, radar: profileConstants.PROFILE_NUMERIC_OFFSETS.radar ?? null, dan: profileConstants.PROFILE_NUMERIC_OFFSETS.dan ?? null, spRank: null, dpRank: null })));
  assert.equal(result.confidence, null); assert.equal(result.buildVersion, null);
  assert.deepEqual(result.session, { pid:1234, generation:1 }); assert.equal(result.gameDatecode, 'P2D:J:B:A:2026111100');
});

test('gist unavailable with explicit null datecode preserves normal null profile and blocks invalid session', async () => {
  const { h, result } = await unavailableProfileHarness(null);
  assert.equal(result.profilePolicy, 'normal'); assert.equal(result.profile, null);
  assert.equal(result.confidence, null); assert.equal(result.buildVersion, null);
  assert.deepEqual(result.session, { pid:1234, generation:1 }); assert.equal(result.gameDatecode, null);
  assert.equal(h.gameDatecodeCalls(), 0);
  const invalid = await h.api.getRemoteProfileOffsets({ pid:null, generation:0 }, null);
  assert.equal(invalid.profilePolicy, 'blocked');
  assert.deepEqual(JSON.parse(JSON.stringify(invalid.profile)), { iidxId:null, djName:null, radar:null, dan:null, spRank:null, dpRank:null });
  assert.equal(invalid.confidence, null); assert.equal(invalid.buildVersion, null);
  assert.deepEqual(invalid.session, { pid:null, generation:0 }); assert.equal(invalid.gameDatecode, null);
});

test('gist unavailable with a different valid measured build blocks all profile keys', async () => {
  const { result } = await unavailableProfileHarness('2026101400');
  assert.equal(result.profilePolicy, 'blocked');
  assert.deepEqual(JSON.parse(JSON.stringify(result.profile)), { iidxId:null, djName:null, radar:null, dan:null, spRank:null, dpRank:null });
  assert.equal(result.confidence, null); assert.equal(result.buildVersion, null);
  assert.deepEqual(result.session, { pid:1234, generation:1 }); assert.equal(result.gameDatecode, '2026101400');
});

test('gist unavailable treats matching parse failures as blocked', async () => {
  const invalidConstants = { ...profileConstants, PROFILE_OFFSETS: { ...profileConstants.PROFILE_OFFSETS, refluxVersion: 'invalid' } };
  const { result } = await unavailableProfileHarness('invalid', { pid:1234, generation:1 }, '2026111100', invalidConstants);
  assert.equal(result.profilePolicy, 'blocked');
  assert.deepEqual(JSON.parse(JSON.stringify(result.profile)), { iidxId:null, djName:null, radar:null, dan:null, spRank:null, dpRank:null });
  assert.equal(result.confidence, null); assert.equal(result.buildVersion, null);
  assert.deepEqual(result.session, { pid:1234, generation:1 }); assert.equal(result.gameDatecode, 'invalid');
});

test('latest constants match selects explicit constants-only map', async () => {
  const { result } = await profileHarness({ version:'x', builds:[{version:'2026101400', profile:{iidxId:null}}] }, 'P2D:J:B:A:2026111100');
  assert.equal(result.confidence, 'latest'); assert.equal(result.profilePolicy, 'constants-only');
  assert.deepEqual(JSON.parse(JSON.stringify(result.profile)), JSON.parse(JSON.stringify({ iidxId: profileConstants.PROFILE_OFFSETS.iidxId, djName: profileConstants.PROFILE_OFFSETS.djName, radar: profileConstants.PROFILE_NUMERIC_OFFSETS.radar, dan: profileConstants.PROFILE_NUMERIC_OFFSETS.dan, spRank: null, dpRank: null })));
  assert.deepEqual(result.session, {pid:1234,generation:1}); assert.equal(result.gameDatecode, 'P2D:J:B:A:2026111100');
});

test('latest constants mismatch is blocked with six explicit nulls', async () => {
  const { result } = await profileHarness({ version:'x', builds:[{version:'2026111100', profile:{djName:{offset:'0x1',encoding:'utf8'}}}] }, '2026101400');
  assert.equal(result.profilePolicy, 'blocked');
  assert.deepEqual(JSON.parse(JSON.stringify(result.profile)), { iidxId:null, djName:null, radar:null, dan:null, spRank:null, dpRank:null });
});

test('matched profile keeps normal policy and selected map', async () => {
  const profile = {djName:{offset:'0x1',encoding:'utf8'}};
  const { result } = await profileHarness({ version:'x', builds:[{version:'2026111100', profile}] }, '2026111100');
  assert.equal(result.profilePolicy, 'normal'); assert.deepEqual(result.profile, profile);
});

test('explicit null datecode is blind and keeps latest selected map', async () => {
  const profile = {djName:{offset:'0x1',encoding:'utf8'}};
  const { result } = await profileHarness({ version:'x', builds:[{version:'2026111100', profile}] }, null);
  assert.equal(result.confidence, 'blind'); assert.equal(result.profilePolicy, 'normal'); assert.deepEqual(result.profile, profile);
});

test('legacy profile keeps normal policy and top-level map', async () => {
  const profile = {iidxId:{offset:'0x2',encoding:'utf8'}};
  const { result } = await profileHarness({ version:'legacy', profile }, '2026111200');
  assert.equal(result.confidence, 'legacy'); assert.equal(result.profilePolicy, 'normal'); assert.deepEqual(result.profile, profile);
});

test('explicit null excludes cached datecode while implicit resolver keeps cache behavior', async () => {
  const h = harness({ response:{version:'x',builds:[{version:'2026111100',profile:{djName:null}}]}, cachedDatecode:'2026111100' });
  h.api.startPlayLoggerOffsetsPreparation(); h.finish(); await h.api.getRemoteOffsets();
  const blind = await h.api.resolveBuild(null);
  assert.equal(blind.confidence, 'blind'); assert.equal(blind.gameDatecode, null);
  const cached = await h.api.resolveBuild();
  assert.equal(cached.confidence, 'matched'); assert.equal(cached.gameDatecode, '2026111100');
});
