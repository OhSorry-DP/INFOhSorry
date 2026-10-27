import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./scoreSync.ts', import.meta.url), 'utf8');
const baseHist = [
  [7,3,5,100,0,'2026-10-19T00:00:00Z','2026-10-19',1,20,100],
  [7,3,6,150,0,'2026-10-20T00:00:00Z','2026-10-20',1,10,100],
];
function load({ hist = baseHist, status = 200, rows = [], tsvError = false } = {}) {
  const calls = [];
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (name === './supabaseSync') return {
      DIFF_MAP: { BEGINNER: 0, NORMAL: 1, HYPER: 2, ANOTHER: 3, LEGGENDARIA: 4 },
      LAMP_MAP: { NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7 },
      getSongsCache: async () => new Map([['song', [{ song_id: 7 }]], ['other', [{ song_id: 8 }]]]),
      getSongsById: async () => new Map([[7, { title: 'Song' }], [8, { title: 'Other' }]]),
      pickSongId: entries => entries?.[0]?.song_id ?? null,
    };
    if (name === '../../shared/match') return { norm: x => x.toLowerCase(), slotToDiff: x => ({ SPA: 'ANOTHER', DPA: 'ANOTHER', SPH: 'HYPER' })[x] };
    if (name === '../../shared/dataSource') return { DATA_BASE: 'https://data.fixture' };
    throw new Error(`Unexpected import ${name}`);
  }, fetch: async url => { calls.push(url); return { ok: status === 200, status, json: async () => hist }; },
  Map, Set, Number, String, Array, Object, Promise, Error, TypeError, Date, Math });
  const chartRows = rows;
  return { plan: (id = 'C123456789012', opts) => exports.planScoreSync(id, chartRows, opts), calls };
}
const row = (title, slot, exScore, lamp) => ({ title, type: '', label: '', charts: { [slot]: { exScore, lamp } } });
const plain = value => JSON.parse(JSON.stringify(value));

test('정상 및 초과 비교는 hist 위치와 natural key를 반환하고 SQL은 null', async () => {
  const api = load({ rows: [row('Song', 'DPA', 120, 'HC')] });
  const result = plain(await api.plan());
  assert.deepEqual(result.deletions.map(d => [d.histIndex, d.songId, d.dateKst, d.playStyle, d.diff, d.playedVersion, d.db.exScore]), [[1, 7, '2026-10-20', 1, 3, 0, 150]]);
  assert.equal(result.sql, null);
  assert.equal(result.counts.ok, 1);
});

test('noplay, 모호한 lamp, TSV에 없는 차트를 분류', async () => {
  const hist = [[7,3,5,100,0,'d','2026-10-19',1], [8,3,6,100,0,'d','2026-10-19',1], [99,3,5,100,0,'d','2026-10-19',1]];
  const api = load({ hist, rows: [row('Song', 'DPA', 0, 'NP'), row('Other', 'DPA', 0, 'HC'), row('Song', 'SPH', 10, 'HC')] });
  const result = plain(await api.plan());
  assert.equal(result.counts['noplay-but-db'], 1);
  assert.equal(result.counts.ambiguous, 1);
  assert.equal(result.counts['not-in-tsv'], 1);
});

test('SP와 DP 자연키를 격리하고 DBR 제외 및 ID 대상 AC 이상을 분류', async () => {
  const hist = [[7,3,5,100,-10,'d','2026-10-19',1], [7,3,5,100,0,'d','2026-10-19',0], [7,3,5,100,33,'d','2026-10-19',1]];
  const api = load({ hist, rows: [row('Song', 'DPA', 100, 'HC')] });
  const result = plain(await api.plan('C123456789012'));
  assert.equal(result.iidxId, 'C123456789012');
  assert.equal(result.counts.dbr, 1);
  assert.equal(result.counts['not-in-tsv'], 1);
  assert.equal(result.counts['ac-on-inf'], 1);
  assert.equal(result.deletions[0].category, 'ac-on-inf');
});

test('30% guard와 force는 계획만 바꾸고 후보 없음도 SQL을 만들지 않음', async () => {
  const hist = Array.from({ length: 4 }, (_, i) => [7,3,5,100,0,'d',`2026-10-0${i + 1}`,1]);
  const rows = [row('Song', 'DPA', 0, 'NP'), row('Song', 'SPH', 10, 'HC')];
  const blocked = plain(await load({ hist, rows }).plan());
  const forced = plain(await load({ hist, rows }).plan(undefined, { force: true }));
  const none = plain(await load({ hist: [], rows: [row('Song', 'DPA', 100, 'HC')] }).plan());
  assert.equal(blocked.blockedByRatio, true);
  assert.equal(forced.blockedByRatio, false);
  assert.equal(blocked.sql, null);
  assert.equal(forced.sql, null);
  assert.equal(none.deletions.length, 0);
  assert.equal(none.sql, null);
});

test('8열과 10열 지원, 404만 빈 이력이며 오류 형식은 실패하고 scores endpoint 호출 없음', async () => {
  const row8 = [[7,3,5,100,0,'d','2026-10-19',1]];
  const ok = load({ hist: row8, rows: [row('Song', 'DPA', 100, 'HC')] });
  await ok.plan();
  assert.deepEqual(ok.calls, ['https://data.fixture/hist/C123456789012.json']);
  const missing = load({ status: 404, rows: [row('Song', 'DPA', 100, 'HC')] });
  assert.equal((await missing.plan()).counts.ok, 0);
  await assert.rejects(load({ status: 500, rows: [row('Song', 'DPA', 100, 'HC')] }).plan(), /HTTP 500/);
  await assert.rejects(load({ hist: { rows: [] }, rows: [row('Song', 'DPA', 100, 'HC')] }).plan(), /invalid format/);
});

test('ID, 빈 TSV, 무플레이 유효성을 유지하고 R2 원본 순서를 보존', async () => {
  const hist = [baseHist[1], baseHist[0]];
  const api = load({ hist, rows: [row('Song', 'DPA', 100, 'HC')] });
  const result = plain(await api.plan('C123456789012'));
  assert.equal(result.iidxId, 'C123456789012');
  await assert.rejects(api.plan('bad'), /invalid IIDX ID/);
  await assert.rejects(load({ rows: [] }).plan(), /tracker.tsv is empty/);
  await assert.rejects(load({ rows: [row('Song', 'DPA', 0, 'NP')] }).plan(), /no played charts/);
  assert.equal(result.counts.ok, 1);
  assert.equal(result.deletions[0].histIndex, 0);
});
