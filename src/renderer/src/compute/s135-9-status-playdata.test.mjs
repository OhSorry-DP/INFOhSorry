import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';

const source = fs.readFileSync(new URL('../PlayData.tsx', import.meta.url), 'utf8');

function extractStatusJsx(text = source) {
  const file = ts.createSourceFile('PlayData.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      if (opening.tagName.getText(file) === 'div' && opening.attributes.properties.some((a) =>
        ts.isJsxAttribute(a) && a.name.getText(file) === 'data-testid' && a.initializer?.getText(file) === '"playdata-compute-status"')) {
        found = node;
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found, 'status JSX div should exist in the TypeScript AST');
  return found.getText(file);
}

function runStatus(jsx, weaknessStatus, weaknessValue, layoutStatus, layoutMode = true, style = 'dp') {
  const js = ts.transpileModule(`function Status({ weaknessTask, layoutTask, layoutMode, style }) { return (${jsx}); }`, {
    compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(`const React = require('react');\n${js}\nmodule.exports = { Status };`, { module, exports: module.exports, require: (name) => name === 'react' ? React : require(name) });
  const weaknessCalls = [], layoutCalls = [];
  const weaknessTask = { task: { status: weaknessStatus }, value: weaknessValue, retry: () => weaknessCalls.push('weakness') };
  const layoutTask = { task: { status: layoutStatus }, value: null, retry: () => layoutCalls.push('layout') };
  const element = module.exports.Status({ weaknessTask, layoutTask, layoutMode, style });
  return { element, weaknessCalls, layoutCalls };
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

function assertStatus(result, expected, { retry = false } = {}) {
  const { element } = result;
  assert.equal(element.type, 'div');
  assert.equal(element.props['data-testid'], 'playdata-compute-status');
  assert.equal(element.props.role, 'status');
  assert.equal(element.props['aria-live'], 'polite');
  assert.equal(textOf(element.props.children[0]), expected);
  const span = element.props.children[0];
  assert.equal(span.type, 'span');
  assert.deepEqual({ minWidth: span.props.style.minWidth, overflow: span.props.style.overflow,
    textOverflow: span.props.style.textOverflow, whiteSpace: span.props.style.whiteSpace },
  { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
  if (retry) {
    const button = element.props.children[1];
    assert.equal(button.type, 'button');
    assert.equal(button.props.children, '다시 계산');
    assert.deepEqual({ height: button.props.style.height, maxHeight: button.props.style.maxHeight,
      boxSizing: button.props.style.boxSizing, padding: button.props.style.padding,
      lineHeight: button.props.style.lineHeight, whiteSpace: button.props.style.whiteSpace,
      flexShrink: button.props.style.flexShrink },
    { height: 24, maxHeight: 24, boxSizing: 'border-box', padding: '0 8px', lineHeight: '20px', whiteSpace: 'nowrap', flexShrink: 0 });
  } else assert.equal(element.props.children[1], false);
}

function assertStableLayout(result, retry = false) {
  const { element } = result;
  assert.ok(element, 'status div remains mounted');
  const style = element.props.style;
  assert.deepEqual({ height: style.height, minHeight: style.minHeight, maxHeight: style.maxHeight,
    boxSizing: style.boxSizing, display: style.display, alignItems: style.alignItems, gap: style.gap,
    overflow: style.overflow, whiteSpace: style.whiteSpace, flexShrink: style.flexShrink },
  { height: 28, minHeight: 28, maxHeight: 28, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8,
    overflow: 'hidden', whiteSpace: 'nowrap', flexShrink: 0 });
  if (retry) {
    const button = element.props.children[1];
    assert.equal(button.props.style.height, 24);
    assert.equal(button.props.style.flexShrink, 0);
  }
}

test('PlayData requests only the status DTO and preserves ready/null and activation contracts', () => {
  assert.match(source, /useComputeTask<\{\s*entriesCount:\s*number\s*\}>\('weakness',\s*playInput,\s*\{\s*resultShape:\s*'playdata-status-v1'\s*\}/);
  assert.match(source, /const libsReady = weaknessTask\.task\.status === 'ready';/);
  assert.match(source, /!!songsById && style === 'dp' && layoutMode && weaknessTask\.task\.status === 'ready'/);
  assert.match(source, /useComputeTask<\[string, string\]\[]>\('layout',\s*layoutInput,\s*\{ style, layoutMode \}/);
  assert.match(source, /layoutTask\.task\.status === 'ready'\s*&& layoutTask\.value/);
  assert.doesNotMatch(source, /entriesCount\s*===?\s*0|entriesCount\s*[<>]=?\s*0/);
  const cases = [
    ['initial pending null', 'pending', null, 'pending', true, 'dp', ''],
    ['pending retains previous DTO', 'pending', { entriesCount: 3 }, 'pending', true, 'dp', ''],
    ['ready DTO with zero entries', 'ready', { entriesCount: 0 }, 'ready', true, 'dp', ''],
    ['ready null', 'ready', null, 'ready', true, 'dp', '약점 N/A'],
    ['weakness error', 'error', { entriesCount: 3 }, 'ready', true, 'dp', '약점 계산 실패'],
    ['DP layout error', 'ready', { entriesCount: 3 }, 'error', true, 'dp', ' · 배치 계산 실패'],
    ['SP layout error', 'ready', { entriesCount: 3 }, 'error', true, 'sp', ''],
    ['layout off error', 'ready', { entriesCount: 3 }, 'error', false, 'dp', ''],
  ];
  for (const [name, ws, value, ls, mode, style, expected] of cases) {
    const result = runStatus(extractStatusJsx(), ws, value, ls, mode, style);
    assertStatus(result, expected, { retry: ws === 'error' || ls === 'error' });
    assertStableLayout(result, ws === 'error' || ls === 'error');
    assert.ok(!textOf(result.element).includes('계산 중'), `${name}: pending progress text absent`);
    assert.equal(textOf(result.element).includes('N/A'), ws === 'ready' && value == null, `${name}: N/A only for ready null`);
  }
});

test('retry button appears for errors and calls only the retries whose tasks failed', () => {
  for (const [ws, ls, weaknessCount, layoutCount] of [['error', 'ready', 1, 0], ['ready', 'error', 0, 1], ['error', 'error', 1, 1]]) {
    const result = runStatus(extractStatusJsx(), ws, null, ls);
    const button = result.element.props.children[1];
    assert.equal(button.type, 'button');
    button.props.onClick();
    assert.equal(result.weaknessCalls.length, weaknessCount);
    assert.equal(result.layoutCalls.length, layoutCount);
  }
});

test('status element and its fixed box contract hold through repeated ready/pending/error transitions', () => {
  for (let i = 0; i < 20; i++) {
    for (const [ws, value, ls] of [['ready', { entriesCount: i }, 'ready'], ['pending', { entriesCount: i }, 'pending'], ['ready', { entriesCount: i + 1 }, 'ready'], ['error', null, 'ready'], ['ready', null, 'error']]) {
      const retry = ws === 'error' || ls === 'error';
      const result = runStatus(extractStatusJsx(), ws, value, ls);
      assertStableLayout(result, retry);
      assert.equal(result.element.type, 'div');
      if (retry) assert.equal(result.element.props.children[1].props.style.flexShrink, 0);
    }
  }
});

test('in-memory defects are rejected by the same display and layout assertions', () => {
  const original = extractStatusJsx();
  const progressDefect = original.replace(
    "{weaknessTask.task.status === 'error' ? '약점 계산 실패' : weaknessTask.task.status === 'ready' && weaknessTask.value == null ? '약점 N/A' : ''}",
    "{weaknessTask.task.status === 'pending' ? '약점 계산 중' : weaknessTask.task.status === 'error' ? '약점 계산 실패' : weaknessTask.task.status === 'ready' && weaknessTask.value == null ? '약점 N/A' : ''}");
  assert.notEqual(progressDefect, original, 'pending progress mutation must be applied');
  assert.throws(() => assertStatus(runStatus(progressDefect, 'pending', null, 'pending'), ''));

  const heightDefect = original.replace('height: 28, ', '');
  assert.notEqual(heightDefect, original, 'outer fixed-height mutation must be applied');
  assert.throws(() => assertStableLayout(runStatus(heightDefect, 'ready', { entriesCount: 1 }, 'ready')));
});
