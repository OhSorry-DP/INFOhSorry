import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('local calculated card values are scoped and labelled provisional, while public values remain separate', () => {
  assert.match(app, /cardId === rowsOwnerId \? dp12StarResult : null/);
  assert.match(app, /cardId === rowsOwnerId \? spStarResult\?\.star/);
  assert.match(app, /cardId === rowsOwnerId && bundleReady && isFloorSeedCurrent\(rowsState\.scope, accountScopeRef\.current\)/);
  assert.match(app, /잠정 · 덤프 후 반영/);
  assert.match(app, /currentUserPublic = userPublicScope/);
});

test('successful upload reports score transfer separately from official dump reflection', () => {
  assert.match(app, /점수 업로드 완료 · 공식값은 덤프 후 반영/);
  assert.doesNotMatch(app, /업로드 성공.*공식값 갱신 완료/);
});

test('snapshot creation still requires a ready accepted bundle and current account scope', () => {
  assert.match(app, /!state\.bundleReady \|\| !isUploadReady\(state\.acceptedBundle, state\.expectedBundle\)/);
  assert.match(app, /state\.scope\.iidxId !== iidxId \|\| !isFloorSeedCurrent\(state\.scope, accountScopeRef\.current\)/);
});

test('final and pending upload lifecycle guards remain intact', () => {
  assert.match(app, /if \(trigger === 'final'\)/);
  assert.match(app, /trigger !== 'pending'\) writeLastUploadAt/);
  assert.match(app, /clearPending\(snapshot\.iidxId\)/);
});

test('syncScores reports R2 comparison candidates without SQL execution or copying', () => {
  const diagnostic = app.slice(app.indexOf('win.syncScores = async'), app.indexOf('delete win.syncScores'));
  assert.match(diagnostic, /R2 비교 후보이며 실행되지 않았음/);
  assert.match(diagnostic, /blockedByRatio/);
  assert.match(diagnostic, /histIndex: 'histIndex' in d/);
  assert.match(diagnostic, /songId: 'songId' in d/);
  assert.doesNotMatch(diagnostic, /navigator\.clipboard|plan\.sql|Supabase SQL Editor|삭제할 행이 없다/);
});
