import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./dbr-history.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const api = {};
vm.runInNewContext(code, { exports: api, BigInt, Date, Map, Set, Number, JSON, Object, Array, String, TypeError });
const row = (song, date, score, ex = 100, version = -10, style = 1, time = `${date}T10:00:00Z`, lamp = 3) =>
  [song, 3, lamp, ex, version, time, date, style, 2, 100, score];
const history = rows => ({ schemaVersion: 1, complete: true, revision: 2, cols: [...api.DBR_HISTORY_COLS], rows });
const plain = value => JSON.parse(JSON.stringify(value));

test('웹 정상 벡터: 최근 날짜 집계와 직전 EX 결과', () => {
  const h = history([row(1, '2026-10-20', '10', 90), row(1, '2026-10-21', '11', 100)]);
  assert.deepEqual(plain(api.getDbrRecentDates(h)), { status: 'ready', complete: true, dates: [
    { date_kst: '2026-10-21', row_count: 1 }, { date_kst: '2026-10-20', row_count: 1 },
  ] });
  const recent = plain(api.getDbrRecentData(h, '2026-10-21'));
  assert.equal(recent.rows[0].prev_ex_score, 90);
  assert.equal(recent.rows[0].prev_lamp, 3);
});

test('EX 0은 결과에서 제외되고 날짜 내림차순 및 행 수를 계산', () => {
  const h = history([row(1, '2026-10-20', '1', 10), row(2, '2026-10-21', '2', 0)]);
  assert.deepEqual(plain(api.getDbrRecentDates(h)), { status: 'ready', complete: true,
    dates: [{ date_kst: '2026-10-20', row_count: 1 }] });
});

test('직전 기록은 같은 채보와 버전/스타일의 엄격히 과거 시각만 사용', () => {
  const h = history([
    row(1, '2026-10-20', '1', 10, -10, 1, '2026-10-20T10:00:00Z', 1),
    row(2, '2026-10-21', '2', 20, -10, 1, '2026-10-21T10:00:00Z', 2),
    row(3, '2026-10-21', '3', 30, -10, 1, '2026-10-21T10:00:00Z', 3),
    row(1, '2026-10-21', '4', 40, -10, 1, '2026-10-21T10:00:00Z', 4),
    row(6, '2026-10-21', '5', 50, -10, 1, '2026-10-21T11:00:00Z', 5),
  ]);
  const got = plain(api.getDbrRecentData(h, '2026-10-21')).rows;
  assert.deepEqual(got.map(r => r.prev_ex_score), [null, null, 10, null]);
});

test('bigint score_id는 정밀도 손실 없이 비교·정렬', () => {
  const h = history([row(1, '2026-10-21', '9007199254740993'), row(2, '2026-10-21', '9007199254740992')]);
  assert.deepEqual(plain(api.getDbrRecentData(h, '2026-10-21')).rows.map(r => r.score_id),
    ['9007199254740992', '9007199254740993']);
});

test('손상, 중복, KST 불일치와 잘못된 컬럼을 거부', () => {
  const valid = history([row(1, '2026-10-21', '1')]);
  assert.throws(() => api.validateDbrHistory({ ...valid, cols: valid.cols.slice(1) }), /cols order mismatch/);
  assert.throws(() => api.validateDbrHistory(history([valid.rows[0], valid.rows[0]])), /duplicate natural key/);
  assert.throws(() => api.validateDbrHistory(history([[...valid.rows[0].slice(0, 6), '2026-10-20', ...valid.rows[0].slice(7)]])), /date_kst does not match/);
});

test('incomplete와 빈 history는 성공 결과로 가장하지 않는다', () => {
  assert.deepEqual(plain(api.getDbrRecentDates(null)), { status: 'incomplete', complete: false, dates: [] });
  assert.deepEqual(plain(api.getDbrRecentDates({ ...history([]), complete: false })), { status: 'incomplete', complete: false, dates: [] });
  assert.deepEqual(plain(api.getDbrRecentDates(history([]))), { status: 'empty', complete: true, dates: [] });
});
