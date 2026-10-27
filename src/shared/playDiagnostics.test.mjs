import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAY_CSV_KEYS, PLAY_CSV_LEGACY_KEYS, PLAY_ERROR_CODES, buildPlayErrorRow, isPlayErrorRow } from './uploadSnapshot.ts';

const timestamp = '2026-10-17T00:00:00.000Z';
const versions = { appVersion: '1.2.3', gameVersion: '2026101700' };

test('CSV headers have 21 current and 19 legacy fields', () => {
  assert.equal(PLAY_CSV_KEYS.length, 21);
  assert.equal(PLAY_CSV_LEGACY_KEYS.length, 19);
  assert.deepEqual(PLAY_CSV_KEYS.slice(0, 19), PLAY_CSV_LEGACY_KEYS);
  assert.deepEqual(PLAY_CSV_KEYS.slice(19), ['app_version', 'game_version']);
});

test('builds all defined diagnostic rows with timestamp and versions intact', () => {
  for (const code of Object.values(PLAY_ERROR_CODES)) {
    const row = buildPlayErrorRow(code, versions, timestamp);
    assert.equal(row.timestamp, timestamp);
    assert.equal(row.app_version, versions.appVersion);
    assert.equal(row.game_version, versions.gameVersion);
    assert.ok(isPlayErrorRow(row));
    assert.deepEqual(PLAY_CSV_KEYS.slice(1, 19).map((key) => row[key]), Array(18).fill(String(code)));
  }
});

test('error detection checks all 18 diagnostic fields only', () => {
  const row = Object.fromEntries(PLAY_CSV_KEYS.map((key) => [key, ''])) ;
  row.clear_lamp = '-1';
  assert.equal(isPlayErrorRow(row), false);
  const error = buildPlayErrorRow(-99, versions, timestamp);
  assert.equal(isPlayErrorRow(error), true);
  const mismatch = { ...error, title: 'different' };
  assert.equal(isPlayErrorRow(mismatch), false);
  assert.equal(isPlayErrorRow({ ...error, timestamp: 'other', app_version: '', game_version: 'x' }), true);
});

test('rejects non-negative and non-integer error codes', () => {
  for (const code of [0, 1, -1.5, NaN, Infinity]) assert.throws(() => buildPlayErrorRow(code, versions, timestamp), RangeError);
});
