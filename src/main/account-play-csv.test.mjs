import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./accountTsvStore.ts', import.meta.url), 'utf8');

function loadReader(readFileImpl) {
  const start = source.indexOf('export async function readAccountPlayCsv(');
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > 1, 'reader function exists');
  const validatorStart = source.indexOf('function isPlayDetail(');
  const validatorEnd = source.indexOf('\n}', validatorStart) + 2;
  const selected = source.slice(validatorStart, validatorEnd) + '\n' + source.slice(start, end);
  const code = ts.transpileModule(selected, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = {
    exports: {},
    IIDX_RE: /^[A-Z]\d{12}$/,
    accountPlayCsvPath: (id) => /^[A-Z]\d{12}$/.test(id) ? `/virtual/users/${id}/plays.csv` : null,
    accountPlayDetailPath: (id) => `/virtual/users/${id}/plays_detail.jsonl`,
    fsp: { readFile: readFileImpl },
  };
  vm.createContext(context);
  vm.runInContext(`${code}; this.readAccountPlayCsv = readAccountPlayCsv;`, context);
  return context.readAccountPlayCsv;
}

const detail = (timestamp, samples = 2) => ({
  v: 1, timestamp, complete: true, samples, dt_ms: 10,
  p1: { fs: { fast_great: 0, fast_good: 0, slow_great: 0, slow_good: 0 }, fs_unresolved: 0, fs_ok: true, lanes: Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]), lanes_ok: true, lane_fs: Array.from({ length: 8 }, () => [0, 0, 0, 0]), lane_fs_unresolved: 0 },
  p2: { fs: { fast_great: 0, fast_good: 0, slow_great: 0, slow_good: 0 }, fs_unresolved: 0, fs_ok: true, lanes: Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0]), lanes_ok: true, lane_fs: Array.from({ length: 8 }, () => [0, 0, 0, 0]), lane_fs_unresolved: 0 },
});

test('valid account CSV and empty file are found', async () => {
  const read = loadReader(async (_path, encoding) => {
    assert.equal(encoding, 'utf8');
    return '';
  });
  assert.deepEqual({ ...(await read('A123456789012')) }, { ok: true, csv: '' });
  assert.deepEqual({ ...(await read('B123456789012')) }, { ok: true, csv: '' });
});

test('ENOENT reports an absent CSV', async () => {
  const read = loadReader(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  assert.deepEqual({ ...(await read('A123456789012')) }, { ok: true, found: false, csv: '' });
});

test('other read errors and invalid ids fail', async () => {
  const read = loadReader(async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  assert.equal((await read('A123456789012')).ok, false);
  assert.deepEqual({ ...(await read('invalid')) }, { ok: false, error: 'invalid id' });
});

test('reads details for two timestamps', async () => {
  const a = detail('t1'), b = detail('t2');
  const read = loadReader(async (path) => path.endsWith('plays.csv') ? 'csv' : `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
  assert.deepEqual(Array.from((await read('A123456789012')).details, x => x.timestamp), ['t1', 't2']);
});

test('duplicate timestamp keeps the last valid detail', async () => {
  const read = loadReader(async (path) => path.endsWith('plays.csv') ? 'csv' : `${JSON.stringify(detail('t1', 1))}\n${JSON.stringify(detail('t1', 3))}\n`);
  assert.equal((await read('A123456789012')).details[0].samples, 3);
});

test('invalid JSON line is skipped and next valid detail is read', async () => {
  const good = detail('t1');
  const read = loadReader(async (path) => path.endsWith('plays.csv') ? 'csv' : `not-json\n${JSON.stringify(good)}\n`);
  assert.deepEqual(Array.from((await read('A123456789012')).details, x => x.timestamp), ['t1']);
});

test('incomplete trailing line is skipped', async () => {
  const good = detail('t1');
  const read = loadReader(async (path) => path.endsWith('plays.csv') ? 'csv' : `${JSON.stringify(good)}\n{"v":1`);
  assert.deepEqual(Array.from((await read('A123456789012')).details, x => x.timestamp), ['t1']);
});

test('missing detail file preserves CSV success without details property', async () => {
  const read = loadReader(async (path) => {
    if (path.endsWith('plays.csv')) return 'csv';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  assert.deepEqual({ ...(await read('A123456789012')) }, { ok: true, csv: 'csv' });
});
