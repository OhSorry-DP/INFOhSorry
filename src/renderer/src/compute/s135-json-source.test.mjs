import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRealm } from './test-support.mjs';

function loadJsonSource(fetch) {
  const realm = createRealm({ fetch });
  const source = fs.readFileSync(new URL('../gistLib.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const api = {};
  vm.runInContext(`(function(exports, require) { ${compiled}\n})`, realm.context)(api, name => {
    if (name === '../../shared/types' || name === '../../shared/match') return {};
    return realm.load(name);
  });
  return api.loadJsonSource;
}

test('loadJsonSource preserves JSON source bytes and parses the same value with one fetch and text read', async () => {
  const source = ' { "text" : "한글 \\u263A \\n", "items" : [1, 2] }\n ';
  const calls = { fetch: 0, text: 0, json: 0 };
  const load = loadJsonSource(async url => {
    calls.fetch++;
    assert.match(url, /^https:\/\/example\.test\/data\.json\?t=\d+$/);
    return { ok: true, async text() { calls.text++; return source; }, async json() { calls.json++; } };
  });
  const result = await load('https://example.test/data.json');
  assert.equal(result.source, source);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), JSON.parse(source));
  assert.deepEqual(calls, { fetch: 1, text: 1, json: 0 });
});

test('loadJsonSource reports the established HTTP error before reading a body', async () => {
  const calls = { fetch: 0, text: 0 };
  const load = loadJsonSource(async () => {
    calls.fetch++;
    return { ok: false, status: 503, async text() { calls.text++; return ''; } };
  });
  await assert.rejects(load('/data.json'), /JSON fetch HTTP 503/);
  assert.deepEqual(calls, { fetch: 1, text: 0 });
});

test('loadJsonSource rejects invalid JSON after one exact text read', async () => {
  const calls = { fetch: 0, text: 0 };
  const load = loadJsonSource(async () => {
    calls.fetch++;
    return { ok: true, async text() { calls.text++; return ' { invalid '; } };
  });
  await assert.rejects(load('/data.json'), error => error?.name === 'SyntaxError');
  assert.deepEqual(calls, { fetch: 1, text: 1 });
});
