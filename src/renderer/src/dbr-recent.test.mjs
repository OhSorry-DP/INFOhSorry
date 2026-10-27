import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const historyApi = {};
const historyCode = ts.transpileModule(read('./dbr-history.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(historyCode, { exports: historyApi, BigInt, Date, JSON, Map, Set, Number, String, Array, Object, TypeError });
historyApi.getDbrRecentDates = historyApi.getDbrRecentDates;
const history = (rows = [], complete = true) => ({ schemaVersion: 1, complete, revision: 2,
  cols: ['song_id','diff','lamp','ex_score','played_version','date','date_kst','play_style','bp','note_count','score_id'], rows });
const row = (song = 7, score = '1', date = '2026-10-20T00:00:00Z', ex = 100, lamp = 5) =>
  [song, 3, lamp, ex, -10, date, '2026-10-20', 1, 20, 100, score];
const document = value => ({ scores: {}, history: value, updatedAt: '2026-10-20T00:00:00.000Z', v: 1 });
const plain = value => JSON.parse(JSON.stringify(value));

function loadSync(fetchImpl) {
  const exports = {};
  const source = ts.transpileModule(read('./supabaseSync.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: name => {
    if (name === './dbr-history') return historyApi;
    if (name === '../../shared/dataSource') return { DATA_BASE: 'https://fixture.invalid/data' };
    if (name === '../../shared/match') return { norm: x => x, slotToDiff: x => x };
    if (name === '../../shared/uploadSnapshot') return { PLAY_CSV_KEYS: [], PLAY_CSV_LEGACY_KEYS: [], buildPlayErrorRow() {}, isPlayErrorRow() { return false; } };
    if (name === './useProfile' || name === '../../shared/types' || name === '../../shared/recommend') return {};
    throw new Error(`Unexpected import ${name}`);
  }, fetch: fetchImpl, Date, console: { warn() {}, log() {} }, Map, Set, BigInt, JSON, Math, Number, String, Object, Array, Promise, Error, TypeError });
  return exports;
}

test('DBR 날짜는 정규화 ID의 R2 JSON만 읽고 DBR 계산기를 사용', async () => {
  const calls = [];
  const api = loadSync(async (url, options) => { calls.push({ url, options });
    if (url.includes('/dbr/')) return { ok: true, status: 200, json: async () => document(history([row()])) };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => [{ song_id: 7, title: 'Fixture Song', ac: 2, legen: 0, textage_song_id: 'tx7' }] };
    if (url.includes('textage-meta')) return { ok: true, status: 200, json: async () => ({ songs: { tx7: { levels: { DA: 12 }, notes: { DA: 100 } } } }) };
    throw Error(url);
  });
  assert.deepEqual(plain(await api.fetchRecentDates('c-123', true)), [{ date_kst: '2026-10-20', row_count: 1 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://fixture.invalid/data/dbr/C123.json?fresh=1');
  assert.equal(calls[0].options.cache, 'no-store');
});

test('DBR 차트는 song_id 메타 JOIN과 직전 플레이 값을 기존 Recent 모델로 변환', async () => {
  const api = loadSync(async url => {
    if (url.includes('/dbr/')) return { ok: true, status: 200, json: async () => document(history([[7,3,5,100,-10,'2026-10-19T00:00:00Z','2026-10-19',1,20,100,'1'], [7,3,6,120,-10,'2026-10-20T01:00:00Z','2026-10-20',1,20,100,'2']])) };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => [{ song_id: 7, title: 'Fixture Song', ac: 2, legen: 0, textage_song_id: 'tx7' }] };
    if (url.includes('textage-meta')) return { ok: true, status: 200, json: async () => ({ songs: { tx7: { levels: { DA: 12 }, notes: { DA: 100 } } } }) };
    throw Error(url);
  });
  const charts = plain(await api.fetchRecentCharts('C123', '2026-10-20', true));
  assert.equal(charts.length, 1);
  assert.equal(charts[0].title, 'Fixture Song');
  assert.equal(charts[0].textageSongId, 'tx7');
  assert.equal(charts[0].prevExScore, 100);
  assert.equal(charts[0].prevLamp, 'HARD');
  assert.equal(charts[0].prevLamp, 'HARD');
});

test('DBR 차트는 메타가 없는 song_id 행만 제외', async () => {
  const historyWithMissingSong = { ...history([row(999, '3'), row(7, '4')]), rows: [row(999, '3'), row(7, '4')] };
  const api = loadSync(async url => {
    if (url.includes('/dbr/')) return { ok: true, status: 200, json: async () => document(historyWithMissingSong) };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => [{ song_id: 7, title: 'Fixture Song', ac: 2, legen: 0, textage_song_id: 'tx7' }] };
    if (url.includes('textage-meta')) return { ok: true, status: 200, json: async () => ({ songs: { tx7: { levels: { DA: 12 }, notes: { DA: 100 } } } }) };
    throw Error(url);
  });
  const charts = plain(await api.fetchRecentCharts('C123', '2026-10-20', true));
  assert.equal(charts.length, 1);
  assert.equal(charts[0].title, 'Fixture Song');
});

test('일반 날짜·차트는 R2 hist를 읽고 DBR을 제외', async () => {
  const calls = [];
  const api = loadSync(async (url, options) => { calls.push({ url, options });
    if (url.includes('/hist/')) return { ok: true, status: 200, json: async () => [
      [7,3,5,10,0,'2026-10-20T00:00:00Z','2026-10-20',1,2,100],
      [8,3,5,20,-10,'2026-10-20T00:00:00Z','2026-10-20',1,2,100],
    ] };
    if (url.includes('/user/')) return { ok: true, status: 200, json: async () => ({ dp: [], sp: [] }) };
    if (url.includes('/rest/v1/songs')) return { ok: true, status: 200, json: async () => [{ song_id: 7, title: 'DP Song', ac: 2, legen: 0, textage_song_id: 'tx7' }] };
    if (url.includes('textage-meta')) return { ok: true, json: async () => ({ songs: {} }) };
    throw Error(url);
  });
  await api.fetchRecentDates('C123');
  const charts = await api.fetchRecentCharts('C123', '2026-10-20');
  assert.equal(calls.filter(c => c.url.includes('/rpc/')).length, 0);
  assert.deepEqual(plain(charts).map(c => c.title), ['DP Song']);
});

test('R2 404는 빈 날짜, HTTP 오류와 incomplete 기록은 명시적으로 실패', async () => {
  const missing = loadSync(async () => ({ ok: false, status: 404 }));
  assert.deepEqual(plain(await missing.fetchRecentDates('C123', true)), []);
  const failed = loadSync(async () => ({ ok: false, status: 500 }));
  await assert.rejects(failed.fetchRecentDates('C123', true), /HTTP 500/);
  const incomplete = loadSync(async () => ({ ok: true, status: 200, json: async () => document(history([], false)) }));
  await assert.rejects(incomplete.fetchRecentDates('C123', true), /complete=false/);
  const noHistory = loadSync(async () => ({ ok: true, status: 200, json: async () => ({ scores: {}, updatedAt: '2026-10-20T00:00:00.000Z', v: 1 }) }));
  await assert.rejects(noHistory.fetchRecentDates('C123', true), /complete=false/);
});

test('DBR 렌더는 날짜 오류를 표시하고 취소된 날짜 응답은 무시', () => {
  const source = read('./Recent.tsx');
  assert.match(source, /fetchRecentDates\(normalizedId, true\)[\s\S]*?setError\(\(e as Error\)\.message/);
  assert.match(source, /generation === dbrRequestGeneration\.current\) setDbrDates/);
  assert.match(source, /fetchRecentCharts\(normalizedId, targetDate, dbrOnly\)/);
});

test('자동 DBR 업로드 Bearer와 improvements_only 계약은 유지', () => {
  const tests = read('./play-upload.test.mjs');
  assert.match(tests, /Bearer existing-bearer/);
  assert.match(tests, /improvements_only, true/);
});
