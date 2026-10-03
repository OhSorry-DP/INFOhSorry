import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('PERF spans carry stable seq, monotonic duration, revision and anonymous scope', () => {
  const module = { exports: {} };
  const lines = [];
  let now = 10;
  const source = fs.readFileSync(new URL('./perfDiag.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { exports: module.exports, window: { infohsorry: { diag: { append: line => lines.push(line) } } }, performance: { now: () => (now += 2) }, Date, Math, Map });
  const { beginPerf, endPerf, perfEvent } = module.exports;
  const span = beginPerf('dp', 7, 3, 'C000000000001');
  endPerf('dp', span, 7, 3, 'C000000000001', 'error');
  perfEvent('rows-commit', { rowsRev: 8, epoch: 3, rowsCount: 12 });
  assert.match(lines[0], /phase=begin calc=dp seq=1 .*rowsRev=7 scopeId=acct1 epoch=3/);
  assert.match(lines[1], /phase=end calc=dp seq=1 .*durMs=2\.000 .*status=error/);
  assert.match(lines[2], /event=rows-commit rowsRev=8 epoch=3 rowsCount=12/);
  assert.ok(lines.every(line => !line.includes('C000000000001')));
});
