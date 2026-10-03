import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker as Thread } from 'node:worker_threads';
import { createRealm } from './test-support.mjs';
const frozen = path.resolve('scratchpad/s133/s3-fixtures');
const root = path.join(frozen, 'current');
const manifest = JSON.parse(fs.readFileSync(path.join(frozen, 's3-manifest.json'), 'utf8'));
const files = { patterns: 'patterns-dp-1112.json', rateRef: 'rate-reference-slim.json', featureScores: 'feature-scores-slim.json',
  rating: 'ohSorryRating.json', zasa: 'zasa-data.json' };
const specsFor = kind => [
  ...[['OhsorryNorm','normTitle.js'],['OhsorryWeakness','calcWeakness.js']].map(([key,file]) =>
    ({ key, globalKey: key, url: 'https://fixture/lib/' + file, digest: manifest['modules/' + file], adapter: 'analysis-songcharts-v1' })),
  ...(kind === 'weakness' ? ['patterns','rateRef','rating','zasa'] : ['patterns','featureScores']).map(key =>
    ({ key, url: 'https://fixture/data/' + files[key], digest: manifest['dist/' + files[key]] ?? manifest[files[key]], adapter: 'analysis-songcharts-v1' })),
];
const fetchFixture = async url => {
  const u = new URL(url), file = decodeURIComponent(u.pathname.split('/').pop());
  const candidate = path.join(root, u.pathname.includes('/lib/') ? 'modules' : 'dist', file);
  return { ok: true, status: 200, text: async () => fs.readFileSync(fs.existsSync(candidate) ? candidate : path.join(root,file), 'utf8') };
};
const slot = { NORMAL:'DPN', HYPER:'DPH', ANOTHER:'DPA', LEGGENDARIA:'DPL' };
const rating = JSON.parse(fs.readFileSync(path.join(root,'dist/ohSorryRating.json'),'utf8'));
const charts = rating.ratings.filter(r => slot[r.diff]).slice(0,90).map((r,i)=>({
  title:r.title, slot:slot[r.diff], level:r.gameLevel, noteCount:800+i, exScore:i%4 ? 700+i : 0,
  lamp:['NP','PFC','mystery','HC'][i%4], unlocked:true, letter:'AA', missCount:3, djPoints:0,
}));
charts.push({...charts[0]}, {...charts[0],slot:'SPA'}, {...charts[1],noteCount:0}, {...charts[2],noteCount:-1});
const adapter = charts => charts.flatMap(c => {
  const diff = { DPN:'NORMAL', DPH:'HYPER', DPA:'ANOTHER', DPL:'LEGGENDARIA' }[c.slot];
  if (!diff || !c.noteCount || c.noteCount <= 0) return [];
  return [{title:c.title,diff,exScore:c.exScore||0,noteCount:c.noteCount,
    scorePercent:((c.exScore||0)/(c.noteCount*2))*100,
    lampNum:({NP:0,F:1,AC:2,EC:3,NC:4,HC:5,EX:6,FC:7,PFC:7})[c.lamp]??0}];
});
function pool(cap, sources) {
  const realm = createRealm(), traces = [];
  class Port {
    onmessage=null; onerror=null; onmessageerror=null;
    constructor() {
      this.thread = new Thread(new URL('./analysis-worker-thread.mjs',import.meta.url),{workerData:{root,sources}});
      this.thread.on('message', value => {
        if(value.trace) traces.push(value); else {
          realm.context.__wire = value;
          this.onmessage?.({data:realm.eval('structuredClone(__wire)')});
        }
      });
      this.thread.on('error', e => this.onerror?.({message:e.message}));
    }
    postMessage(value){this.thread.postMessage(value);}
    terminate(){void this.thread.terminate();}
  }
  const client = realm.load('./computeClient').createComputeClient({hardwareConcurrency:cap+1,workerFactory:()=>new Port(),watchdogMs:30000});
  let rev=0;
  function input(charts) {
    const stamp={scope:{iidxId:'12345678',epoch:1},rowsRevision:++rev,chartsRevision:rev,modelRevision:'',dataRevision:'',optionsKey:'{}'};
    const handle='analysis-'+rev;
    client.installInput(handle,realm.dto({stamp,data:{rows:[],osrCharts:[],notInInf:['all'],songs:null,analysisCharts:charts}}));
    return {stamp,handle};
  }
  async function run(kind, snapshot, resources, options={adapter:'analysis-songcharts-v1'}, drift={}) {
    resources=realm.dto(resources); options=realm.dto(options);
    const manifest=await client.prepare(kind,resources);
    const stamp=realm.dto({...snapshot.stamp,...manifest,optionsKey:realm.load('./revisionKey').makeOptionsKey(options),...drift});
    const ticket=client.submit({kind,stamp,inputHandle:snapshot.handle,options,resources,isCurrent:()=>true});
    const response=await ticket.promise;
    let applied=false; ticket.accept(response,()=>applied=true); assert.equal(applied,true);
    return response;
  }
  return {realm,client,input,run,traces};
}
test('both immutable fixture manifests verify without refreeze',()=>{
  for(const [file,digest] of Object.entries(manifest))
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),digest,file);
  const s1=JSON.parse(fs.readFileSync(new URL('./fixture-manifest.json',import.meta.url),'utf8'));
  for(const [file,digest] of Object.entries(s1))
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(frozen,file))).digest('hex'),digest,file);
});
test('pool 1/2/3/4 actual production runtime and codec equal independent old adapter/UMD on every own axis',async()=>{
  const reference=createRealm({fetch:fetchFixture});
  const libs=(await reference.load('./workerResources').createWorkerResources().load('weakness',reference.dto(specsFor('weakness')))).libs;
  const feature=JSON.parse(await (await fetchFixture('https://fixture/data/feature-scores-slim.json')).text());
  for(const cap of [1,2,3,4]) {
    const p=pool(cap);
    try {
      for(const cs of [charts,[],charts.slice(0,1),[...charts].reverse()]) {
        const snapshot=p.input(cs), all=reference.dto(adapter(cs));
        const vec=all.length ? libs.OhsorryWeakness.calcUserWeakness({allCharts:all,patternsMap:libs.patterns,
          normFn:libs.OhsorryNorm.norm,ratingMap:libs.rating?.ratings||null,zasaMap:libs.zasa?.charts||null,rateRef:libs.rateRef}):null;
        const expected=vec&&vec.__entries?{vec,allCharts:all}:null;
        const score=all.length?libs.OhsorryWeakness.computePatternScoreVec({charts:all,
          featureScores:reference.dto(feature),patternsMap:libs.patterns,normFn:libs.OhsorryNorm.norm}):null;
        const [weak,pattern]=await Promise.all([p.run('weakness',snapshot,specsFor('weakness')),p.run('pattern-score',snapshot,specsFor('pattern-score'))]);
        assert.equal(weak.status,'ready',weak.message);assert.equal(pattern.status,'ready',pattern.message);
        assert.deepEqual(structuredClone(weak.value),structuredClone(expected));
        assert.deepEqual(structuredClone(pattern.value?.vec??null),structuredClone(score));
        if(pattern.value) assert.match(pattern.value.digest,/^[a-f0-9]{64}$/);
      }
      const snapshot=p.input(charts);
      const nil=specsFor('pattern-score').map(s=>s.key==='featureScores'?{...s,url:null,optional:true}:s);
      assert.equal((await p.run('pattern-score',snapshot,nil)).value,null);
      const noRating=specsFor('weakness').map(s=>['rating','zasa'].includes(s.key)?{...s,url:null}:s);
      assert.equal((await p.run('weakness',snapshot,noRating)).status,'ready');
      assert.equal((await p.run('weakness',snapshot,specsFor('weakness'),undefined,{modelRevision:'wrong'})).status,'error');
      assert.equal((await p.run('pattern-score',snapshot,specsFor('pattern-score'),{})).status,'error');
    } finally {p.client.dispose();}
  }
});
const stubSources={
  'norm.js':'window.OhsorryNorm={norm:s=>s};',
  'weak.js':`window.OhsorryWeakness={
    calcUserWeakness(){trace('start','weakness'); const t=Date.now(); while(Date.now()-t<160){}
      trace('end','weakness');return {__entries:[],NOTES:1,missing:undefined,nan:NaN,inf:Infinity,negative:-Infinity,zero:-0};},
    computePatternScoreVec(){trace('start','pattern-score');const t=Date.now();while(Date.now()-t<160){}
      trace('end','pattern-score');return {NOTES:1,HANDS:2,missing:undefined,nan:NaN,inf:Infinity,negative:-Infinity,zero:-0};}
  };`,
  'data.json':'{}',
};
const stubSpecs=['OhsorryNorm','OhsorryWeakness','patterns','rateRef','featureScores'].map(key=>({
  key,globalKey:key.startsWith('Ohsorry')?key:undefined,adapter:'analysis-songcharts-v1',
  url:'https://stub/'+(key==='OhsorryNorm'?'norm.js':key==='OhsorryWeakness'?'weak.js':'data.json')
}));
test('delayed independent jobs overlap on distinct threads for cap>=2; cap1 serial and exact special scalars survive',async()=>{
  for(const cap of [1,2,3,4]){
    const p=pool(cap,stubSources);
    try{
      const snapshot=p.input(charts.slice(0,1));
      const result=await Promise.all(['weakness','pattern-score'].map(k=>p.run(k,snapshot,stubSpecs)));
      assert.ok(result.every(r=>r.status==='ready'));
      for(const r of result){assert.ok(Object.is(r.value.vec.zero,-0));assert.ok(Number.isNaN(r.value.vec.nan));
        assert.equal(r.value.vec.inf,Infinity);assert.equal(r.value.vec.negative,-Infinity);
        assert.ok(Object.hasOwn(r.value.vec,'missing'));assert.equal(r.value.vec.missing,undefined);}
      const a=p.traces.filter(t=>t.kind==='weakness'),b=p.traces.filter(t=>t.kind==='pattern-score');
      assert.equal(a.length,2);assert.equal(b.length,2);
      if(cap===1) assert.equal(a[0].threadId,b[0].threadId);
      else {assert.notEqual(a[0].threadId,b[0].threadId);assert.ok(Math.max(a[0].time,b[0].time)<Math.min(a[1].time,b[1].time));}
      assert.ok(p.client.stats.workers<=cap);
    }finally{p.client.dispose();}
  }
});
test('required UMD failure stays error and cannot populate result cache',async()=>{
  const p=pool(2,{...stubSources,'weak.js':'throw new Error("UMD_FAILED");'});
  try{const snapshot=p.input(charts);
    await assert.rejects(p.run('weakness',snapshot,stubSpecs),/UMD_FAILED/);
    await assert.rejects(p.run('weakness',snapshot,stubSpecs),/UMD_FAILED/);
    assert.equal(p.client.stats.run,0);
  }finally{p.client.dispose();}
});

test('analysis polling can replace a module without changing the pinned PlayData schema or model', async () => {
  const realm = createRealm({ fetch: async url => ({ ok:true, text:async () =>
    'window.OhsorryNorm={norm:s=>s,version:' + (String(url).includes('new') ? 2 : 1) + '};' }) });
  const resources = realm.load('./workerResources').createWorkerResources();
  const old = realm.dto([{ key:'OhsorryNorm',globalKey:'OhsorryNorm',url:'https://stub/old.js' }]);
  const first = await resources.load('weakness',old);
  const fresh = realm.dto([{ key:'OhsorryNorm',globalKey:'OhsorryNorm',url:'https://stub/new.js',adapter:'analysis-songcharts-v1' }]);
  const analysis = await resources.load('weakness',fresh);
  assert.equal(analysis.libs.OhsorryNorm.version,2);
  assert.match(analysis.manifest.modelRevision,/s4-analysis-adapter-1/);
  const again = await resources.load('weakness',old);
  assert.equal(again.libs.OhsorryNorm.version,1);
  assert.equal(again.manifest.modelRevision,first.manifest.modelRevision);
  await assert.rejects(resources.load('weakness',realm.dto([{...fresh[0],adapter:undefined}])),/MODEL_REALM_DRIFT/);
});
