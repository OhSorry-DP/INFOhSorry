import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const source = read('./supabaseSync.ts');
const compile = sourceText => ts.transpileModule(`${sourceText}\nexports.__scoreHistoryMemos = [dayMemo, instantMemo]; exports.__filterScoreHistoryRows = filterScoreHistoryRows;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const fastDumpCode = compile(source);
const slowDumpCode = compile(source.replace('const FAST_DUMP_ENQUEUE_INF = true;', 'const FAST_DUMP_ENQUEUE_INF = false;'));
function load(fetchImpl, dateImpl = Date, options = {}) {
  const exports = {};
  vm.runInNewContext(options.fastDump === false ? slowDumpCode : fastDumpCode, { exports, require: name => {
    if (name === './dbr-history') return {};
    if (name === './diagLog') return { addDiagLine: options.addDiagLine ?? (() => {}) };
    if (name === '../../shared/dataSource') return { DATA_BASE: 'https://fixture.invalid/data' };
    if (name === '../../shared/match') return { norm: x => String(x).toLowerCase(), slotToDiff: x => x };
    if (name === '../../shared/uploadSnapshot') return { PLAY_CSV_KEYS: [], PLAY_CSV_LEGACY_KEYS: [], buildPlayErrorRow() {}, isPlayErrorRow() { return false; } };
    return {};
  }, fetch: fetchImpl, Date: dateImpl, URL, crypto: options.crypto ?? { randomUUID: () => '00000000-0000-4000-8000-000000000001' }, AbortController,
    setTimeout: options.setTimeout ?? setTimeout, clearTimeout: options.clearTimeout ?? clearTimeout,
    localStorage: options.localStorage ?? { getItem: () => null, setItem() {}, removeItem() {} },
    window: { infohsorry: { serviceStatus: { get: async () => ({ uploadEnabled: true }) } } }, console: options.console ?? { warn() {}, log() {} }, Map, Set, BigInt, JSON, Math, Number, String, Object, Array, Promise, Error, TypeError });
  return exports;
}
const plain = x => JSON.parse(JSON.stringify(x));
const hist = [[7,3,5,100,33,'2026-10-19T00:00:00Z','2026-10-19',1,20,100],
  [7,3,6,120,34,'2026-10-20T00:00:00Z','2026-10-20',1,10,100]];
const user = { _v: '2026-10-20T01:00:00Z', user: { iidx_id: 'C123' }, dp: [{ song_id: 7, diff: 3, lamp: 6,
  ex_score: 120, played_version: 34, date: '2026-10-20T00:00:00Z', bp: 10, note_count: 100 }], sp: [] };
function fixture(fetchImpl) { return async url => {
  if (url.endsWith('/hist/C123.json') || url.endsWith('/hist/A.json') || url.endsWith('/hist/B.json')) return fetchImpl(url, 'hist');
  if (url.endsWith('/user/C123.json') || url.endsWith('/user/A.json') || url.endsWith('/user/B.json')) return fetchImpl(url, 'user');
  if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => [7,8,9,10,11].map(song_id => ({ song_id, title: 'Fixture Song', ac: 2, legen: 0, textage_song_id: 'tx7' })) };
  if (url.includes('textage-meta')) return { ok: true, status: 200, json: async () => ({ songs: {} }) };
  throw Error(`unexpected ${url}`);
}; }
const pagedSongs = url => {
  const parsed = new URL(url);
  const limit = Number(parsed.searchParams.get('limit'));
  const offset = Number(parsed.searchParams.get('offset'));
  return Array.from({ length: Math.max(0, Math.min(limit, 1001 - offset)) }, (_, i) => {
    const songId = offset + i + 1;
    return { song_id: songId, title: `song${songId - 1}`, ac: 2, legen: 0 };
  });
};

function fakeClock() {
  let now = 0, nextId = 1;
  const timers = new Map();
  class ClockDate extends Date { static now() { return now; } }
  return {
    Date: ClockDate,
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advanceToNext() {
      if (!timers.size) return false;
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id); now = timer.at; timer.callback(); return true;
    },
    advanceBy(milliseconds) { now += milliseconds; },
    get now() { return now; },
  };
}
async function runTimedDump({ authHang, storedToken = null, sessionReplies = [], relay = 'accepted', addDiagLine = () => {}, noUuid = false, authLatency = 0 } = {}) {
  const clock = fakeClock(), calls = [], signals = [], storage = new Map(storedToken ? [['ohsorry:remoteAuthToken', storedToken]] : []);
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const hang = async stage => new Promise((_resolve, reject) => {
      signals.push(options.signal);
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
    });
    if (url.includes('/hist/')) return { ok: true, status: 200, json: async () => [] };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => [{ song_id: 1, title: 'song0', ac: 2, legen: 0 }] };
    if (url.includes('/rpc/upsert_user_upload_profile') || url.includes('/rpc/upsert_user_radar') || url.includes('/rpc/upsert_scores')) return { ok: true, status: 200 };
    const endpoint = ['/auth/issue', '/auth/exchange', '/auth/session'].find(path => url.endsWith(path));
    if (endpoint) {
      if (authLatency) await new Promise(resolve => clock.setTimeout(resolve, authLatency));
      const stage = endpoint === authHang?.endpoint ? authHang.stage : null;
      if (stage === 'fetch') await hang(stage);
      if (endpoint === '/auth/issue') return { ok: true, status: 200, json: async () => {
        if (stage === 'body') return hang(stage);
        return { url: 'https://iidx.in/?ticket=fixture-ticket-secret' };
      } };
      if (endpoint === '/auth/exchange') return { ok: true, status: 200, json: async () => {
        if (stage === 'body') return hang(stage);
        return { token: 'fixture-new-token-secret' };
      } };
      const reply = sessionReplies.shift() ?? { logged_in: true, iidx_id: 'K123' };
      const status = reply.status ?? 200;
      return { ok: status < 400, status, json: async () => {
        if (stage === 'body') return hang(stage);
        return reply.data ?? { logged_in: true, iidx_id: 'K123' };
      } };
    }
    if (url.includes('dump-trigger')) {
      if (relay === 'body-hang') return { ok: true, status: 200, json: () => hang('body') };
      if (relay === 'hang') return hang('fetch');
      if (relay === '4xx') return { ok: false, status: 429 };
      if (relay === 'rejected') return { ok: true, status: 200, json: async () => ({ accepted: false }) };
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    }
    throw Error(`unexpected URL ${url}`);
  };
  const api = load(fetch, clock.Date, {
    fastDump: true, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, addDiagLine,
    crypto: noUuid ? {} : undefined,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  const promise = api.uploadProfile({ appVersion: 'test', profile: { iidxId: 'K123' }, starResult: null,
    charts: [{ title: 'song0', slot: 'DPA', diff: 'ANOTHER', exScore: 120, lamp: 'HC' }], allTsvCharts: [], spCharts: [], dpAllCharts: [] });
  for (let i = 0; i < 100; i++) {
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    if ((signals.length > 0 || authLatency > 0) && !clock.advanceToNext()) continue;
  }
  const result = await promise;
  return { result, calls, signals, storage, clock };
}

test('user dp는 song 메타와 결합되고 sp 동명행은 제외', async () => {
  const api = load(fixture(async (_url, kind) => ({ ok: true, status: 200, json: async () => kind === 'user' ? { ...user, dp: user.dp, sp: [{ ...user.dp[0], ex_score: 999 }] } : hist })));
  const idx = plain([...await api.fetchUserLatestCharts('C123')]);
  assert.equal(idx.length, 1); assert.equal(idx[0][0], 'fixture song|ANOTHER'); assert.equal(idx[0][1].exScore, 120);
});

test('hist는 원순서 PREV·33→34만 이월하고 SP·DBR 및 32→34·INF 이월을 제외', async () => {
  const rows = [...hist, [8,3,2,80,32,'2026-10-18T00:00:00Z','2026-10-18',1,2,20],
    [8,3,4,90,34,'2026-10-20T02:00:00Z','2026-10-20',1,1,20], [9,3,2,50,0,'2026-10-19T00:00:00Z','2026-10-19',1,3,30],
    [9,3,4,60,0,'2026-10-20T00:00:00Z','2026-10-20',1,2,30], [10,3,2,60,-10,'2026-10-20T00:00:00Z','2026-10-20',1,3,30],
    [11,3,2,60,34,'2026-10-20T00:00:00Z','2026-10-20',0,3,30]];
  const api = load(fixture(async (_url, kind) => ({ ok: true, status: 200, json: async () => kind === 'user' ? user : rows })));
  const got = plain(await api.fetchRecentCharts('C123', '2026-10-20'));
  assert.equal(got.length, 3); assert.equal(got[0].prevExScore, 100); assert.equal(got[0].prevPlayedVersion, 33);
  assert.equal(got[1].prevExScore, null); assert.equal(got[2].prevExScore, 50);
});

test('8/10열 미상은 허용하고 404는 빈 값, 500·형식 오류는 실패하며 scores RPC 없음', async () => {
  const calls = [];
  const api = load(async url => { calls.push(url); if (url.includes('/hist/')) return { ok: true, status: 200, json: async () => [[7,3,5,100,33,'d','2026-10-19',1]] };
    if (url.includes('/user/')) return { ok: true, status: 200, json: async () => user };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => [] };
    throw Error(url); });
  assert.deepEqual(plain(await api.fetchRecentDates('C123')), [{ date_kst: '2026-10-19', row_count: 1 }]);
  assert.equal(calls.some(url => url.includes('/rpc/')), false);
  const missing = load(async () => ({ ok: false, status: 404 })); assert.deepEqual(plain(await missing.fetchRecentDates('C123')), []);
  const failed = load(async url => ({ ok: false, status: url.includes('/hist/') ? 500 : 404 }));
  await assert.rejects(failed.fetchRecentDates('C123'), /HTTP 500/);
  const malformed = load(async url => ({ ok: true, status: 200, json: async () => url.includes('/hist/') ? { rows: [] } : user }));
  await assert.rejects(malformed.fetchRecentDates('C123'), /invalid format/);
});

test('계정별 캐시 격리 및 TTL 만료 후 재조회', async () => {
  let now = 0, count = 0;
  class ClockDate extends Date { static now() { return now; } }
  const api = load(async url => { count++; return { ok: true, status: 200, json: async () => url.includes('/hist/') ? [[7,3,5,100,33,'d','2026-10-19',1]] : user }; }, ClockDate);
  await api.fetchRecentDates('A'); await api.fetchRecentDates('A'); await api.fetchRecentDates('B'); assert.equal(count, 4);
  now = 61_000;
  await api.fetchRecentDates('A'); assert.equal(count, 6);
});

test('업로드 users payload 공식값 제외와 1001행 실패 전파, INF 0 유지', async () => {
  assert.match(source, /p_star:\s*null/);
  const profileRpc = source.indexOf('/rpc/upsert_user_upload_profile');
  assert.ok(profileRpc >= 0);
  assert.doesNotMatch(source.slice(source.indexOf('body: JSON.stringify({', profileRpc), source.indexOf('}),\n    });', profileRpc)), /p_(?:sp_cpi|sp_star|r_star):/);
  assert.match(source, /played_version:\s*PLAYED_VERSION_INF/);
  assert.match(source, /SCORE_UPSERT_CHUNK_SIZE = 1000/);
  assert.match(source, /SCORE_UPSERT_CHUNK_SIZE = 1000[\s\S]*?scoreRows\.slice\(i \* SCORE_UPSERT_CHUNK_SIZE, \(i \+ 1\) \* SCORE_UPSERT_CHUNK_SIZE\)/);
  await testUploadProfileRealCall();
  assert.match(source, /return \{ ok: false, error: `scores chunk \$\{i \+ 1\}\/\$\{total\} HTTP \$\{chartRes\.status\}/);
});

async function testUploadProfileRealCall() {
  const hist = [[100,3,5,2100,0,'2026-10-23T01:02:03.123457+00:00','2026-10-23',1,null,1500]];
  const profile = { iidxId: '893-88691', djName: 'fixture', spRadar: null, dpRadar: null };
  const row = (id, ex = 2100) => ({ song_id: id, diff: 3, lamp: 5, ex_score: ex, played_version: 0,
    date: '2026-10-23T01:02:03.123457+00:00', play_style: 1, bp: 0, note_count: 1500 });
  const run = async ({ histReply, scoreStatus = 200, count = 1 } = {}) => {
    const calls = [];
    const songs = count === 1 ? [{ song_id: 100, title: 'song0', ac: 2, legen: 0 }]
      : Array.from({ length: count }, (_, i) => ({ song_id: i + 100, title: `song${i}`, ac: 2, legen: 0 }));
    const fetch = async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.includes('/hist/')) return histReply ?? { ok: true, status: 200, json: async () => hist };
      if (new URL(url).pathname === '/rest/v1/rpc/upsert_user_upload_profile') return { ok: true, status: 200, json: async () => null };
      if (url.includes('/rpc/upsert_user_radar')) return { ok: true, status: 200, json: async () => null };
      if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => songs };
      if (url.includes('/rpc/upsert_scores')) return { ok: scoreStatus === 200, status: scoreStatus, text: async () => 'fail' };
      throw Error(url);
    };
    const charts = Array.from({ length: count }, (_, i) => ({ title: count === 1 ? 'song0' : `song${i}`, slot: 'DPA', diff: 'ANOTHER',
      exScore: 2100, lamp: 'HC', missCount: 0, noteCount: 1500 }));
    class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-23T01:02:03.123Z'])); } }
    const api = load(fetch, FixtureDate);
    const result = await api.uploadProfile({ appVersion: 'fixture', profile, starResult: null, charts,
      allTsvCharts: [], spCharts: [], dpAllCharts: [] });
    return { calls, result };
  };
  let out = await run({ histReply: { ok: true, status: 200, json: async () => [[100,3,5,2200,0,'2026-10-23T01:02:03.123000Z','2026-10-23',1,null,1500]] } });
  assert.equal(out.calls.filter(c => c.url.includes('/rpc/upsert_scores')).length, 0);
  const profileCall = out.calls.find(c => new URL(c.url).pathname === '/rest/v1/rpc/upsert_user_upload_profile');
  assert.equal(profileCall, undefined);
  out = await run({ histReply: { ok: true, status: 200, json: async () => [] } });
  const changedProfileCall = out.calls.find(c => c.url.includes('/rpc/upsert_user_upload_profile'));
  assert.deepEqual(Object.keys(JSON.parse(changedProfileCall.opts.body)).sort(), ['p_dj_name', 'p_dp_rank', 'p_ereter_star', 'p_iidx_id', 'p_sp_rank', 'p_star'].sort());
  assert.equal(JSON.parse(out.calls.find(c => c.url.includes('/rpc/upsert_scores')).opts.body).p_rows.length, 1);
  out = await run({ histReply: { ok: false, status: 404 } });
  assert.equal(JSON.parse(out.calls.find(c => c.url.includes('/rpc/upsert_scores')).opts.body).p_rows.length, 1);
  for (const histReply of [
    { ok: false, status: 500 },
    { ok: true, status: 200, json: async () => { throw Error('bad json'); } },
    { ok: true, status: 200, json: async () => ({ scores: [], history: [], updatedAt: '2026-10-23T02:00:00Z', v: 1 }) },
    { ok: true, status: 200, json: async () => [[100,3,5,2000,33,'bad-date','2026-10-22',1,null,1500]] },
  ]) {
    out = await run({ histReply });
    assert.equal(JSON.parse(out.calls.find(c => c.url.includes('/rpc/upsert_scores')).opts.body).p_rows.length, 1);
  }
  const bulkFetch = async (url, opts = {}) => {
    if (url.includes('/hist/')) return { ok: true, status: 200, json: async () => [] };
    if (url.includes('/rpc/upsert_user')) return { ok: true, status: 200 };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200,
      json: async () => Array.from({ length: 20 }, (_, i) => ({ song_id: i + 100, title: `song${i}`, ac: 2, legen: 0 })) };
    if (url.includes('/rpc/upsert_scores')) { bulkCalls.push(JSON.parse(opts.body).p_rows.length); return { ok: false, status: 500, text: async () => 'fixture failure' }; }
    throw Error(url);
  };
  const bulkCalls = [];
  const bulkApi = load(bulkFetch, class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-23T01:02:03Z'])); } });
  const bulkResult = await bulkApi.uploadProfile({ appVersion: 'fixture', profile, starResult: null,
    charts: Array.from({ length: 20 }, (_, i) => ({ title: `song${i}`, slot: 'DPA', diff: 'ANOTHER', exScore: 2100, lamp: 'HC', missCount: 0, noteCount: 1500 })),
    allTsvCharts: [], spCharts: [], dpAllCharts: [] });
  assert.deepEqual(bulkCalls, [20]);
  assert.equal(bulkResult.ok, false);
  assert.match(bulkResult.error, /scores chunk 1\/1 HTTP 500/);
}

function uploadScenario({ remote = [], failure = null, completion = 'rejected' } = {}) {
  const calls = [], diagnostics = [];
  const state = { remote, failure, completion, date: '2026-10-23T01:02:03Z' };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [state.date])); } }
  const api = load(async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    if (url.includes('/hist/')) return typeof state.remote === 'number'
      ? { ok: false, status: state.remote }
      : { ok: true, status: 200, json: async () => state.remote };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => pagedSongs(url) };
    if (url.includes('/rpc/')) {
      const fail = state.failure?.(url, body);
      return { ok: !fail, status: fail ? 500 : 200, text: async () => 'fixture failure' };
    }
    if (url.endsWith('/auth/issue')) return { ok: true, json: async () => ({ url: 'https://iidx.in/?ticket=test' }) };
    if (url.endsWith('/auth/exchange')) return { ok: true, json: async () => ({ token: 'test' }) };
    if (url.endsWith('/auth/session')) return { ok: true, json: async () => ({ logged_in: true, iidx_id: currentId.replace(/-/g, '') }) };
    if (url.includes('dump-trigger')) {
      if (state.completion === 'network') throw Error('offline');
      return { ok: true, status: 200, json: async () => ({ accepted: state.completion !== 'rejected' }) };
    }
    throw Error(url);
  }, FixedDate, { addDiagLine: line => diagnostics.push(line) });
  let currentId = 'C123';
  const chart = (index = 0, extra = {}) => ({ title: `song${index}`, slot: 'DPA', diff: 'ANOTHER', exScore: 120, lamp: 'HC', ...extra });
  const run = (extra = {}) => {
    currentId = extra.profile?.iidxId ?? 'C123';
    return api.uploadProfile({ appVersion: 'test', profile: { iidxId: currentId, spRadar: { notes: 1 }, dpRadar: { notes: 2 } },
      starResult: null, charts: [chart()], allTsvCharts: [], spCharts: [], dpAllCharts: [], ...extra });
  };
  const writes = () => calls.filter(c => c.url.includes('/rpc/') || c.url.includes('/auth/') || c.url.includes('dump-trigger'));
  return { state, calls, diagnostics, chart, run, writes };
}

test('무변경과 날짜·프로필·plays 변경은 모든 쓰기와 인증을 생략', async () => {
  for (const ex of [120, 130]) {
    const f = uploadScenario({ remote: [[1,3,5,ex,0,'2026-10-22T01:00:00Z','2026-10-22',1,0,100]] });
    assert.equal((await f.run({ plays: [], profile: { iidxId: 'C123', djName: 'changed' } })).ok, true);
    assert.deepEqual(f.writes(), []);
  }
});

test('stale·빈·404·500·손상 R2에서도 동일 입력 세 번은 한 번만 전송', async () => {
  for (const remote of [[], [[1,3,4,100,0,'2026-10-22T01:00:00Z','2026-10-22',1,null,null]], 404, 500,
    [[1,3]], [[1,3,5,120,0,'bad','2026-10-22',1,null,null]]]) {
    const f = uploadScenario({ remote });
    for (let i = 0; i < 3; i++) assert.equal((await f.run()).ok, true);
    assert.equal(f.calls.filter(c => c.url.includes('/rpc/upsert_scores')).length, 1);
    f.state.remote = [[1,3]];
    await f.run();
    assert.equal(f.calls.filter(c => c.url.includes('/rpc/upsert_scores')).length, 1);
  }
});

test('성공 직후 EX·lamp·채보·SP·DP·계정 변경은 시간 진행 없이 전송', async () => {
  const f = uploadScenario();
  const inputs = [{}, { charts: [f.chart(0, { exScore: 121 })] },
    { charts: [f.chart(0, { exScore: 121, lamp: 'EX' })] },
    { charts: [f.chart(1)] }, { charts: [], spCharts: [f.chart(0, { slot: 'ANOTHER', level: 12 })] },
    { charts: [f.chart(2)] }, { profile: { iidxId: 'B' } }];
  for (const input of inputs) {
    const before = f.calls.filter(c => c.url.includes('/rpc/upsert_scores')).length;
    assert.equal((await f.run(input)).ok, true);
    assert.equal(f.calls.filter(c => c.url.includes('/rpc/upsert_scores')).length, before + 1);
  }
});

test('프로필과 첫·후속 1001행 청크 실패는 성공 이력을 확정하지 않음', async () => {
  for (const stage of ['profile', 'first', 'second']) {
    let chunks = 0;
    const f = uploadScenario({ failure: url => stage === 'profile' ? url.includes('upsert_user_upload_profile')
      : url.includes('upsert_scores') && ++chunks === (stage === 'first' ? 1 : 2) });
    const input = { charts: Array.from({ length: 1001 }, (_, i) => f.chart(i)) };
    assert.equal((await f.run(input)).ok, false);
    f.state.failure = null;
    const start = f.calls.length;
    assert.equal((await f.run(input)).ok, true);
    assert.deepEqual(f.calls.slice(start).filter(c => c.url.includes('upsert_scores')).map(c => c.body.p_rows.length), [1000, 1]);
    const end = f.writes().length;
    await f.run(input);
    assert.equal(f.writes().length, end);
  }
});

test('미상 bp·note_count 보충은 한 번, 알려진 값과 날짜 변경은 무전송', async () => {
  const f = uploadScenario();
  await f.run();
  await f.run({ charts: [f.chart(0, { missCount: 10, noteCount: 100 })] });
  f.state.date = '2026-10-24T01:02:03Z';
  await f.run({ charts: [f.chart(0, { missCount: 5, noteCount: 200 })] });
  assert.equal(f.calls.filter(c => c.url.includes('upsert_scores')).length, 2);
});

test('profile→radar→전체 scores→완료 순서와 best-effort 실패 후 재통지 방지', async () => {
  for (const completion of ['rejected', 'network']) {
    const f = uploadScenario({ completion });
    assert.equal((await f.run({ charts: Array.from({ length: 1001 }, (_, i) => f.chart(i)) })).ok, true);
    const endpoints = f.writes().map(c => c.url.split('/').at(-1));
    assert.deepEqual(endpoints.slice(0, 5), ['upsert_user_upload_profile', 'upsert_user_radar', 'upsert_user_radar', 'upsert_scores', 'upsert_scores']);
    assert.equal(endpoints.at(-1).includes('dump-trigger'), true);
    if (completion === 'rejected') assert.ok(f.diagnostics.some(line => line.includes('accepted=false')));
    const before = f.writes().length;
    await f.run({ charts: Array.from({ length: 1001 }, (_, i) => f.chart(i)) });
    assert.equal(f.writes().length, before);
  }
});

test('score history 날짜 파싱 캐시는 성공 결과와 실패 예외를 일관되게 반환', () => {
  const api = load(async () => { throw Error('unused'); });
  const date = '2026-10-23';
  const instant = '2026-10-23T01:02:03.123457Z';
  const row = (timestamp, dayValue) => [[1, 1, 1, 1, 1, timestamp, dayValue, 1, null, null]];
  const run = (timestamp, dayValue) => {
    const result = api.__filterScoreHistoryRows([], row(timestamp, dayValue));
    return plain(result);
  };
  assert.deepEqual(run(instant, date), run(instant, date));
  const getError = () => { try { run('bad timestamp', date); } catch (e) { return { name: e.name, message: e.message }; } return null; };
  assert.deepEqual(getError(), getError());
  assert.deepEqual(getError(), { name: 'TypeError', message: 'date requires a timestamp with timezone (up to 6 fractional digits)' });
});

test('score history 날짜 캐시 두 개는 32769개 유효 입력 뒤에도 기존 결과를 유지', () => {
  const api = load(async () => { throw Error('unused'); });
  const row = (timestamp, dayValue) => [[1, 1, 1, 1, 1, timestamp, dayValue, 1, null, null]];
  const run = (timestamp, dayValue) => plain(api.__filterScoreHistoryRows([], row(timestamp, dayValue)));
  const first = ['2026-10-23T01:02:03Z', '2026-10-23'];
  const expected = run(...first);
  const base = Date.UTC(2000, 0, 1);
  for (let i = 0; i < 32769; i += 1) {
    const day = new Date(base + i * 86400000).toISOString().slice(0, 10);
    run(`${day}T00:00:00Z`, day);
  }
  assert.deepEqual(run(...first), expected);
  assert.ok(api.__scoreHistoryMemos[0].size <= 2);
  assert.ok(api.__scoreHistoryMemos[1].size <= 3);
});

test('완료 중계 기본 OFF는 기존 업로드 요청과 반환을 유지', async () => {
  assert.match(source, /const FAST_DUMP_ENQUEUE_INF = true/);
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('/hist/')) return { ok: true, status: 200, json: async () => [] };
    if (url.includes('/rpc/upsert_user')) return { ok: true, status: 200 };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => [{ song_id: 7, title: 'song0', ac: 2, legen: 0 }] };
    if (url.includes('/rpc/upsert_scores')) return { ok: true, status: 200 };
    throw Error(url);
  };
  const api = load(fetch, Date, { fastDump: false });
  const result = await api.uploadProfile({ appVersion: 'fixture', profile: { iidxId: 'C123' }, starResult: null,
    charts: [{ title: 'song0', slot: 'DPA', diff: 'ANOTHER', exScore: 120, lamp: 'HC' }], allTsvCharts: [], spCharts: [], dpAllCharts: [] });
  assert.deepEqual(plain(result), { ok: true });
  assert.equal(calls.some(c => c.url.includes('dump-trigger') || c.url.includes('/auth/')), false);
});

test('완료 중계 ON은 1001행 청크 성공 뒤 C/K INF ID로 한 번 호출', async () => {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('/hist/')) return { ok: true, status: 200, json: async () => [] };
    if (url.endsWith('/auth/issue')) return { ok: true, json: async () => ({ url: 'https://iidx.in/?ticket=fixture' }) };
    if (url.endsWith('/auth/exchange')) return { ok: true, json: async () => ({ token: 'bearer-fixture' }) };
    if (url.endsWith('/auth/session')) return { ok: true, json: async () => ({ logged_in: true, iidx_id: 'CK123' }) };
    if (url.includes('/rpc/upsert_user')) return { ok: true, status: 200 };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => pagedSongs(url) };
    if (url.includes('/rpc/upsert_scores')) return { ok: true, status: 200 };
    if (url.includes('dump-trigger')) return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    throw Error(url);
  };
  const api = load(fetch, Date, { fastDump: true });
  const result = await api.uploadProfile({ appVersion: 'fixture', profile: { iidxId: 'C-K123' }, starResult: null,
    charts: Array.from({ length: 1001 }, (_, i) => ({ title: `song${i}`, slot: 'DPA', diff: 'ANOTHER', exScore: 120, lamp: 'HC' })),
    allTsvCharts: [], spCharts: [], dpAllCharts: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.filter(c => c.url.includes('/rpc/upsert_scores')).map(c => JSON.parse(c.opts.body).p_rows.length), [1000, 1]);
  const relay = calls.filter(c => c.url.includes('dump-trigger'));
  assert.equal(relay.length, 1);
  assert.equal(relay[0].url, 'https://iidx.in/api/dump-trigger?upload_complete=1');
  assert.equal(relay[0].opts.credentials, 'omit');
  assert.equal(relay[0].opts.headers.Authorization, 'Bearer bearer-fixture');
  assert.deepEqual(JSON.parse(relay[0].opts.body), { source: 'inf', iidx_id: 'CK123', request_id: '00000000-0000-4000-8000-000000000001' });
});

test('완료 중계는 첫 청크 실패·후속 청크 실패·전송 0행에서 호출하지 않음', async () => {
  for (const failAt of [1, 2, 0]) {
    const calls = [];
    const fetch = async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.includes('/hist/')) return { ok: true, status: 200, json: async () => failAt === 0 ? [[1,3,5,999,0,'2026-10-23T01:02:03Z','2026-10-23',1,null,1500]] : [] };
      if (url.endsWith('/auth/issue')) return { ok: true, json: async () => ({ url: 'https://iidx.in/?ticket=t' }) };
      if (url.endsWith('/auth/exchange')) return { ok: true, json: async () => ({ token: 't' }) };
      if (url.endsWith('/auth/session')) return { ok: true, json: async () => ({ logged_in: true, iidx_id: 'K123' }) };
      if (url.includes('/rpc/upsert_user')) return { ok: true, status: 200 };
      if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => pagedSongs(url) };
      if (url.includes('/rpc/upsert_scores')) return { ok: failAt === 0 || calls.filter(c => c.url.includes('/rpc/upsert_scores')).length !== failAt, status: 500, text: async () => 'fail' };
      throw Error(url);
    };
    const api = load(fetch, Date, { fastDump: true });
    const result = await api.uploadProfile({ appVersion: 'fixture', profile: { iidxId: 'K123' }, starResult: null,
      charts: Array.from({ length: failAt === 0 ? 0 : 1001 }, (_, i) => ({ title: `song${i}`, slot: 'DPA', diff: 'ANOTHER', exScore: 120, lamp: 'HC' })),
      allTsvCharts: [], spCharts: [], dpAllCharts: [] });
    assert.equal(calls.some(c => c.url.includes('dump-trigger')), false);
    if (failAt > 0) assert.equal(result.ok, false);
    else assert.equal(result.ok, true);
  }
});

test('완료 중계는 Bearer 대상 불일치와 응답 유실을 안전하게 처리', async () => {
  for (const sessionId of ['OTHER', 'K123']) {
    const calls = [];
    let relayAttempts = 0;
    const fetch = async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.includes('/hist/')) return { ok: true, status: 200, json: async () => [] };
      if (url.endsWith('/auth/issue')) return { ok: true, json: async () => ({ url: 'https://iidx.in/?ticket=t' }) };
      if (url.endsWith('/auth/exchange')) return { ok: true, json: async () => ({ token: 't' }) };
      if (url.endsWith('/auth/session')) return { ok: true, json: async () => ({ logged_in: true, iidx_id: sessionId }) };
      if (url.includes('/rpc/upsert_user') || url.includes('/rpc/upsert_scores')) return { ok: true, status: 200 };
      if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => [{ song_id: 1, title: 'song0', ac: 2, legen: 0 }] };
      if (url.includes('dump-trigger')) { relayAttempts++; if (relayAttempts === 1) throw Error('lost'); return { ok: true, status: 200 }; }
      throw Error(url);
    };
    const warnings = [];
    const api = load(fetch, Date, { fastDump: true, console: { log() {}, warn(...args) { warnings.push(args); } } });
    const result = await api.uploadProfile({ appVersion: 'fixture', profile: { iidxId: 'K123' }, starResult: null,
      charts: [{ title: 'song0', slot: 'DPA', diff: 'ANOTHER', exScore: 120, lamp: 'HC' }], allTsvCharts: [], spCharts: [], dpAllCharts: [] });
    assert.equal(result.ok, true);
    const relay = calls.filter(c => c.url.includes('dump-trigger'));
    assert.equal(relay.length, sessionId === 'K123' ? 2 : 0);
    if (relay.length) assert.equal(JSON.parse(relay[0].opts.body).request_id, JSON.parse(relay[1].opts.body).request_id);
    else assert.ok(warnings.length > 0);
  }
});

test('완료 중계는 5xx·손상 JSON만 동일 UUID로 재시도하고 4xx는 한 번만 호출', async () => {
  for (const scenario of ['5xx', 'broken-json', '4xx']) {
    const calls = [];
    const fetch = async (url, opts = {}) => {
      calls.push({ url, opts });
      if (url.includes('/hist/')) return { ok: true, status: 200, json: async () => [] };
      if (url.endsWith('/auth/issue')) return { ok: true, json: async () => ({ url: 'https://iidx.in/?ticket=t' }) };
      if (url.endsWith('/auth/exchange')) return { ok: true, json: async () => ({ token: 't' }) };
      if (url.endsWith('/auth/session')) return { ok: true, json: async () => ({ logged_in: true, iidx_id: 'K123' }) };
      if (url.includes('/rpc/upsert_user') || url.includes('/rpc/upsert_scores')) return { ok: true, status: 200 };
      if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => pagedSongs(url).slice(0, 1) };
      if (url.includes('dump-trigger')) {
        const attempt = calls.filter(c => c.url.includes('dump-trigger')).length;
        if (scenario === '4xx') return { ok: false, status: 401 };
        if (attempt === 1 && scenario === '5xx') return { ok: false, status: 503 };
        if (attempt === 1) return { ok: true, status: 200, json: async () => { throw Error('invalid JSON'); } };
        return { ok: true, status: 200, json: async () => ({ accepted: true }) };
      }
      throw Error(url);
    };
    const api = load(fetch, Date, { fastDump: true });
    const result = await api.uploadProfile({ appVersion: 'fixture', profile: { iidxId: 'K123' }, starResult: null,
      charts: [{ title: 'song0', slot: 'DPA', diff: 'ANOTHER', exScore: 120, lamp: 'HC' }], allTsvCharts: [], spCharts: [], dpAllCharts: [] });
    assert.equal(result.ok, true);
    const relay = calls.filter(c => c.url.includes('dump-trigger'));
    assert.equal(relay.length, scenario === '4xx' ? 1 : 2);
    if (relay.length === 2) assert.equal(JSON.parse(relay[0].opts.body).request_id, JSON.parse(relay[1].opts.body).request_id);
  }
});

test('B1 인증 fetch 미완료는 세 endpoint 모두 abort하고 uploadProfile을 성공 반환한다', async () => {
  for (const endpoint of ['/auth/issue', '/auth/exchange', '/auth/session']) {
    const diagnostics = [];
    const out = await runTimedDump({ authHang: { endpoint, stage: 'fetch' }, addDiagLine: line => diagnostics.push(line) });
    assert.deepEqual(plain(out.result), { ok: true });
    assert.ok(out.signals.length > 0 && out.signals.every(signal => signal.aborted), endpoint);
    assert.equal(out.clock.now, 5000, endpoint);
    assert.match(diagnostics[0], /reason=auth_fetch_timeout/);
  }
});

test('B2 인증 본문 미완료는 세 endpoint 모두 5초 제한과 abort를 적용한다', async () => {
  for (const endpoint of ['/auth/issue', '/auth/exchange', '/auth/session']) {
    const diagnostics = [];
    const out = await runTimedDump({ authHang: { endpoint, stage: 'body' }, addDiagLine: line => diagnostics.push(line) });
    assert.deepEqual(plain(out.result), { ok: true });
    assert.ok(out.signals.length > 0 && out.signals.every(signal => signal.aborted), endpoint);
    assert.equal(out.clock.now, 5000, endpoint);
    assert.match(diagnostics[0], /reason=auth_body_timeout/);
  }
});

test('B3 완료 본문 timeout은 abort되고 두 번 재시도해 30초 이내 반환한다', async () => {
  const diagnostics = [];
  const out = await runTimedDump({ relay: 'body-hang', addDiagLine: line => diagnostics.push(line) });
  assert.deepEqual(plain(out.result), { ok: true });
  assert.equal(out.calls.filter(call => call.url.includes('dump-trigger')).length, 2);
  assert.ok(out.signals.every(signal => signal.aborted));
  assert.ok(out.clock.now <= 30_000);
  assert.match(diagnostics[0], /reason=complete_body_timeout attempts=2 elapsed_ms=\d+/);
});

test('B4 저장 토큰 401·로그아웃·계정 불일치는 한 번만 재발급하고 새 세션을 검증한다', async () => {
  for (const invalid of [
    { status: 401 },
    { data: { logged_in: false, iidx_id: 'K123' } },
    { data: { logged_in: true, iidx_id: 'OTHER' } },
  ]) {
    for (const freshValid of [true, false]) {
      const diagnostics = [];
      const replies = [invalid, freshValid ? { data: { logged_in: true, iidx_id: 'K123' } } : { data: { logged_in: false, iidx_id: 'K123' } }];
      const out = await runTimedDump({ storedToken: 'fixture-old-token-secret', sessionReplies: replies, addDiagLine: line => diagnostics.push(line) });
      assert.deepEqual(plain(out.result), { ok: true });
      assert.equal(out.calls.filter(call => call.url.endsWith('/auth/issue')).length, 1);
      assert.equal(out.calls.filter(call => call.url.endsWith('/auth/exchange')).length, 1);
      assert.equal(out.calls.filter(call => call.url.endsWith('/auth/session')).length, 2);
      assert.equal(out.calls.filter(call => call.url.includes('dump-trigger')).length, freshValid ? 1 : 0);
      if (!freshValid) assert.equal(out.storage.has('ohsorry:remoteAuthToken'), false);
      assert.doesNotMatch(diagnostics.join('\n'), /fixture-(?:old-token|new-token|ticket)-secret/);
    }
  }
});

test('B5 진단은 성공·거부·HTTP 실패·생략 사유와 시간을 기록하고 비밀값을 제외한다', async () => {
  for (const [relay, expected] of [['accepted', /result=success accepted=true http=200 reason=none/],
    ['rejected', /result=rejected accepted=false http=200 reason=accepted_false/],
    ['4xx', /result=http_failure accepted=unknown http=429 reason=http_4xx/]]) {
    const diagnostics = [];
    const out = await runTimedDump({ relay, addDiagLine: line => diagnostics.push(line) });
    assert.deepEqual(plain(out.result), { ok: true });
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /^\[inf-dump\] stage=complete /);
    assert.match(diagnostics[0], expected);
    assert.match(diagnostics[0], /elapsed_ms=\d+$/);
    assert.doesNotMatch(diagnostics.join('\n'), /fixture-(?:old-token|new-token|ticket)-secret/);
  }
  const diagnostics = [];
  await runTimedDump({ noUuid: true, addDiagLine: line => diagnostics.push(line) });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /reason=uuid_missing/);
});

test('B6 전체 30초 deadline 이후 완료 요청을 더 시작하지 않는다', async () => {
  const diagnostics = [];
  const out = await runTimedDump({ storedToken: 'fixture-old-token-secret', sessionReplies: [
    { status: 401 }, { data: { logged_in: true, iidx_id: 'K123' } },
  ], relay: 'hang', authLatency: 4999, addDiagLine: line => diagnostics.push(line) });
  assert.deepEqual(plain(out.result), { ok: true });
  const authCalls = out.calls.filter(call => /\/auth\/(?:session|issue|exchange)$/.test(call.url));
  const relayCalls = out.calls.filter(call => call.url.includes('dump-trigger'));
  assert.equal(authCalls.length, 4);
  assert.equal(relayCalls.length, 2);
  assert.ok(out.clock.now >= 29_990 && out.clock.now <= 30_000);
  const callsAtDeadline = out.calls.length;
  out.clock.advanceBy(30_000 - out.clock.now);
  assert.equal(out.clock.now, 30_000);
  assert.equal(out.calls.length, callsAtDeadline);
  assert.match(diagnostics[0], /elapsed_ms=\d+$/);
});
