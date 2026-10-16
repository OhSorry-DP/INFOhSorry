import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./accountTsvStore.ts', import.meta.url), 'utf8');

function loadReader(readFileImpl) {
  const start = source.indexOf('export async function readAccountPlayCsv(');
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > 1, 'reader function exists');
  const body = source.slice(start, end)
    .replace('export async function', 'async function')
    .replace('(iidxId: string): Promise<PlayCsvReadResult>', '(iidxId)')
    .replace('(e as NodeJS.ErrnoException)', 'e')
    .replace('(e as Error)', 'e');
  const context = {
    IIDX_RE: /^[A-Z]\d{12}$/,
    accountPlayCsvPath: (id) => /^[A-Z]\d{12}$/.test(id) ? `/virtual/users/${id}/plays.csv` : null,
    fsp: { readFile: readFileImpl },
  };
  vm.createContext(context);
  vm.runInContext(`${body}; this.readAccountPlayCsv = readAccountPlayCsv;`, context);
  return context.readAccountPlayCsv;
}

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
