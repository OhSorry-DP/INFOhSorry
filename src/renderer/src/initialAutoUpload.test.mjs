import test from 'node:test';
import assert from 'node:assert/strict';
import { isInitialAutoUploadReady, INITIAL_AUTO_UPLOAD_STABLE_MS } from './initialAutoUpload.ts';

test('first automatic upload waits for rows, scoped calculations, and model readiness', () => {
  assert.equal(INITIAL_AUTO_UPLOAD_STABLE_MS, 2_000);
  assert.equal(isInitialAutoUploadReady({ rowsPresent: true, dpReady: true, rReady: true, spReady: true, modelsReady: true }), true);
  assert.equal(isInitialAutoUploadReady({ rowsPresent: true, dpReady: true, rReady: true, spReady: false, modelsReady: true }), false);
  assert.equal(isInitialAutoUploadReady({ rowsPresent: true, dpReady: true, rReady: false, spReady: true, modelsReady: true }), false);
  assert.equal(isInitialAutoUploadReady({ rowsPresent: false, dpReady: true, rReady: true, spReady: true, modelsReady: true }), false);
});
