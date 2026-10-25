import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const app = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('local calculated card values are scoped while public values remain separate', () => {
  assert.match(app, /cardId === rowsOwnerId \? dp12StarResult : null/);
  assert.match(app, /cardId === rowsOwnerId \? spStarResult\?\.star/);
  assert.doesNotMatch(app, /profile-card-star-note[^\n]*잠정/);
  assert.match(app, /currentUserPublic = userPublicScope/);
});

function logHarness() {
  const start = app.indexOf('  const starTaskStatusRef =');
  const end = app.indexOf('  const dp12StarResult', start);
  const source = app.slice(start, end).replace(/^  /gm, '');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const refs = [], logs = [];
  let cursor = 0;
  let deps, effectFn;
  const context = vm.createContext({
    useRef(initial) { const i = cursor++; refs[i] ??= { current: initial }; return refs[i]; },
    useEffect(fn, next) { effectFn = fn; deps = next; },
    addDiagLine(line) { logs.push(line); },
    dpTask: { task: { status: 'pending' } }, rTask: { task: { status: 'pending' } }, spTask: { task: { status: 'pending' } },
  });
  const run = () => vm.runInContext(`(() => { ${code} })()`, context);
  const render = () => { cursor = 0; run(); effectFn(); };
  return { context, logs, render };
}

test('production status effect logs pending once, task values on ready, errors once, and retry transitions', () => {
  for (const [key, label, result] of [['dp', 'DP★', { star: 12.34 }], ['r', 'r★', 5.67], ['sp', 'SP★', { star: 8.9 }]]) {
    const h = logHarness(); h.render(); h.render();
    assert.equal(h.logs.filter(x => x === `${label} 계산 중`).length, 1);
    const taskName = key === 'dp' ? 'dpTask' : key === 'r' ? 'rTask' : 'spTask';
    h.context[taskName] = { value: key === 'r' ? 999 : { star: 999 }, task: { status: 'ready', value: result } };
    h.render(); h.render();
    const number = key === 'r' ? result : result.star;
    assert.equal(h.logs.filter(x => x === `${label} 계산 완료 ${number.toFixed(2)}`).length, 1);
    h.context[taskName] = { task: { status: 'error' } }; h.render(); h.render();
    assert.equal(h.logs.filter(x => x === `${label} 계산 실패: 알 수 없는 오류`).length, 1);
    h.context[taskName] = { task: { status: 'pending' } }; h.render();
    h.context[taskName] = { task: { status: 'ready', value: key === 'r' ? 0 : null } }; h.render();
    assert.equal(h.logs.filter(x => x === `${label} 계산 중`).length, 2);
    assert.equal(h.logs.at(-1), `${label} 계산 완료 ${key === 'r' ? '0.00' : '-'}`);
  }
});

test('production status effect keeps task logs independent across StrictMode style replay', () => {
  const h = logHarness(); h.render(); h.render(); h.render();
  assert.deepEqual(h.logs, ['DP★ 계산 중', 'r★ 계산 중', 'SP★ 계산 중']);
  h.context.spTask = { task: { status: 'error' } }; h.render(); h.render();
  assert.deepEqual(h.logs.slice(-1), ['SP★ 계산 실패: 알 수 없는 오류']);
});

test('updated star area renders no pending status, one error retry button, and retries only failed tasks', () => {
  const start = app.indexOf("const failed = [dpTask, rTask, spTask]");
  const end = app.indexOf('\n              })()}', start);
  const expression = app.slice(start, end).replace('const failed =', 'const failed =');
  const transpiled = ts.transpileModule(`globalThis.node = (() => { ${expression} })();`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
  const retries = [0, 0, 0];
  const ctx = vm.createContext({ React: { createElement: (type, props, children) => ({ type, props, children }) },
    dpTask: { task: { status: 'pending' }, retry: () => retries[0]++ },
    rTask: { task: { status: 'error' }, retry: () => retries[1]++ },
    spTask: { task: { status: 'ready' }, retry: () => retries[2]++ } });
  ctx.React.createElement = (type, props, children) => ({ type, props, children });
  vm.runInContext(transpiled, ctx);
  const button = ctx.node;
  assert.equal(button.type, 'button'); assert.equal(button.children, '다시 계산');
  button.props.onClick(); assert.deepEqual(retries, [0, 1, 0]);
  ctx.dpTask.task.status = 'pending'; ctx.rTask.task.status = 'pending';
  const pending = ts.transpileModule(`globalThis.node = (() => { ${expression} })();`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInContext(pending, ctx); assert.equal(ctx.node, null);
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
