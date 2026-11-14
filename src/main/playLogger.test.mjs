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
const detail = load(read('./playDetail.ts'));
function fixture() {
  let now = 0, serial = 0;
  const timers = new Map();
  const s = { pid: 1, id: 'A123456789012', marker: true, playing: true, song: 1,
    mtimeMs: 1, size: 10, missing: false, invalid: false, racing: false, fail: '', memoryFail: false,
    rows: [], details: [], logs: [], closed: [], appends: 0, scans: 0, stats: 0, versions: 0, addresses: [], laneFailP1: false, laneFailP2: false, laneP1: [0,1,2,3,4,5,6], laneP2: [6,5,4,3,2,1,0], header: '', headerWritten: false };
  const fs = {
    statSync() { s.stats++; if (s.missing) throw Error('missing'); return { mtimeMs: s.mtimeMs, size: s.size }; },
    readFileSync(file) { if (String(file).endsWith('plays.csv')) return s.header; if (s.racing) s.mtimeMs++; return s.invalid ? '' : ['judgeData','playSettings','playData','songList'].map((k,i) => `${k}=0x${(0x140001000n + BigInt(i * 4096)).toString(16)}`).join('\n'); },
    existsSync: () => s.header.length > 0,
    mkdirSync() { if (s.fail === 'mkdir') throw Error('mkdir'); },
    writeFileSync(file, text) { if (s.fail === 'header') throw Error('header'); s.header = text; },
    appendFileSync(file, row) { if (String(file).endsWith('plays_detail.jsonl')) { s.details.push(row); return; } if (s.fail === 'append') throw Error('append'); s.rows.push(row); },
  };
  const memory = {
    findInfinitas: () => s.pid ? { pid: s.pid, handle: s.pid, modBaseAddr: 0x140000000n } : null,
    closeHandle: h => s.closed.push(h),
    readBytes(h, address, size) {
      if (size !== 192) s.addresses.push(address); // 192B = 플레이 상세 레인 블록 (playDetail.test 와 아래 상세 테스트에서 따로 본다)
      const b = Buffer.alloc(size);
      if (address === 0x1400057ccn) { if (s.laneFailP1) throw Error('p1 lane read'); s.laneP1.forEach((v,i) => b.writeInt32LE(v,i*4)); return b; }
      if (address === 0x1400057ecn) { if (s.laneFailP2) throw Error('p2 lane read'); s.laneP2.forEach((v,i) => b.writeInt32LE(v,i*4)); return b; }
      if (size === 96) {
        s.scans++;
        if (s.marker) for (const i of [0,8,16]) b.writeInt32LE(20000,i);
      } else if (address === 0x1400010b0n) b.writeInt32LE(s.playing ? 1 : 0);
      else if (address === 0x140001fe8n) b.writeInt32LE(0);
      else if (address === 0x140003000n) b.writeInt32LE(s.song);
      else if (address === 0x1400037a0n) b.writeInt32LE(10); // playSettings + 0x17a0 = 속도 단계 10 (1.00)
      if (s.memoryFail && size === 64) throw Error('memory');
      if (s.detailFail && size === 192) throw Error('detail');
      return b;
    },
  };
  const api = load(read('./playLogger.ts'), { fs, path: { dirname: () => '/users' },
    './accountTsvStore': { accountPlayCsvPath: id => `/users/${id}/plays.csv`, accountPlayDetailPath: id => `/users/${id}/plays_detail.jsonl` }, './memory': memory,
    './playLog': play, './playDetail': detail, '../shared/uploadSnapshot': shared }, {
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

test('lane order is read independently and invalid sides become empty', () => {
  for (const configure of [
    s => {},
    s => { s.laneFailP1 = true; },
    s => { s.laneP1 = [0,0,2,3,4,5,6]; },
    s => { s.laneP2 = [0,1,2,3,4,5,7]; },
    s => { s.laneP2 = [-1,1,2,3,4,5,6]; },
  ]) {
    const f=fixture(); configure(f.s); f.advance(2000); f.result();
    assert.equal(fields(f.s.rows[0]).length, 24);
    const lane = fields(f.s.rows[0]).slice(-2);
    if (!f.s.laneFailP1 && f.s.laneP1.join('') === '0123456') assert.equal(lane[0], '0123456');
    else assert.equal(lane[0], '');
    if (f.s.laneP2.join('') === '6543210') assert.equal(lane[1], '6543210');
    else assert.equal(lane[1], '');
    f.stop();
  }
});

test('only recognized 19, 21, and 22 column headers are upgraded while old data is preserved', () => {
  const old19 = 'timestamp,song_id,title,difficulty,notes,ex_score,pgreat,great,miss_count,clear_lamp,dj_rate_pct,dj_rank,judge_16,settings_p1_11,settings_p2_11,battle_flag,gauge_p1_w77,gauge_p2_w78,source';
  for (const old of [old19, play.PLAY_LOG_HEADER_V2, play.PLAY_LOG_HEADER_V3]) {
    const f=fixture(); f.s.header = `${old}\r\nlegacy,data\n`; f.advance(2000); f.result();
    assert.ok(f.s.header.startsWith(`${play.PLAY_LOG_HEADER}\r\nlegacy,data\n`)); f.stop();
  }
  const f=fixture(); f.s.header = `unknown\r\nlegacy,data\n`; f.advance(2000); f.result();
  assert.equal(f.s.header, 'unknown\r\nlegacy,data\n'); f.stop();
});
const fields = row => row.trim().split(',').map(x => x.replace(/^"|"$/g,''));

test('정상 500ms tick과 결과 전환 1500ms 저장 유지', () => {
  const f = fixture(); f.advance(1999); assert.equal(f.s.stats,0);
  f.advance(2000); f.s.playing = false; f.advance(2499); assert.equal(f.s.rows.length,0);
  f.advance(2500); f.advance(3999); assert.equal(f.s.rows.length,0);
  f.advance(4000); assert.equal(f.s.rows.length,1); assert.equal(f.s.appends,1);
  assert.deepEqual(fields(f.s.rows[0]).slice(-5),['app','real-game','1.00','0123456','6543210']); // versions, play_speed, lane orders
  assert.equal(f.s.versions,1); f.stop();
});

test('플레이 중 샘플링한 상세가 plays.csv 와 같은 timestamp 로 plays_detail.jsonl 에 한 줄 저장된다', () => {
  const f = fixture(); f.advance(2000); f.advance(2100); // 플레이 중: 4ms 샘플러 동작
  f.result();
  assert.equal(f.s.rows.length, 1); assert.equal(f.s.details.length, 1);
  const d = JSON.parse(f.s.details[0]);
  assert.equal(d.timestamp, fields(f.s.rows[0])[0]);
  assert.equal(d.v, 1); assert.equal(d.complete, true); // 카운터가 0 인 채로 시작했으므로 처음부터 관찰한 것
  assert.ok(d.samples > 20 && d.dt_ms >= 3 && d.dt_ms <= 5, `samples=${d.samples} dt=${d.dt_ms}`);
  assert.equal(d.p1.lanes.length, 8); assert.equal(d.p1.lanes_ok, true);
  assert.equal(f.s.logs.filter(x => x.includes('detail saved')).length, 1);
  f.stop();
});

test('상세 읽기가 실패해도 plays.csv 기록은 그대로 저장된다', () => {
  const f = fixture(); f.s.detailFail = true; f.advance(2000); f.advance(2100); f.result();
  assert.equal(f.s.rows.length, 1); assert.equal(f.s.details.length, 0);
  assert.ok(f.s.logs.some(x => x.includes('detail sampling stopped')));
  f.stop();
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
