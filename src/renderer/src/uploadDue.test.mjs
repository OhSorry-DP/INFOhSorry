import test from 'node:test';
import assert from 'node:assert/strict';
import { isUploadDue } from './uploadDue.ts';

const MIN10 = 10 * 60 * 1000;

test('기록이 없거나 손상이면 바로 올린다', () => {
  assert.equal(isUploadDue(0, 1_000_000, MIN10), true);
  assert.equal(isUploadDue(NaN, 1_000_000, MIN10), true);
  assert.equal(isUploadDue(-5, 1_000_000, MIN10), true);
});

test('주기 미만이면 안 올리고, 주기 이상이면 올린다(경계 포함)', () => {
  const last = 1_000_000;
  assert.equal(isUploadDue(last, last + MIN10 - 1, MIN10), false);
  assert.equal(isUploadDue(last, last + MIN10, MIN10), true);
  assert.equal(isUploadDue(last, last + MIN10 * 3, MIN10), true);
});

test('시스템 시계가 뒤로 가면 막히지 않게 바로 올린다', () => {
  assert.equal(isUploadDue(2_000_000, 1_000_000, MIN10), true);
});
