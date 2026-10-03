import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../PlayData.tsx', import.meta.url), 'utf8');

test('PlayData requests only the status DTO and preserves ready/null display semantics', () => {
  assert.match(source, /useComputeTask<\{\s*entriesCount:\s*number\s*\}>\('weakness',\s*playInput,\s*\{\s*resultShape:\s*'playdata-status-v1'\s*\}/);
  assert.match(source, /const libsReady = weaknessTask\.task\.status === 'ready';/);
  assert.match(source, /weaknessTask\.task\.status === 'pending' \? '약점 계산 중' : weaknessTask\.task\.status === 'error' \? '약점 계산 실패' : weaknessTask\.value == null \? '약점 N\/A' : ''/);
  assert.doesNotMatch(source, /entriesCount\s*===?\s*0|entriesCount\s*[<>]=?\s*0/);
  assert.match(source, /!!songsById && style === 'dp' && layoutMode && weaknessTask\.task\.status === 'ready'/);
  assert.match(source, /useComputeTask<\[string, string\]\[]>\('layout',\s*layoutInput,\s*\{ style, layoutMode \}/);
});

test('retry remains status driven for weakness and layout errors', () => {
  assert.match(source, /\(weaknessTask\.task\.status === 'error' \|\| layoutTask\.task\.status === 'error'\)/);
  assert.match(source, /if \(weaknessTask\.task\.status === 'error'\) weaknessTask\.retry\(\);/);
  assert.match(source, /if \(layoutTask\.task\.status === 'error'\) layoutTask\.retry\(\);/);
});
