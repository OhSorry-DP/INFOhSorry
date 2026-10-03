import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRealm, localFetch, readData, localRoot } from './test-support.mjs';

const realm = createRealm({ fetch: localFetch });
const { runKernel, rowsToWeaknessCharts } = realm.load('./kernels');
const resources = realm.load('./workerResources').createWorkerResources();
const { encodeValue, decodeValue } = realm.load('./workerRuntime');
const copy = value => structuredClone(value);
const rating = readData('ohSorryRating.json');
const cpi = readData('cpi.json');
const patterns = readData('patterns-dp-1112.json');
const dp = rating.ratings.filter(c => ['NORMAL', 'HYPER', 'ANOTHER', 'LEGGENDARIA'].includes(c.diff)).slice(0, 180);
const slots = { NORMAL: 'DPN', HYPER: 'DPH', ANOTHER: 'DPA', LEGGENDARIA: 'DPL' };
const rows = dp.map((c, i) => ({ title: c.title, type: '', label: '', charts: { [slots[c.diff]]: {
  unlocked: true, level: c.gameLevel, lamp: i % 3 ? 'HC' : 'F', letter: 'AA',
  exScore: 1400 + i % 250, noteCount: 1000, missCount: 10, djPoints: 0 } } }));
for (const [i, c] of cpi.slice(0, 120).entries()) rows.push({ title: c.title, type: '', label: '', charts: {
  [{ NORMAL: 'SPN', HYPER: 'SPH', ANOTHER: 'SPA', LEGGENDARIA: 'SPL' }[c.diff]]: {
    unlocked: true, level: 12, lamp: i % 3 ? 'HC' : 'F', letter: 'AA', exScore: 1400, noteCount: 1000, missCount: 10, djPoints: 0 } } });
const input = realm.dto({ rows, osrCharts: dp.map((c, i) => ({ title: c.title, diff: c.diff, lampNum: i % 3 ? 5 : 1 })),
  notInInf: [], songs: Object.values(patterns).slice(0, 40).map(p => ({ title: p.t, ac: 2, legen: 2 })) });

test('offline fixture bytes are pinned by SHA-256', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./fixture-manifest.json', import.meta.url), 'utf8'));
  for (const [file, expected] of Object.entries(manifest)) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(localRoot, file))).digest('hex'), expected, file);
  }
});

test('actual UMD dependency chains evaluate and execute without DOM, require, or Electron', async () => {
  assert.equal(realm.eval('window === globalThis && self === globalThis'), true);
  for (const name of ['document', 'require', 'module', 'localStorage', 'infohsorry']) assert.equal(realm.eval(`typeof ${name}`), 'undefined');
  for (const kind of ['dp-star', 'r-star', 'sp-star', 'weakness', 'layout']) {
    const { libs, manifest } = await resources.load(kind);
    assert.match(manifest.modelRevision, /[a-f0-9]{64}/);
    const result = runKernel(kind, input, realm.dto({ layoutMode: true, style: 'dp' }), libs);
    assert.ok(result !== undefined);
    assert.deepEqual(copy(decodeValue(encodeValue(result))), copy(result));
  }
});

test('normTitle local master matches the synchronous app copy byte for byte', () => {
  const master = fs.readFileSync(path.join(localRoot, 'modules/normTitle.js'));
  const app = fs.readFileSync(new URL('../../../shared/normTitle.js', import.meta.url));
  assert.equal(createHash('sha256').update(master).digest('hex'), createHash('sha256').update(app).digest('hex'));
});

test('DP parity: App inference call and output fields, including previous floor', async () => {
  const { libs } = await resources.load('dp-star');
  for (const prevStar of [null, 0, 20]) {
    const r = libs.onlyOSRtoEreter.inferEreter(input.osrCharts, libs.rating, { charts: libs.ereter.charts, players: {} },
      prevStar != null ? { prevStar } : undefined);
    const expected = typeof r.ereterStar !== 'number' ? null : { star: r.ereterStar,
      starRaw: typeof r.ereterStarRaw === 'number' ? r.ereterStarRaw : r.ereterStar, ratcheted: r.ratcheted,
      nativeStar: typeof r.ohsorryStar === 'number' ? r.ohsorryStar : r.ereterStar, tier: r.tier ?? null, nFit12: r.nFit12 ?? null };
    assert.notEqual(expected, null);
    assert.deepEqual(copy(runKernel('dp-star', input, realm.dto({ prevStar }), libs)), copy(expected));
  }
});

test('r parity: App score adapter and inference call', async () => {
  const { libs } = await resources.load('r-star');
  const charts = [];
  for (const row of rows) for (const [slot, diff] of Object.entries({ DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA' })) {
    const c = row.charts[slot]; if (c) charts.push({ title: row.title, diff, exScore: c.exScore, noteCount: c.noteCount });
  }
  for (const prevRStar of [null, 15]) {
    const result = libs.userRateStar.inferUserRStar(realm.dto(charts), libs.rating,
      { normFn: libs.OhsorryNorm.norm, scale: libs.rating.rateStar?.scale ?? null, prevRStar });
    const expected = typeof result.rStar === 'number' && Number.isFinite(result.rStar) ? result.rStar : null;
    assert.notEqual(expected, null);
    assert.deepEqual(runKernel('r-star', input, realm.dto({ prevRStar }), libs), expected);
  }
});

test('SP parity: guarded and legacy unified UMD methods', async () => {
  const { libs } = await resources.load('sp-star');
  const own = cpi.slice(0, 120).map((c, i) => ({ title: c.title, diff: c.diff, gameLevel: 12, lampNum: i % 3 ? 5 : 1 }));
  const r = libs.spSkillCpi.computeSpStarGuarded(realm.dto(own), libs.cpi, { normFn: libs.OhsorryNorm.norm });
  assert.notEqual(r.cpi, null);
  assert.deepEqual(copy(runKernel('sp-star', input, realm.dto({}), libs)), copy(r));
  const guarded = libs.spSkillCpi.computeSpStarGuarded;
  try {
    libs.spSkillCpi.computeSpStarGuarded = undefined;
    const expected = libs.spSkillCpi.computeUserSpCpi(realm.dto(own), libs.cpi, { normFn: libs.OhsorryNorm.norm, mode: 'unified' });
    assert.deepEqual(copy(runKernel('sp-star', input, realm.dto({}), libs)), copy(expected));
  } finally { libs.spSkillCpi.computeSpStarGuarded = guarded; }
});

test('weakness parity: original gistLib adapter and PlayData inference with all entries', async () => {
  const { libs } = await resources.load('weakness');
  const charts = [];
  const lamp = { NP: 0, F: 1, AC: 2, EC: 3, NC: 4, HC: 5, EX: 6, FC: 7, PFC: 7 };
  for (const row of rows) for (const [slot, diff] of Object.entries({ DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA' })) {
    const c = row.charts[slot]; if (!c || !c.noteCount || c.noteCount <= 0) continue;
    charts.push({ title: row.title, diff, exScore: c.exScore || 0, noteCount: c.noteCount,
      scorePercent: ((c.exScore || 0) / (c.noteCount * 2)) * 100, lampNum: lamp[c.lamp] ?? 0 });
  }
  assert.deepEqual(copy(rowsToWeaknessCharts(input.rows)), charts);
  const expected = libs.OhsorryWeakness.calcUserWeakness({ allCharts: realm.dto(charts), patternsMap: libs.patterns,
    normFn: libs.OhsorryNorm.norm, ratingMap: libs.rating.ratings || null, zasaMap: libs.zasa.charts || null, rateRef: libs.rateRef });
  assert.ok(expected.__entries.length > 0);
  assert.deepEqual(copy(runKernel('weakness', input, realm.dto({}), libs)), copy(expected));
});

test('layout parity: original PlayData loop and SP/OFF null policy', async () => {
  const { libs } = await resources.load('layout');
  const vec = runKernel('weakness', input, realm.dto({}), libs);
  const index = {};
  for (const id of Object.keys(libs.patterns)) {
    const t = libs.patterns[id]?.t; if (!t) continue;
    const k = libs.OhsorryNorm.norm(t); if (k && !index[k]) index[k] = id;
  }
  const expected = new Map();
  for (const meta of input.songs) {
    if (!meta.title || typeof meta.ac !== 'number' || !(meta.ac & 2)) continue;
    const p = libs.patterns[index[libs.OhsorryNorm.norm(meta.title)]]; if (!p?.c) continue;
    for (const [diff, cn] of Object.entries({ NORMAL: 'DP_NOR', HYPER: 'DP_HYP', ANOTHER: 'DP_ANO', LEGGENDARIA: 'DP_LEG' })) {
      if (diff === 'LEGGENDARIA' && !(typeof meta.legen === 'number' && (meta.legen & 2))) continue;
      if (!p.c[cn]) continue;
      try { const r = libs.OhsorryWeakness.chartStrengthMatch8Way(p.c[cn], vec);
        if (typeof r?.bestLabel === 'string') expected.set(libs.OhsorryNorm.norm(meta.title) + '|' + diff, r.bestLabel);
      } catch {}
    }
  }
  assert.ok(expected.size > 0);
  assert.deepEqual(copy(runKernel('layout', input, realm.dto({ layoutMode: true, style: 'dp' }), libs)), [...expected]);
  assert.equal(runKernel('layout', input, realm.dto({ layoutMode: false }), libs), null);
  assert.equal(runKernel('layout', input, realm.dto({ layoutMode: true, style: 'sp' }), libs), null);
});

test('resource drift is explicit and failed loads are retryable', async () => {
  const specs = realm.load('./workerResources').DEFAULT_RESOURCES['r-star'];
  await assert.rejects(resources.load('r-star', realm.dto(specs.map(s => ({ ...s, digest: '0'.repeat(64) })))), /RESOURCE_DRIFT/);
  await resources.load('r-star');
});
