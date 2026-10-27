import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
function load(source, dependencies = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
    return dependencies[name];
  }, Buffer, ...globals });
  return exports;
}
const shared = load(read('../shared/uploadSnapshot.ts'));
const play = load(read('./playLog.ts'));
function fixture() {
  let now = 0, serial = 0;
  const timers = new Map();
  const s = { pid: 1, id: 'A123456789012', marker: true, playing: true, song: 1,
    mtimeMs: 1, size: 10, missing: false, invalid: false, racing: false, fail: '', memoryFail: false,
    rows: [], logs: [], closed: [], appends: 0, scans: 0, stats: 0, versions: 0, addresses: [] };
  const fs = {
    statSync() { s.stats++; if (s.missing) throw Error('missing'); return { mtimeMs: s.mtimeMs, size: s.size }; },
    readFileSync() { if (s.racing) s.mtimeMs++; return s.invalid ? '' : ['judgeData','playSettings','playData','songList'].map((k,i) => `${k}=0x${(0x140001000n + BigInt(i * 4096)).toString(16)}`).join('\n'); },
    existsSync: () => false,
    mkdirSync() { if (s.fail === 'mkdir') throw Error('mkdir'); },
    writeFileSync() { if (s.fail === 'header') throw Error('header'); },
    appendFileSync(file, row) { if (s.fail === 'append') throw Error('append'); s.rows.push(row); },
  };
  const memory = {
    findInfinitas: () => s.pid ? { pid: s.pid, handle: s.pid, modBaseAddr: 0x140000000n } : null,
    closeHandle: h => s.closed.push(h),
    readBytes(h, address, size) {
      s.addresses.push(address);
      const b = Buffer.alloc(size);
      if (size === 96) {
        s.scans++;
        if (s.marker) for (const i of [0,8,16]) b.writeInt32LE(20000,i);
      } else if (address === 0x1400010b0n) b.writeInt32LE(s.playing ? 1 : 0);
      else if (address === 0x140001fe8n) b.writeInt32LE(0);
      else if (address === 0x140003000n) b.writeInt32LE(s.song);
      else if (address === 0x1400037a0n) b.writeInt32LE(10); // playSettings + 0x17a0 = 속도 단계 10 (1.00)
      if (s.memoryFail && size === 64) throw Error('memory');
      return b;
    },
  };
  const api = load(read('./playLogger.ts'), { fs, path: { dirname: () => '/users' },
    './accountTsvStore': { accountPlayCsvPath: id => `/users/${id}/plays.csv` }, './memory': memory,
    './playLog': play, '../shared/uploadSnapshot': shared }, {
    performance: { now: () => now },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [1700000000000 + now])); } },
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const stop = api.startPlayLogger({ offsetsPath: '/offsets', appVersion: 'app',
    getGameVersion: () => { s.versions++; return 'real-game'; }, getAccount: () => s.id,
    onAppend: () => s.appends++, log: line => s.logs.push(line) });
  function advance(to) {
    for (;;) {
      const next = [...timers].filter(([,t]) => t.at <= to).sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = to;
  }
  const errors = code => s.logs.filter(x => x.includes(`error ${code} `)).length;
  function result() { s.playing = false; advance(now + 500); advance(now + 1500); }
  return { s, advance, result, stop, errors, timers, setNow: value => { now = value; } };
}
const fields = row => row.trim().split(',').map(x => x.replace(/^"|"$/g,''));

test('정상 500ms tick과 결과 전환 1500ms 저장 유지', () => {
  const f = fixture(); f.advance(1999); assert.equal(f.s.stats,0);
  f.advance(2000); f.s.playing = false; f.advance(2499); assert.equal(f.s.rows.length,0);
  f.advance(2500); f.advance(3999); assert.equal(f.s.rows.length,0);
  f.advance(4000); assert.equal(f.s.rows.length,1); assert.equal(f.s.appends,1);
  assert.deepEqual(fields(f.s.rows[0]).slice(-3),['app','real-game','1.00']); // app_version, game_version, play_speed
  assert.equal(f.s.versions,1); f.stop();
});

test('ID 없는 오류는 diag만, 뒤늦은 ID 소급 없음과 pid 변경 초기화', () => {
  const f = fixture(); f.s.id = null; f.advance(2000); f.result();
  assert.equal(f.errors(-1),1); assert.equal(f.s.rows.length,0);
  f.s.marker = false; f.s.mtimeMs++; f.advance(4500); f.advance(34500);
  assert.equal(f.errors(-5),1); f.s.id='A123456789012'; f.advance(35500);
  assert.equal(f.s.rows.length,0);
  for (const invalid of [false,true]) {
    const g=fixture(); g.s.id=null; g.s.missing=!invalid; g.s.invalid=invalid; g.advance(6000);
    assert.equal(g.errors(invalid ? -7 : -6),1); g.s.id='A123456789012'; g.advance(8000);
    assert.equal(g.s.rows.length,0); g.s.pid=2; g.advance(10000);
    assert.equal(g.s.rows.length,1); g.stop();
  }
  f.stop();
});

test('-2/-3 CSV timestamp와 18칸, 쓰기 실패 -4는 재시도와 재귀 없음', () => {
  for (const code of [-2,-3]) {
    const f=fixture(); f.advance(2000); f.s.song=0; f.s.memoryFail=code===-3; f.result();
    const values=fields(f.s.rows[0]); assert.equal(values.length,21);
    assert.equal(values[0],new Date(1700000004000).toISOString());
    assert.ok(values.slice(1,19).every(v=>v===String(code)));
    assert.deepEqual(values.slice(19),['app','real-game']); assert.equal(f.s.appends,1); f.stop();
  }
  for (const fail of ['mkdir','header','append']) {
    const f=fixture(); f.advance(2000); f.s.song=0; f.s.fail=fail; f.result();
    assert.equal(f.errors(-4),1); f.s.fail=''; f.advance(10000);
    assert.equal(f.s.rows.length,0); assert.equal(f.s.appends,0); f.stop();
  }
});

test('offsets 없음/필수키와 게임 없음 구별, 핸들 종료와 같은 pid 억제', () => {
  for (const invalid of [false,true]) {
    const f=fixture(); f.s.missing=!invalid; f.s.invalid=invalid; f.advance(6000);
    assert.equal(f.errors(invalid ? -7 : -6),1); assert.equal(f.s.closed.length,3);
    assert.equal(f.s.versions,1); f.s.missing=false; f.s.invalid=false; f.advance(8000);
    f.s.missing=true; f.advance(8500); assert.equal(f.errors(-6),1);
    f.stop();
  }
  const f=fixture(); f.s.pid=null; f.s.missing=true; f.advance(6000);
  assert.equal(f.errors(-6)+f.errors(-7),0); f.stop();
  const g=fixture(); g.s.racing=true; g.advance(2000); assert.equal(g.s.scans,0);
  assert.equal(g.s.closed.length,1); g.stop();
});

test('marker 29999/30000 경계와 이후 발견, 발견 후 재탐색/prev 초기화 없음', () => {
  const f=fixture(); f.s.marker=false; f.advance(2000);
  // 다음 예약 tick을 경계 시각으로 옮겨 단조 시각의 정확한 경계를 관측한다.
  const tick=[...f.timers.values()][0].fn; f.timers.clear();
  f.setNow(31999); tick(); assert.equal(f.errors(-5),0); f.timers.clear();
  f.setNow(32000); tick(); assert.equal(f.errors(-5),1);
  f.s.marker=true; f.advance(32500); const scans=f.s.scans;
  f.s.marker=false; f.s.playing=false; f.advance(33000); f.advance(34500);
  assert.equal(f.s.scans,scans); assert.equal(f.s.rows.length,2); f.stop();
});

test('offsets mtime/size/삭제와 busy 후 재독, 주소와 marker 초기화', () => {
  const f=fixture(); f.advance(2000); f.s.playing=false; f.advance(2500);
  const stats=f.s.stats; f.s.mtimeMs++; f.advance(3999); assert.equal(f.s.stats,stats);
  f.advance(4000); assert.ok(f.s.stats>stats); assert.equal(f.s.scans,2);
  f.s.size++; f.advance(4500); assert.equal(f.s.scans,3);
  f.s.missing=true; f.advance(5000); assert.equal(f.errors(-6),1);
  f.s.missing=false; f.s.playing=true; f.advance(7000); assert.equal(f.s.scans,4);
  assert.equal(f.s.versions,1); assert.equal(f.s.rows.length,2);
  assert.equal(f.s.closed.length,4); f.stop();
});
