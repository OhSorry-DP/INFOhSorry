import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import { createRealm } from './test-support.mjs';

function snapshotHarness() {
  const realm = createRealm(), slots = [], effects = [], urls = new Map(), revoked = [];
  let cursor = 0, dirty = false, nextUrl = 0;
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; dirty = true; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; const old = slots[i]; if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((v, n) => !Object.is(v, slots[i].deps[n]))) effects.push(() => {
      slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const source = fs.readFileSync(new URL('../Analysis.tsx', import.meta.url), 'utf8');
  const snippet = source.slice(source.indexOf('  const resourceToken ='), source.indexOf('  const [personal,'));
  const compiled = ts.transpileModule(`function snapshot(bundle: any, ratingData: any, zasaData: any) { ${snippet} return resources; }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const emitted = [];
  const snapshot = new Function('useMemo', 'useState', 'useRef', 'useEffect', 'DEFAULT_RESOURCES', 'span', 'finish', 'setError', 'URL', 'Blob', 'perfEvent',
    `${compiled}; return snapshot;`)(react.useMemo, react.useState, react.useRef, react.useEffect,
      realm.load('./workerResources').DEFAULT_RESOURCES, () => ({}), () => {}, e => { throw e; },
      { createObjectURL(blob) { const id = `blob:test-${++nextUrl}`; urls.set(id, blob); return id; }, revokeObjectURL(id) { revoked.push(id); } }, Blob,
      (...args) => emitted.push(args));
  const args = { bundle: undefined, rating: null, zasa: null };
  function render() { cursor = 0; dirty = false; snapshot(args.bundle, args.rating, args.zasa); effects.splice(0).forEach(run => run());
    if (dirty) { cursor = 0; dirty = false; return snapshot(args.bundle, args.rating, args.zasa); } return undefined; }
  async function body(url) { const blob = urls.get(url); return blob && await blob.text(); }
  return { args, render, body, urls, revoked, emitted, cleanup() { slots.forEach(s => s?.cleanup?.()); } };
}

function loadedBundle(overrides = {}) {
  const patterns = '{ "charts" : [1, 2] }', rateRef = '{"rate":3}', featureScores = '{ "scores" : {"A":4} }';
  return { patternsMap: JSON.parse(patterns), rateRef: JSON.parse(rateRef), featureScores: JSON.parse(featureScores),
    jsonSources: { patterns, rateRef, featureScores }, normSource: { source: 'window.norm = 1;' },
    weaknessSource: { source: 'window.weak = 1;' }, ...overrides };
}

test('loaded JSON source bytes and parsed values are published together without stringify fallback', async () => {
  const h = snapshotHarness(); h.args.bundle = loadedBundle();
  const specs = h.render();
  const pattern = specs.pattern.find(s => s.key === 'patterns');
  const rate = specs.weakness.find(s => s.key === 'rateRef');
  const scores = specs.pattern.find(s => s.key === 'featureScores');
  assert.equal(await h.body(pattern.url), '{ "charts" : [1, 2] }');
  assert.equal(await h.body(rate.url), '{"rate":3}');
  assert.equal(await h.body(scores.url), '{ "scores" : {"A":4} }');
  for (const spec of [pattern, rate, scores]) assert.deepEqual(JSON.parse(await h.body(spec.url)), h.args.bundle[({ patterns: 'patternsMap', rateRef: 'rateRef', featureScores: 'featureScores' })[spec.key]]);
  assert.equal(h.emitted.filter(([event, fields]) => event === 'analysis-snapshot-resource' && ['patterns', 'rateRef', 'featureScores'].includes(fields.key) && fields.sourceKind === 'raw-json').length, 3);
  h.cleanup();
});

test('missing feature score source maps null to a null URL while other JSON sources remain raw', () => {
  const bundle = loadedBundle({ featureScores: null, jsonSources: { patterns: '{"p":1}', rateRef: '{"r":2}' } });
  const h = snapshotHarness(); h.args.bundle = bundle;
  const specs = h.render();
  assert.equal(specs.pattern.find(s => s.key === 'featureScores').url, null);
  const event = h.emitted.find(([name, fields]) => name === 'analysis-snapshot-resource' && fields.key === 'featureScores');
  assert.equal(event[1].sourceKind, 'null');
  h.cleanup();
});

test('stale generation is rejected before publishing its source and parsed value bundle', () => {
  const source = fs.readFileSync(new URL('../Analysis.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(cancelled \|\| currentGeneration !== generation\) \{ finish\('analysisLoad', p, false\); return; \}[\s\S]{0,400}setBundle\(Object\.freeze\(/);
  assert.match(source, /jsonSources: \{ patterns: patterns\.source, rateRef: rate\.source/);
  assert.match(source, /featureScores: scores\?\.value \?\? null/);
});

test('shared resources create one URL per key and effect cleanup revokes each URL', () => {
  const h = snapshotHarness(); h.args.bundle = loadedBundle();
  const specs = h.render();
  const all = [...specs.weakness, ...specs.pattern];
  assert.equal(all.filter(s => s.key === 'patterns').length, 2);
  assert.equal(new Set([...h.urls.keys()]).size, h.urls.size);
  h.cleanup();
  assert.deepEqual(new Set(h.revoked), new Set(h.urls.keys()));
});

test('old mock bundles stringify object JSON while rating and zasa continue using prop snapshots', async () => {
  const h = snapshotHarness();
  h.args.bundle = { ...loadedBundle(), jsonSources: undefined, rateRef: null, featureScores: { score: 9 } };
  h.args.rating = { ratings: { level: 12 } }; h.args.zasa = { charts: ['x'] };
  const specs = h.render();
  for (const key of ['featureScores', 'rating', 'zasa']) {
    const spec = key === 'featureScores' ? specs.pattern.find(s => s.key === key) : specs.weakness.find(s => s.key === key);
    assert.deepEqual(JSON.parse(await h.body(spec.url)), key === 'featureScores' ? { score: 9 } : h.args[key === 'rating' ? 'rating' : 'zasa']);
  }
  const nullRate = [...specs.weakness, ...specs.pattern].find(s => s.key === 'rateRef');
  assert.equal(nullRate.url, null);
  assert.ok(h.emitted.some(([name, fields]) => name === 'analysis-snapshot-resource' && fields.key === 'featureScores' && fields.sourceKind === 'object-json'));
  h.cleanup();
});
