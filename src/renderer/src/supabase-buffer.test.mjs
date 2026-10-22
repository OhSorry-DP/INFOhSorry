import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const source = read('./supabaseSync.ts');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(fetchImpl, dateImpl = Date) {
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    if (name === './dbr-history') return {};
    if (name === '../../shared/dataSource') return { DATA_BASE: 'https://fixture.invalid/data' };
    if (name === '../../shared/match') return { norm: x => String(x).toLowerCase(), slotToDiff: x => x };
    if (name === '../../shared/uploadSnapshot') return { PLAY_CSV_KEYS: [], PLAY_CSV_LEGACY_KEYS: [], buildPlayErrorRow() {}, isPlayErrorRow() { return false; } };
    return {};
  }, fetch: fetchImpl, Date: dateImpl, window: { infohsorry: { serviceStatus: { get: async () => ({ uploadEnabled: true }) } } }, console: { warn() {}, log() {} }, Map, Set, BigInt, JSON, Math, Number, String, Object, Array, Promise, Error, TypeError });
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
  assert.doesNotMatch(source.slice(source.indexOf('body: JSON.stringify({', source.indexOf('upsert_user`')), source.indexOf('}),\n    });', source.indexOf('upsert_user`'))), /p_(?:sp_cpi|sp_star|r_star):/);
  assert.match(source, /played_version:\s*PLAYED_VERSION_INF/);
  assert.match(source, /SCORE_UPSERT_CHUNK_SIZE = 1000/);
  assert.match(source, /SCORE_UPSERT_CHUNK_SIZE = 1000[\s\S]*?scoreRows\.slice\(i \* SCORE_UPSERT_CHUNK_SIZE, \(i \+ 1\) \* SCORE_UPSERT_CHUNK_SIZE\)/);
  const rows = Array.from({ length: 1001 }, (_, i) => ({ song_id: i + 1 }));
  const chunks = Array.from({ length: Math.ceil(rows.length / 1000) }, (_, i) => rows.slice(i * 1000, (i + 1) * 1000));
  assert.deepEqual(chunks.map(chunk => chunk.length), [1000, 1]);
  const response = { ok: false, status: 500 };
  assert.equal(response.ok, false); assert.equal(response.status, 500);
  assert.match(source, /return \{ ok: false, error: `scores chunk \$\{i \+ 1\}\/\$\{total\} HTTP \$\{chartRes\.status\}/);
});
