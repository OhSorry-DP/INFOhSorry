import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRealm, localFetch, localRoot, readData } from './test-support.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('./fixture-manifest.json', import.meta.url), 'utf8'));
const expectedLamp = { NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7 };
const expectedDiff = { DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA' };
const referenceAdapter = charts => charts.flatMap(c => {
  const diff = expectedDiff[c.slot];
  if (!diff || !c.noteCount || c.noteCount <= 0) return [];
  return [{ title: c.title, diff, exScore: c.exScore || 0, noteCount: c.noteCount,
    scorePercent: ((c.exScore || 0) / (c.noteCount * 2)) * 100, lampNum: expectedLamp[c.lamp] ?? 0 }];
});
const copy = value => structuredClone(value);

test('analysis adapter exactly preserves DP slot order, duplicates, and Analysis.tsx values', () => {
  const realm = createRealm();
  const { analysisChartsToWeaknessCharts } = realm.load('./analysisEngine');
  const charts = [
    { title: 'Duplicate', slot: 'DPL', noteCount: 123, exScore: 77, lamp: 'PFC' },
    { title: 'skip SP', slot: 'SPH', noteCount: 20, exScore: 9, lamp: 'HC' },
    { title: 'zero', slot: 'DPN', noteCount: 0, exScore: 0, lamp: 'NP' },
    { title: 'negative', slot: 'DPH', noteCount: -1, exScore: 1, lamp: 'F' },
    { title: 'Duplicate', slot: 'DPL', noteCount: 50, exScore: 0, lamp: 'mystery' },
    { title: 'fractional', slot: 'DPA', noteCount: 2.5, exScore: 3, lamp: 'AC' },
    { title: 'unknown slot', slot: '???', noteCount: 99, exScore: 99, lamp: 'EX' },
  ];
  assert.deepEqual(copy(analysisChartsToWeaknessCharts(realm.dto(charts))), referenceAdapter(charts));
});

test('pinned S3 fixture bytes exist and match every manifest hash', () => {
  for (const [file, expected] of Object.entries(manifest)) {
    const filename = path.join(localRoot, file);
    assert.ok(fs.existsSync(filename), `required pinned fixture is missing: ${filename}`);
    assert.equal(createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), expected, file);
  }
});

test('UMD weakness and pattern score parity in two isolated realms', async () => {
  // Keep this failure explicit when the local s3-fixtures checkout is absent.
  for (const [file, expected] of Object.entries(manifest)) {
    const filename = path.join(localRoot, file);
    assert.ok(fs.existsSync(filename), `required pinned fixture is missing: ${filename}`);
    assert.equal(createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), expected, file);
  }
  const charts = readData('ohSorryRating.json').ratings.filter(c => expectedDiff[`DP${({ NORMAL: 'N', HYPER: 'H', ANOTHER: 'A', LEGGENDARIA: 'L' })[c.diff]}`])
    .slice(0, 80).map((c, i) => ({ title: c.title, slot: ({ NORMAL: 'DPN', HYPER: 'DPH', ANOTHER: 'DPA', LEGGENDARIA: 'DPL' })[c.diff],
      level: c.gameLevel, unlocked: true, lamp: i % 2 ? 'HC' : 'F', letter: 'AA', exScore: 700 + i,
      noteCount: 800 + i, missCount: 3, djPoints: 0 }));
  const expectedCharts = referenceAdapter(charts);
  const realms = [createRealm({ fetch: localFetch }), createRealm({ fetch: localFetch })];
  const outputs = [];
  for (const realm of realms) {
    const { analysisChartsToWeaknessCharts, runAnalysisWeakness, runAnalysisPatternScore } = realm.load('./analysisEngine');
    const { libs } = await realm.load('./workerResources').createWorkerResources().load('weakness');
    const featureScores = JSON.parse(fs.readFileSync(path.join(localRoot, 'dist/feature-scores-slim.json'), 'utf8'));
    libs.featureScores = realm.dto(featureScores);
    libs.computePatternScoreVec = libs.OhsorryWeakness.computePatternScoreVec;
    const dtoCharts = realm.dto(charts);
    assert.deepEqual(copy(analysisChartsToWeaknessCharts(dtoCharts)), expectedCharts);
    const actualWeakness = runAnalysisWeakness(dtoCharts, libs);
    const expectedVec = libs.OhsorryWeakness.calcUserWeakness({ allCharts: realm.dto(expectedCharts), patternsMap: libs.patterns,
      normFn: libs.OhsorryNorm.norm, ratingMap: libs.rating?.ratings || null, zasaMap: libs.zasa?.charts || null, rateRef: libs.rateRef });
    assert.ok(expectedVec.__entries);
    assert.deepEqual(copy(actualWeakness), { vec: copy(expectedVec), allCharts: expectedCharts });
    const score = await runAnalysisPatternScore(dtoCharts, libs);
    const expectedScore = libs.OhsorryWeakness.computePatternScoreVec({ charts: realm.dto(expectedCharts), featureScores: libs.featureScores,
      patternsMap: libs.patterns, normFn: libs.OhsorryNorm.norm });
    assert.deepEqual(copy(score?.vec), copy(expectedScore));
    outputs.push({ weak: copy(actualWeakness), score: copy(score) });
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test('null and error policies, all pattern dimensions, and digest scalar/order semantics', async () => {
  const realm = createRealm();
  const engine = realm.load('./analysisEngine');
  const { runAnalysisWeakness, runAnalysisPatternScore, analysisChartsToWeaknessCharts } = engine;
  const charts = [{ title: 'T', slot: 'DPN', noteCount: 10, exScore: 5, lamp: 'FC' }];
  const noopNorm = { norm: s => s };
  const scoreLib = (value, featureScores = {}) => ({ OhsorryNorm: noopNorm, patterns: {}, featureScores,
    computePatternScoreVec: () => value });
  assert.equal(runAnalysisWeakness([], { OhsorryNorm: noopNorm, OhsorryWeakness: { calcUserWeakness: () => { throw Error('called'); } } }), null);
  assert.equal(runAnalysisWeakness(realm.dto(charts), { OhsorryNorm: noopNorm, patterns: {}, OhsorryWeakness: { calcUserWeakness: () => ({}) } }), null);
  assert.throws(() => runAnalysisWeakness(realm.dto(charts), { OhsorryNorm: noopNorm, patterns: {},
    OhsorryWeakness: { calcUserWeakness: () => { throw Error('weak failure'); } } }), /weak failure/);
  assert.equal(await runAnalysisPatternScore(realm.dto(charts), scoreLib(1, null)), null);
  assert.equal(await runAnalysisPatternScore(realm.dto([]), scoreLib(1)), null);
  assert.equal(await runAnalysisPatternScore(realm.dto(charts), { OhsorryNorm: noopNorm, featureScores: {} }), null);
  assert.equal(await runAnalysisPatternScore(realm.dto(charts), scoreLib(null)), null);

  const dims = ['NOTES', 'CHORD', 'PEAK', 'CHARGE', 'SCRATCH', 'SOF-LAN', 'PHRASE', 'JACK', 'TRILL', 'RAND'];
  const axisVec = realm.eval(`Object.fromEntries(${JSON.stringify(dims)}.map((k, i) => [k, i + 1]))`);
  assert.deepEqual(copy((await runAnalysisPatternScore(realm.dto(charts), scoreLib(axisVec))).vec), copy(axisVec));
  const hands = realm.eval('({ HANDS: { LEFT: 2, RIGHT: 3 } })');
  assert.deepEqual(copy((await runAnalysisPatternScore(realm.dto(charts), scoreLib(hands))).vec), copy(hands));
  const newEight = realm.eval("Object.fromEntries(['GLUE', 'SOFLAN', 'CHORDS', 'SCRATCHES', 'JUMPS', 'TRILLS', 'CHARGES', 'PEAKS'].map((k, i) => [k, i]))");
  assert.deepEqual(copy((await runAnalysisPatternScore(realm.dto(charts), scoreLib(newEight))).vec), copy(newEight));
  const scalarVec = realm.eval('({ undef: undefined, nan: NaN, inf: Infinity, ninf: -Infinity, negzero: -0 })');
  const scalar = await runAnalysisPatternScore(realm.dto(charts), scoreLib(scalarVec));
  assert.equal(scalar.vec.undef, undefined);
  assert.ok(Number.isNaN(scalar.vec.nan));
  assert.equal(scalar.vec.inf, Infinity);
  assert.equal(scalar.vec.ninf, -Infinity);
  assert.ok(Object.is(scalar.vec.negzero, -0));
  const reordered = await runAnalysisPatternScore(realm.dto(charts), scoreLib(realm.eval('({ negzero: -0, ninf: -Infinity, inf: Infinity, nan: NaN, undef: undefined })')));
  assert.equal(scalar.digest, reordered.digest);
  const zero = await runAnalysisPatternScore(realm.dto(charts), scoreLib(realm.eval('({ value: 0 })')));
  const negativeZero = await runAnalysisPatternScore(realm.dto(charts), scoreLib(realm.eval('({ value: -0 })')));
  assert.notEqual(zero.digest, negativeZero.digest);
  realm.context.__axisVec = axisVec;
  const changedAxis = await runAnalysisPatternScore(realm.dto(charts), scoreLib(realm.eval('Object.assign({}, globalThis.__axisVec, { NOTES: 999 })')));
  assert.notEqual((await runAnalysisPatternScore(realm.dto(charts), scoreLib(axisVec))).digest, changedAxis.digest);
  assert.deepEqual(copy(analysisChartsToWeaknessCharts(realm.dto(charts))), referenceAdapter(charts));
});
