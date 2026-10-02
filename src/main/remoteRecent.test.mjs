import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemoteRecentRows } from './remoteRecent.ts';
const now = '2026-10-01T15:00:00.000Z';
const base = () => ({ dp: [{ song_id: 1, diff: 3, played_version: 0, lamp: 4, ex_score: 1000, bp: 30, note_count: 800 }], sp: [] });
const local = (over = {}) => ({ song_id: 1, diff: 3, play_style: 1, lamp: 4, ex_score: 1000, bp: 30, note_count: 800, ...over });
test('동일·열등·BP만 개선은 제외하고 원본 보존', () => {
  const cdn = base(); const saved = structuredClone(cdn);
  for (const row of [local(), local({ lamp: 3, ex_score: 900 }), local({ bp: 20 })]) assert.deepEqual(buildRemoteRecentRows([row], cdn, now), []);
  assert.deepEqual(cdn, saved);
});
test('램프 개선은 기존 최고 EX를 보존', () => assert.deepEqual(buildRemoteRecentRows([local({ lamp: 5, ex_score: 900 })], base(), now), [[1, 3, 5, 1000, 0, now, '2026-10-02', 1, 30, 800]]));
test('EX 개선 및 중복 key는 한 행 최고 지표', () => {
  const rows = buildRemoteRecentRows([local({ lamp: 3, ex_score: 1100 }), local({ lamp: 5, ex_score: 1050 })], base(), now);
  assert.equal(rows.length, 1); assert.equal(rows[0][2], 5); assert.equal(rows[0][3], 1100);
});
test('빈 CDN의 새 SP와 DP는 별도 key', () => {
  const rows = buildRemoteRecentRows([local({ song_id: 2, play_style: 0, lamp: 1, ex_score: 500, bp: null, note_count: null }), local({ song_id: 2, lamp: 1, ex_score: 500, bp: null, note_count: null })], null, now);
  assert.equal(rows.length, 2); assert.deepEqual(rows[0], [2, 3, 1, 500, 0, now, '2026-10-02', 0, null, null]); assert.equal(rows[1][7], 1);
});
test('AC는 INF 기준이 아니고 무효 숫자는 제외', () => {
  const cdn = base(); cdn.dp[0].played_version = 34;
  assert.equal(buildRemoteRecentRows([local()], cdn, now).length, 1);
  assert.deepEqual(buildRemoteRecentRows([local({ ex_score: 0 }), local({ ex_score: NaN }), local({ diff: 9 })], cdn, now), []);
});
test('KST 자정 경계와 UTC date 유지', () => {
  for (const [iso, kst] of [['2026-10-01T14:59:59.999Z', '2026-10-01'], [now, '2026-10-02']]) {
    const [row] = buildRemoteRecentRows([local({ lamp: 5 })], base(), iso); assert.equal(row[5], iso); assert.equal(row[6], kst);
  }
});
