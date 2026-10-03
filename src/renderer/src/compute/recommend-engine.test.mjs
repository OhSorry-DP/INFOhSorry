import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRealm } from './test-support.mjs';

// S3 uses the frozen current UMDs, independently of S1's historical regression bytes.
const fixtureRoot = path.resolve('scratchpad/s133/s3-fixtures/current');
const readData = file => JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'dist', file), 'utf8'));
const localFetch = async url => {
  const u = new URL(url), filename = decodeURIComponent(u.pathname.split('/').pop());
  const candidate = path.join(fixtureRoot, u.pathname.includes('/lib/') ? 'modules' : 'dist', filename);
  const text = fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(fixtureRoot, filename), 'utf8');
  return { ok: true, status: 200, text: async () => text };
};

const realm = createRealm({ fetch: localFetch });
const resources = realm.load('./workerResources').createWorkerResources();
const specs = [
  ['OhsorryNorm', 'normTitle.js'], ['OhsorryWeakness', 'calcWeakness.js'], ['OhsorryRecommend', 'recommend.js'],
].map(([key, file]) => ({ key, globalKey: key, url: `https://data.iidx.in/lib/${file}` }));
for (const [key, file] of Object.entries({ patterns: 'patterns-dp-1112.json', rateRef: 'rate-reference-slim.json',
  featureScores: 'feature-scores-slim.json', textageMeta: 'textage-meta.json', weaknessPopMean: 'weakness-popmean.json',
  rating: 'ohSorryRating.json', zasa: 'zasa-data.json', ereter: 'ereter-data.json' })) {
  specs.push({ key, url: `https://data.iidx.in/data/${file}` });
}
const libs = (await resources.load('weakness', specs)).libs;
libs.seriesNames = realm.dto({});
const rating = readData('ohSorryRating.json');
const slots = { NORMAL: 'DPN', HYPER: 'DPH', ANOTHER: 'DPA', LEGGENDARIA: 'DPL' };
const rows = rating.ratings.filter(r => slots[r.diff]).slice(0, 180).map((r, i) => ({ title: r.title, type: '', label: '',
  charts: { [slots[r.diff]]: { unlocked: true, level: r.gameLevel, lamp: i % 3 ? 'HC' : 'F', letter: 'AA',
    exScore: 1400 + i % 250, noteCount: 1000, missCount: 10, djPoints: 0 } } }));
const input = realm.dto({ rows, osrCharts: [], songs: null, notInInf: [] });
const { createRecCtx } = realm.load('../recommendCore');
const { createRecommendEngine } = realm.load('./recommendEngine');
const canonical = () => createRecCtx({ rows: input.rows, ratingData: libs.rating, zasaData: libs.zasa, ereterData: libs.ereter,
  libs: { weakness: libs.OhsorryWeakness, normLib: libs.OhsorryNorm, recommend: libs.OhsorryRecommend,
    patterns: libs.patterns, rateRef: libs.rateRef, featureScores: libs.featureScores, textageMeta: libs.textageMeta,
    seriesNames: libs.seriesNames, weaknessPopMean: libs.weaknessPopMean } });
const rng = () => realm.eval(`globalThis.__draws = 0; var seed = 1337; Math.random = () => {
  __draws++; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296;
};`);
const raw = row => { const { _cardHashtags, _cardBestLabel, ...rest } = row; return rest; };

test('clear pools preserve canonical picked, pool, raw tags, layouts and RNG consumption', () => {
  for (const layout of ['on', 'off']) for (const stage of ['ec', 'hc', 'exh']) {
    const engine = createRecommendEngine(); engine.context('ctx', input, libs);
    const ctx = canonical(); ctx.setLayoutMode(layout);
    rng();
    const expected = ctx.buildRecsWithPool({ ec: 3, hc: 5, exh: 6 }[stage], stage, 8, 'lv11+12', 'off', { randomize: true });
    const draws = realm.eval('__draws');
    rng();
    const opts = realm.dto({ contextHandle: 'ctx', operation: 'clear-pool', layout, stage, baseStar: 8,
      levelMode: 'lv11+12', djMode: 'off', rerollToken: 0 });
    const actual = engine.query('ctx', opts);
    assert.deepEqual(structuredClone({ picked: actual.picked.map(raw), pool: actual.pool.map(raw) }), structuredClone(expected));
    assert.equal(realm.eval('__draws'), draws);
    engine.query('ctx', opts);
    assert.equal(realm.eval('__draws'), draws, 'retry must not consume RNG');
    for (const row of [...actual.picked, ...actual.pool]) {
      const r = realm.dto({ title: row.title, chart: row.chart, _category: ['easy', 'hard', 'cleanup'].includes(row._category) ? row._category : 'cleanup' });
      const match = ctx.chartStrengthMatchByHand(r);
      const tags = ctx.computeChartTags(r);
      assert.equal(row._cardBestLabel, match?.bestLabel || '');
      assert.equal(row._cardHashtags, ctx.computeRecHashtags({ ...r, _matchByHand: match, _tags: tags }).join(' '));
    }
  }
});

test('practice results preserve canonical RNG and same-token retry', () => {
  for (const mode of ['all', 'CHARGE', 'SCRATCH', 'SOF-LAN']) for (const layout of ['on', 'off']) {
  const engine = createRecommendEngine(); engine.context('ctx', input, libs);
  const ctx = canonical(); ctx.setLayoutMode(layout);
  const practice = realm.dto({ mode, topN: 10, handMode: 'both', strength: 1, flipOn: true, randomize: true });
  rng(); const expected = ctx.buildWeaknessRecs(8, practice); const draws = realm.eval('__draws');
  rng(); const opts = realm.dto({ contextHandle: 'ctx', operation: 'practice', layout, baseStar: 8, practice, rerollToken: 1 });
  const actual = engine.query('ctx', opts);
  assert.deepEqual(structuredClone(actual.map(raw)), structuredClone(expected));
  assert.equal(realm.eval('__draws'), draws);
  engine.query('ctx', opts); assert.equal(realm.eval('__draws'), draws);
  rng();
  const fromCachedPool = engine.query('ctx', realm.dto({ ...opts, rerollToken: 2 }));
  assert.deepEqual(structuredClone(fromCachedPool.map(raw)), structuredClone(expected));
  assert.equal(realm.eval('__draws'), draws);
  }
});

test('context handle LRU is limited to two and pattern snapshots do not mutate resource data', () => {
  const engine = createRecommendEngine();
  const before = JSON.stringify(libs.patterns);
  const id = Object.keys(libs.patterns)[0];
  const extended = { ...libs, patterns0810: realm.dto({ [id]: { c: { DP_NOR: { fixture: true } } } }) };
  engine.context('one', input, extended); engine.context('two', input, libs);
  assert.equal(JSON.stringify(libs.patterns), before);
  engine.context('one', input, extended); engine.context('three', input, libs);
  assert.throws(() => engine.query('two', realm.dto({ operation: 'cards', layout: 'on', rows: [] })), /CONTEXT_MISSING/);
  engine.clear();
  assert.throws(() => engine.query('one', realm.dto({ operation: 'cards', layout: 'on', rows: [] })), /CONTEXT_MISSING/);
});

test('songs ac/legen candidates and manual exclusions match renderer INF filtering', () => {
  const title = rows[0].title;
  const charts = realm.dto({ DPN: rows[0].charts[Object.keys(rows[0].charts)[0]], DPL: rows[0].charts[Object.keys(rows[0].charts)[0]] });
  let captured;
  const wrapping = { ...libs, OhsorryRecommend: { ...libs.OhsorryRecommend, createContext(deps) {
    captured = deps;
    return libs.OhsorryRecommend.createContext(deps);
  } } };
  const engine = createRecommendEngine();
  engine.context('filtered', realm.dto({ ...input, rows: [{ ...rows[0], charts }],
    songs: [{ title, ac: 2, legen: 0 }], notInInf: [] }), wrapping);
  assert.deepEqual(structuredClone(captured.allCharts.map(c => c.slot)), ['DPN']);
  assert.equal(captured.isInfChartInSeries(title, 'DP_LEG'), false);
  engine.context('excluded', realm.dto({ ...input, rows: [{ ...rows[0], charts }], songs: null,
    notInInf: [libs.OhsorryNorm.norm(title) + '|DPN'] }), wrapping);
  assert.deepEqual(structuredClone(captured.allCharts.map(c => c.slot)), ['DPL']);
});

const { recRowToCandidate, refreshRecs } = realm.load('./recommendPresentation');
const cardReference = (ctx, row) => {
  const categories = { 'challenge-hard': 'hard', 'challenge-easy': 'easy', cleanup: 'cleanup', 'exh-near': 'cleanup' };
  const category = row.category ? categories[row.category] : ['easy', 'hard', 'cleanup'].includes(row._category) ? row._category : 'cleanup';
  const chart = realm.dto({ title: row.title, chart: row.chart || row.diff, _category: category || 'cleanup' });
  const match = ctx.chartStrengthMatchByHand(chart), tags = ctx.computeChartTags(chart);
  return { ...row, _cardHashtags: ctx.computeRecHashtags({ ...chart, _matchByHand: match, _tags: tags }).join(' '),
    _cardBestLabel: match?.bestLabel || '' };
};

test('low pattern bands, variant INF level and songs filters preserve independent synchronous reference', () => {
  const bands = [readData('patterns-dp-0810.json'), readData('patterns-dp-rest.json')];
  // Merge fixture snapshots separately from the engine's snapshot implementation.
  const merged = structuredClone(libs.patterns);
  for (const band of bands) for (const [id, song] of Object.entries(band)) {
    if (!merged[id]) merged[id] = structuredClone(song);
    else merged[id].c = { ...merged[id].c, ...structuredClone(song.c) };
  }
  const variant = rating.ratings.find(r => r.title === 'MAX 300' && r.diff === 'ANOTHER');
  assert.ok(variant && typeof variant.gameLevel === 'number');
  const cell = { unlocked: true, level: variant.gameLevel - 2, lamp: 'HC', letter: 'AA',
    exScore: 1200, noteCount: 1000, missCount: 20, djPoints: 0 };
  const fixtureRows = [...rows, { title: variant.title, type: '', label: '', charts: { DPA: cell, DPL: cell } }];
  const songs = Object.values(merged).map(song => ({ title: song.t, ac: 2, legen: 0 }));
  // Duplicate metadata can grant LEGGENDARIA even when the first matching row cannot.
  songs.push({ title: variant.title, ac: 0, legen: 2 });
  const excludedTitle = rows[0].title, excludedSlot = Object.keys(rows[0].charts)[0];
  const excluded = [libs.OhsorryNorm.norm(excludedTitle) + '|' + excludedSlot];
  const fixtureInput = realm.dto({ rows: fixtureRows, osrCharts: [], songs, notInInf: excluded });
  const extraLibs = { ...libs, patterns0810: realm.dto(bands[0]), patternsRest: realm.dto(bands[1]) };
  const slotByChart = { DP_NOR: 'DPN', DP_HYP: 'DPH', DP_ANO: 'DPA', DP_LEG: 'DPL' };
  const isInfChart = (title, chartName) => {
    const key = libs.OhsorryNorm.norm(title);
    if (slotByChart[chartName] && excluded.includes(key + '|' + slotByChart[chartName])) return false;
    return songs.some(song => libs.OhsorryNorm.norm(song.title) === key
      && ((chartName === 'DP_LEG' ? song.legen : song.ac) & 2) !== 0);
  };
  let referenceDeps, workerDeps;
  const capture = setter => ({ ...libs.OhsorryRecommend, createContext(deps) {
    setter(deps); return libs.OhsorryRecommend.createContext(deps);
  } });
  const reference = createRecCtx({ rows: fixtureInput.rows, ratingData: libs.rating, zasaData: libs.zasa,
    ereterData: libs.ereter, isInfChart, libs: { weakness: libs.OhsorryWeakness, normLib: libs.OhsorryNorm,
      recommend: capture(deps => referenceDeps = deps), patterns: realm.dto(merged), rateRef: libs.rateRef,
      featureScores: libs.featureScores, textageMeta: libs.textageMeta, seriesNames: libs.seriesNames,
      weaknessPopMean: libs.weaknessPopMean } });
  const engine = createRecommendEngine();
  engine.context('bands', fixtureInput, { ...extraLibs, OhsorryRecommend: capture(deps => workerDeps = deps) });
  assert.deepEqual(structuredClone(workerDeps.allCharts), structuredClone(referenceDeps.allCharts));
  assert.equal(workerDeps.allCharts.find(c => c.title === variant.title && c.slot === 'DPA' && c.gameLevel === cell.level).textageId, '@inf');
  assert.equal(workerDeps.allCharts.some(c => c.title === excludedTitle && c.slot === excludedSlot), false);
  assert.deepEqual(structuredClone(workerDeps.patternsMap), merged);
  for (const layout of ['on', 'off']) {
    reference.setLayoutMode(layout);
    rng(); const expected = reference.buildRecsWithPool(3, 'ec', 3, 'lv11+12', 'off', { randomize: true });
    rng(); const actual = engine.query('bands', realm.dto({ operation: 'clear-pool', contextHandle: 'bands', layout,
      stage: 'ec', baseStar: 3, levelMode: 'lv11+12', djMode: 'off', rerollToken: layout }));
    assert.deepEqual(structuredClone({ picked: actual.picked.map(raw), pool: actual.pool.map(raw) }), structuredClone(expected));
    const practice = realm.dto({ mode: 'all', topN: 10, randomize: true, zasaMin: 1, zasaMax: 13,
      minZasa: 1, maxZasa: 13, handMode: 'both', strength: 1, flipOn: true });
    rng(); const expectedPractice = reference.buildWeaknessRecs(3, practice);
    rng(); const actualPractice = engine.query('bands', realm.dto({ operation: 'practice', contextHandle: 'bands', layout,
      baseStar: 3, practice, rerollToken: layout }));
    assert.deepEqual(structuredClone(actualPractice.map(raw)), structuredClone(expectedPractice));
  }
});

test('candidate presentation and refresh drop/refill preserve synchronous mapping and card DTOs', () => {
  const engine = createRecommendEngine(); engine.context('candidate', input, libs);
  const ctx = canonical(); ctx.setLayoutMode('on');
  for (const stage of ['ec', 'hc', 'exh']) {
    rng(); const canonicalPool = ctx.buildRecsWithPool({ ec: 3, hc: 5, exh: 6 }[stage], stage, 8, 'lv11+12', 'off', { randomize: true });
    const expected = { picked: canonicalPool.picked.map(row => recRowToCandidate(cardReference(ctx, row), stage)),
      pool: canonicalPool.pool.map(row => recRowToCandidate(cardReference(ctx, row), stage)) };
    rng(); const actual = engine.query('candidate', realm.dto({ operation: 'clear-pool', contextHandle: 'candidate', layout: 'on',
      stage, baseStar: 8, levelMode: 'lv11+12', djMode: 'off', presentation: 'candidate', rerollToken: stage }));
    assert.deepEqual(structuredClone(actual), structuredClone(expected));
    assert.ok(actual.picked.length > 1 && actual.pool.length > 0, 'fixture must exercise refill');
    const completed = actual.picked[0], updated = actual.picked[1];
    const charts = realm.dto([{ ...completed, lamp: 'FC', lampNum: 7, djLevel: 'AAA' },
      { ...updated, lamp: updated.currentLamp, lampNum: updated.lampNum, exScore: 1111, noteCount: 1000, missCount: 17 }]);
    const refreshed = refreshRecs(realm.dto(actual), stage, charts, 'off');
    const enrich = row => { const decorated = cardReference(ctx, row); return { ...row,
      cardHashtags: decorated._cardHashtags, cardBestLabel: decorated._cardBestLabel }; };
    const expectedRefresh = { picked: refreshed.picked.map(enrich), pool: refreshed.pool.map(enrich) };
    const actualRefresh = engine.query('candidate', realm.dto({ operation: 'refresh', contextHandle: 'candidate', layout: 'on',
      stage, previous: actual, charts, djMode: 'off' }));
    assert.deepEqual(structuredClone(actualRefresh), structuredClone(expectedRefresh));
    assert.equal(actualRefresh.picked.some(r => r.title === completed.title && r.slot === completed.slot), false);
    assert.equal(actualRefresh.picked.length, actual.picked.length);
    assert.ok(actualRefresh.pool.length < actual.pool.length);
  }
  const practice = realm.dto({ mode: 'all', topN: 10, randomize: true, handMode: 'both', strength: 1, flipOn: true });
  rng(); const expectedPractice = ctx.buildWeaknessRecs(8, practice).map(row => recRowToCandidate(cardReference(ctx, row), 'weakness'));
  rng(); const actualPractice = engine.query('candidate', realm.dto({ operation: 'practice', contextHandle: 'candidate', layout: 'on',
    baseStar: 8, practice, presentation: 'candidate', rerollToken: 'practice' }));
  assert.deepEqual(structuredClone(actualPractice), structuredClone(expectedPractice));
  for (const stage of ['hc', 'exh']) assert.deepEqual(structuredClone(engine.query('candidate', realm.dto({
    operation: 'clear-pool', contextHandle: 'candidate', layout: 'on', stage, baseStar: 0.49, presentation: 'candidate',
  }))), { picked: [], pool: [] });
});
