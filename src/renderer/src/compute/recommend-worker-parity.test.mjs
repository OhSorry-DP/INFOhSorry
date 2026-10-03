import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker as Thread } from 'node:worker_threads';
import vm from 'node:vm';
import ts from 'typescript';
import { createRealm } from './test-support.mjs';

const frozen = path.resolve('scratchpad/s133/s3-fixtures');
const root = path.join(frozen, 'current');
const manifest = JSON.parse(fs.readFileSync(path.join(frozen, 's3-manifest.json'), 'utf8'));
const read = file => fs.readFileSync(path.join(root, file));
const fetchFixture = async url => {
  const u = new URL(url), name = decodeURIComponent(u.pathname.split('/').pop());
  const candidate = path.join(root, u.pathname.includes('/lib/') ? 'modules' : 'dist', name);
  return { ok: true, status: 200, text: async () => fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(root, name), 'utf8') };
};
const specs = [ ['OhsorryNorm', 'normTitle.js'], ['OhsorryWeakness', 'calcWeakness.js'], ['OhsorryRecommend', 'recommend.js'] ]
  .map(([key, file]) => ({ key, globalKey: key, url: `https://fixture/lib/${file}`, digest: manifest['modules/' + file] }));
for (const [key, file] of Object.entries({ patterns: 'patterns-dp-1112.json', rateRef: 'rate-reference-slim.json',
  featureScores: 'feature-scores-slim.json', textageMeta: 'textage-meta.json', weaknessPopMean: 'weakness-popmean.json',
  rating: 'ohSorryRating.json', zasa: 'zasa-data.json', ereter: 'ereter-data.json', seriesNames: 'series-name.json' })) {
  specs.push({ key, url: `https://fixture/data/${file}`, digest: manifest['dist/' + file] ?? manifest[file] });
}
const rating = JSON.parse(read('dist/ohSorryRating.json'));
const slots = { NORMAL: 'DPN', HYPER: 'DPH', ANOTHER: 'DPA', LEGGENDARIA: 'DPL' };
const rows = rating.ratings.filter(r => slots[r.diff]).slice(0, 180).map((r, i) => ({ title: r.title, type: '', label: '', charts: {
  [slots[r.diff]]: { unlocked: true, level: r.gameLevel, lamp: i % 3 ? 'HC' : 'F', letter: 'AA',
    exScore: 1400 + i % 250, noteCount: 1000, missCount: 10, djPoints: 0 },
} }));

test('S3 source/data bytes are pinned, with explicit synthetic rateRef and seriesNames', () => {
  for (const [file, digest] of Object.entries(manifest)) assert.equal(createHash('sha256').update(read(file)).digest('hex'), digest, file);
});

test('actual Worker thread DTOs deep-equal independent synchronous context with fixed RNG', async () => {
  for (const cap of [1, 2, 3, 4]) {
    const reference = createRealm({ fetch: fetchFixture });
    const clientRealm = createRealm();
    const resources = reference.load('./workerResources').createWorkerResources();
    const libs = (await resources.load('rec-context', reference.dto(specs))).libs;
    const ctx = reference.load('../recommendCore').createRecCtx({ rows: reference.dto(rows), ratingData: libs.rating,
      zasaData: libs.zasa, ereterData: libs.ereter, libs: { weakness: libs.OhsorryWeakness, normLib: libs.OhsorryNorm,
        recommend: libs.OhsorryRecommend, patterns: libs.patterns, rateRef: libs.rateRef, featureScores: libs.featureScores,
        textageMeta: libs.textageMeta, seriesNames: libs.seriesNames, weaknessPopMean: libs.weaknessPopMean } });
    const oldSource = read('reference-bridge.ts').toString('utf8') + '\nexports.handle = handle;';
    const oldCompiled = ts.transpileModule(oldSource, { compilerOptions: { target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const legacyBridge = {};
    vm.runInContext(`(function(exports,require){${oldCompiled}\n})`, reference.context)(legacyBridge, name => {
      if (name === 'react') return {};
      if (name === './emodeTargets') return reference.load('../emodeTargets');
      if (name === '../../shared/match') return reference.load('../../../shared/match');
      throw new Error(name);
    });
    class Port {
      onmessage = null; onerror = null; onmessageerror = null;
      constructor() {
        this.thread = new Thread(new URL('./recommend-worker-thread.mjs', import.meta.url), { workerData: { root } });
        this.thread.on('message', value => this.onmessage?.({ data: clientRealm.dto(value) }));
        this.thread.on('error', e => this.onerror?.({ message: e.message }));
      }
      postMessage(value) { this.thread.postMessage(value); }
      terminate() { void this.thread.terminate(); }
    }
    const client = clientRealm.load('./computeClient').createComputeClient({ hardwareConcurrency: cap + 1,
      workerFactory: () => new Port(), watchdogMs: 30000 });
    const stamp = { scope: { iidxId: 'A', epoch: 1 }, rowsRevision: 1, chartsRevision: 1, modelRevision: '', dataRevision: '', optionsKey: '{}' };
    client.installInput('rec', clientRealm.dto({ stamp, data: { rows, osrCharts: [], notInInf: [], songs: null } }));
    const run = async (kind, options, lane = 'test') => {
      const sources = clientRealm.dto(specs), manifest = await client.prepare(kind, sources);
      const ticket = client.submit({ kind, inputHandle: 'rec', affinityHandle: 'rec', resources: sources,
        stamp: clientRealm.dto({ ...stamp, ...manifest, optionsKey: clientRealm.load('./revisionKey').makeOptionsKey(clientRealm.dto(options)) }),
        options: clientRealm.dto(options), lane, isCurrent: () => true });
      const response = await ticket.promise;
      assert.equal(response.status, 'ready', response.message);
      let accepted = false; ticket.accept(response, () => { accepted = true; }); assert.equal(accepted, true);
      return response.value;
    };
    const rng = () => reference.eval(`var seed=1337; Math.random=()=>{ seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296; };`);
    const decorate = (row, practice = false) => {
      const r = { title: row.title, chart: row.chart, _category: practice ? 'cleanup' : row._category || 'cleanup' };
      const match = ctx.chartStrengthMatchByHand(r), tags = ctx.computeChartTags(r);
      return { ...row, _cardHashtags: ctx.computeRecHashtags({ ...r, _matchByHand: match, _tags: tags }).join(' '), _cardBestLabel: match?.bestLabel || '' };
    };
    try {
      const metadata = await run('rec-context', {});
      for (const layout of ['on', 'off']) for (const stage of ['ec', 'hc', 'exh']) {
        ctx.setLayoutMode(layout); rng();
        const expected = ctx.buildRecsWithPool({ ec: 3, hc: 5, exh: 6 }[stage], stage, 8, 'lv11+12', 'off', { randomize: true });
        const actual = await run('rec-query', { contextHandle: metadata.contextHandle, operation: 'clear-pool',
          layout, stage, baseStar: 8, levelMode: 'lv11+12', djMode: 'off', rerollToken: 0 }, 'ui:' + stage);
        assert.deepEqual(structuredClone(actual), structuredClone({ picked: expected.picked.map(r => decorate(r)), pool: expected.pool.map(r => decorate(r)) }));
      }
      for (const mode of ['all', 'CHARGE', 'SCRATCH', 'SOF-LAN']) {
        const practice = reference.dto({ mode, topN: 10, handMode: 'both', strength: 1, flipOn: true, randomize: true });
        ctx.setLayoutMode('on'); rng(); const expected = ctx.buildWeaknessRecs(8, practice).map(r => decorate(r, true));
        const actual = await run('rec-query', { contextHandle: metadata.contextHandle, operation: 'practice', layout: 'on', baseStar: 8,
          practice: structuredClone(practice), rerollToken: 0 }, 'ui:weakness');
        assert.deepEqual(structuredClone(actual), structuredClone(expected));
      }
      // Compare the untouched pre-S3 bridge snapshot, including factual growth payloads.
      for (const [index, request] of [
        { kind: 'meta' }, { kind: 'clear', params: { layout: 'on', limit: 5 } },
        { kind: 'practice', params: { handMode: 'left', strength: 2, layout: 'off', topN: 5 } },
        { kind: 'ladder', params: { preset: 'normal', topN: 3 } },
        { kind: 'ladder', params: { mode: 'lamp', topN: 3, layout: 'on' } },
        { kind: 'ladder', params: { mode: 'score', topN: 3 } },
        { kind: 'targets', params: { grade: 'aa', limit: 3 } },
      ].entries()) {
        const req = reference.dto({ reqId: `bridge-${index}`, ...request });
        rng(); const expected = legacyBridge.handle(req, { recCtx: ctx, ratingData: libs.rating,
          baseStar: 8, userRStar: 10, userCharts: [] });
        const actual = await run('rec-query', { contextHandle: metadata.contextHandle, operation: 'bridge',
          layout: req.params?.layout === 'on' ? 'on' : 'off', request: structuredClone(req),
          bridge: { baseStar: 8, userRStar: 10, userCharts: [] } }, 'bridge:' + index);
        assert.deepEqual(structuredClone(actual), structuredClone(expected));
      }
    } finally { client.dispose(); }
  }
});
