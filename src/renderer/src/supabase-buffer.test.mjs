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
  }, fetch: fetchImpl, Date: dateImpl, URL, crypto: options.crypto ?? { randomUUID: () => '00000000-0000-4000-8000-000000000001' }, AbortController, setTimeout, clearTimeout,
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
  assert.ok(profileCall);
  assert.deepEqual(Object.keys(JSON.parse(profileCall.opts.body)).sort(), ['p_dj_name', 'p_dp_rank', 'p_ereter_star', 'p_iidx_id', 'p_sp_rank', 'p_star'].sort());
  out = await run({ histReply: { ok: true, status: 200, json: async () => [] } });
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
