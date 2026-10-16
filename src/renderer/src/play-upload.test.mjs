import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import OhsorryNorm from '../../shared/normTitle.js';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
function load(source, dependencies = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
    return dependencies[name];
  }, console: { log() {}, warn() {} }, ...globals });
  return exports;
}
const shared = load(read('../../shared/uploadSnapshot.ts'));
const keys = Array.from(shared.PLAY_CSV_KEYS);
const source = read('./supabaseSync.ts');
function sync(globals = {}) {
  return load(source, { '../../shared/uploadSnapshot': shared,
    '../../shared/match': { norm: x => OhsorryNorm.norm(x), slotToDiff: x => x }, '../../shared/dataSource': { DATA_BASE: 'https://fixture.invalid' } }, globals);
}
const row = i => Object.fromEntries(keys.map(key => [key, key === 'timestamp' ? String(i) : key === 'title' ? '??, "?" \\ ??\n?? ?' : key === 'difficulty' ? ['SPN', 'DPA', 'SPA'][i % 3] : key === 'battle_flag' ? String(i % 2) : key === 'source' ? (i % 2 ? 'currentsong' : 'playdata') : '001']));
const csvLine = value => keys.map(key => `"${value[key].replaceAll('"', '""')}"`).join(',') + '\r\n';
const csv = rows => keys.join(',') + '\n' + rows.map(csvLine).join('');
const plain = x => JSON.parse(JSON.stringify(x));

test('19/21 정확한 헤더만 허용하고 추가 열은 헤더 오류', () => {
  const api = sync();
  const legacy = keys.slice(0, 19);
  const current = keys;
  assert.equal(api.parsePlayHistoryDetailed(legacy.join(',') + '\n').errorCode, undefined);
  assert.equal(api.parsePlayHistoryDetailed(current.join(',') + '\n').errorCode, undefined);
  const extra = [...current, 'unexpected'];
  assert.equal(api.parsePlayHistoryDetailed(extra.join(',') + '\n').errorCode, -9);
});
test('두 헤더와 두 행 길이를 섞어 읽고 실제 버전은 보존', () => {
  const api = sync();
  const base = row(1); base.title = 'plain'; base.app_version = 'app-real'; base.game_version = 'game-real';
  const legacyValues = keys.slice(0, 19).map(key => base[key]);
  const currentValues = keys.map(key => base[key]);
  const legacyHeader = shared.PLAY_CSV_LEGACY_KEYS;
  const legacyCsv = `${legacyHeader.join(',')}\n${legacyValues.join(',')}\n${currentValues.join(',')}\n`;
  const legacyParsed = api.parsePlayHistory(legacyCsv);
  assert.equal(legacyParsed.length, 2);
  assert.equal(legacyParsed[0].app_version, ''); assert.equal(legacyParsed[0].game_version, '');
  assert.equal(legacyParsed[1].app_version, 'app-real'); assert.equal(legacyParsed[1].game_version, 'game-real');
  const currentHeaderInput = `${shared.PLAY_CSV_KEYS.join(',')}\n${legacyValues.join(',')}\n${currentValues.join(',')}\n`;
  const currentHeaderRows = api.parsePlayHistory(currentHeaderInput);
  assert.equal(currentHeaderRows[0].app_version, ''); assert.equal(currentHeaderRows[1].game_version, 'game-real');
});
test('20/22열 행은 거부하고 quote, CRLF/LF, 잘린 마지막 레코드 의미 유지', () => {
  const api = sync(); const source = row(1);
  source.title = '한글, "인용"\\줄\n개행';
  const line19 = keys.slice(0,19).map(key => `"${source[key].replaceAll('"','""')}"`).join(',');
  const line21 = keys.map(key => `"${source[key].replaceAll('"','""')}"`).join(',');
  const bad20 = line19 + ',extra'; const bad22 = line21 + ',x';
  const input = `${keys.slice(0,19).join(',')}\r\n${line19}\r\n${bad20}\n${line21}\n${bad22}\n"broken`;
  const detail = api.parsePlayHistoryDetailed(input);
  assert.equal(detail.rows.length, 2); assert.equal(detail.rows[0].title, source.title);
  assert.deepEqual(plain(detail.lastCompleteError), { columns: 22 });
});
test('업로드 결과 오류 코드, 버전 보존, 오류 생성 시 요청 시각 사용', () => {
  const fixed = '2026-10-17T00:00:00.000Z';
  const api = sync({ Date: class extends Date { constructor(...args) { super(...(args.length ? args : [fixed])); } } });
  const checks = [[{ok:true,found:false,appVersion:'a',gameVersion:'g'},-8], [{ok:true,csv:'bad',appVersion:'a',gameVersion:'g'},-9],
    [{ok:true,csv:keys.join(',')+'\n',appVersion:'a',gameVersion:'g'},-10], [{ok:false,appVersion:'a',gameVersion:'g'},-11]];
  for (const [result, code] of checks) {
    const [errorRow] = api.buildUploadPlays(result);
    assert.equal(errorRow.timestamp, fixed); assert.equal(errorRow.app_version, 'a'); assert.equal(errorRow.game_version, 'g');
    assert.equal(errorRow.song_id, String(code));
  }
});
test('CSV 오류 행은 ISO 시각과 함께 유지되고 업로드는 최근 100행만 선택', () => {
  const api = sync(); const err = shared.buildPlayErrorRow(-4, {appVersion:'v',gameVersion:'g'}, '2026-10-17T00:00:00.000Z');
  const values = keys.map(key => err[key]);
  const csvInput = `${keys.join(',')}\n${values.join(',')}\n${Array.from({length:101},(_,i)=>{
    const x=row(i); x.timestamp=String(i); x.title='plain'; return keys.map(key=>x[key]).join(',');
  }).join('\n')}\n`;
  const upload = api.buildUploadPlays({ok:true,csv:csvInput,appVersion:'v',gameVersion:'g'});
  assert.equal(upload.length,100); assert.equal(upload[0].timestamp,'1'); assert.equal(upload.at(-1).timestamp,'100');
  const parsedError = api.parsePlayHistory(`${keys.join(',')}\n${values.join(',')}\n`)[0];
  assert.equal(parsedError.timestamp,'2026-10-17T00:00:00.000Z'); assert.equal(shared.isPlayErrorRow(parsedError),true);
});
test('오류 행은 DBR/완주/자동 배열에서 제외하고 정상 lamp -1은 오류가 아님', () => {
  const api = sync(); const error = shared.buildPlayErrorRow(-3,{appVersion:'',gameVersion:''},'2026-10-17T00:00:00.000Z');
  const normal = {...row(1), clear_lamp:'-1', notes:'1', judge_16:'1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'};
  assert.equal(shared.isPlayErrorRow(normal),false); assert.equal(api.isCompletedPlay(normal),true);
  assert.equal(api.decodeBattleRandomPlay(error),null); assert.equal(api.isCompletedPlay(error),false);
  assert.equal(api.evaluateAutomaticArrange([normal,error]).reason,'current_not_completed');
});

test('101??? ??? 100?: ?? SP/DP/??, ?? source ???? ?? ?? ??', () => {
  const rows = Array.from({ length: 101 }, (_, i) => row(i));
  const parsed = plain(sync().parseRecentPlays(csv(rows)));
  assert.deepEqual(parsed, rows.slice(1));
  assert.equal(keys.length, 21);
  assert.equal(keys.at(-1), 'game_version');
  assert.deepEqual(parsed.map(play => play.source), rows.slice(1).map(play => play.source));
  assert.equal(parsed.some(play => play.source === 'playdata'), true);
  assert.equal(parsed.some(play => play.source === 'currentsong'), true);
});
test('헤더 제외, 빈 CSV, 따옴표/쉼표/한글/이스케이프, 불완전 마지막 레코드 제외', () => {
  const { parseRecentPlays } = sync();
  assert.deepEqual(plain(parseRecentPlays('')), []);
  assert.deepEqual(plain(parseRecentPlays(csv([]))), []);
  for (const tail of ['"incomplete', csvLine(row(2)).trimEnd(), 'short,row\n']) {
    assert.deepEqual(plain(parseRecentPlays(csv([row(1)]) + tail)), [row(1)]);
  }
});
test('전체 이력 파서 공유 tokenizer: 인용/한글/개행/미완결 꼬리/19열 오류/최근100', () => {
  const api = sync(); const rows = Array.from({ length: 101 }, (_, i) => row(i));
  rows[0].title = '한글, "인용"\\줄\n개행';
  const input = csv(rows) + '"unfinished';
  assert.equal(api.parsePlayHistory(input).length, 101);
  assert.equal(api.parseRecentPlays(input).length, 100);
  assert.match(api.parsePlayHistory(input)[0].title, /한글/);
  assert.match(api.parsePlayHistory(input)[0].title, /\n/);
  const malformed = keys.slice(0, 18).join(',') + '\n';
  const detail = api.parsePlayHistoryDetailed(csv([rows[0]]) + malformed);
  assert.equal(detail.rows.length, 1); assert.deepEqual(plain(detail.lastCompleteError), { columns: 18 });
  assert.equal(api.evaluateAutomaticArrange(detail).reason, 'last_row_invalid');
});
test('완주 판정은 실제 16 judge 값과 notes만 사용하고 미완주/불량 판정은 제외', () => {
  const api = sync();
  const make = (notes, judged, miss = '0') => ({ ...row(1), notes: String(notes), miss_count: miss, judge_16: judged.join(' ') });
  assert.equal(api.isCompletedPlay(make(1058, [751,246,52,4,6,0,0,0,0,0,9,0,160,0,138,0], '10')), true);
  assert.equal(api.isCompletedPlay(make(1453, [776,431,211,10,48,0,0,0,0,0,35,0,317,0,325,0], '58')), true);
  assert.equal(api.isCompletedPlay(make(1058, [642,236,77,4,10,0,0,0,0,0,15,0,139,0,174,0])), false);
  assert.equal(api.isCompletedPlay(make(0, Array(16).fill(0))), false);
  assert.equal(api.isCompletedPlay(make(1, [1, 0])), false);
  assert.equal(api.isCompletedPlay(make(1, [...Array(15).fill(0), 'NaN'])), false);
});
test('자동 배열 순수 비교 표, 유효 숫자 sentinel, BP0 및 첫 기록', () => {
  const { compareArrangeScores } = sync();
  const cases = [
    [{lamp:4,bp:50,ex:1400},{lamp:5,bp:40,ex:1500},3], [{lamp:5,bp:50,ex:1400},{lamp:5,bp:40,ex:1500},2],
    [{lamp:5,bp:50,ex:1500},{lamp:5,bp:40,ex:1500},1], [null,{lamp:5,bp:40,ex:1500},0],
    [{lamp:null,bp:50,ex:null},{lamp:5,bp:40,ex:1500},1], [{lamp:5,bp:0,ex:1500},{lamp:5,bp:0,ex:1500},0],
    [{lamp:4,bp:60,ex:1600},{lamp:6,bp:30,ex:1500},2], [{lamp:6,bp:20,ex:1700},{lamp:5,bp:30,ex:1600},0],
    [{lamp:4,bp:50,ex:1400},{lamp:5,bp:40,ex:1500},3],
  ];
  for (const [previous,current,count] of cases) assert.equal(compareArrangeScores(previous,current).count,count);
  assert.equal(compareArrangeScores(null,{lamp:5,bp:0,ex:10}).count,0);
  const complete = row(1); complete.notes='1'; complete.judge_16='1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0';
  const base = { ...complete, source:'playdata', battle_flag:'0', difficulty:'DPA', song_id:'80123', clear_lamp:'5', miss_count:'0', ex_score:'100', settings_p1_11:'1 2 0 1 5 4 0 0 0 0 0' };
  const opts = sync().evaluateAutomaticArrange([base]); assert.equal(opts.count,0); assert.equal(opts.previous.lamp,null);
  const api = sync();
  const arrange = (p0, p5, flip = 0) => api.evaluateAutomaticArrange([{ ...base, settings_p1_11:`${p0} 2 0 ${flip} 5 ${p5} 0 0 0 0 0` }]).arrange;
  for (const [p0,p5,flip,expected] of [[0,0,0,-2],[0,0,1,1],[2,1,0,56],[3,1,1,49],[4,4,0,6],[4,3,0,66],[4,3,1,67]]) assert.equal(arrange(p0,p5,flip),expected);
  for (const patch of [{difficulty:'SPx'},{battle_flag:'1'}, {settings_p1_11:'1 2 1 1 5 4 0 0 0 0 0'},
    {settings_p1_11:'1 2 0 1 5 4 0 0 0 1 0'}, {settings_p1_11:'1 2 0 1 5 4 0 0 0 0'},
    {settings_p1_11:'1 2 0 1 5 4 0 0 0 0 0 9'}]) assert.equal(api.evaluateAutomaticArrange([{...base,...patch}]).excluded,true);
  assert.equal(api.evaluateAutomaticArrange([{...base, difficulty:'SPB'}]).reason,'not_dp');
  for (const value of ['', ' ', '-1', '4294967295', '-2', 'NaN']) {
    assert.deepEqual(plain(api.decodeArrangeScore({...base, clear_lamp:value, miss_count:value, ex_score:value})), {lamp:null,bp:null,ex:null});
  }
  assert.deepEqual(plain(api.decodeArrangeScore({...base, clear_lamp:'0', miss_count:'0', ex_score:'0'})), {lamp:null,bp:0,ex:0});
  assert.equal(sync().evaluateAutomaticArrange([{...base,judge_16:'0 0 0'}]).excluded,true);
});
test('완주 최신 이력 선택과 물리 순서: 이전 최고는 전체101행에 보존', () => {
  const api = sync(); const make = (lamp, bp, ex, timestamp) => ({ ...row(timestamp), timestamp:String(timestamp), song_id:'80123', difficulty:'DPA', notes:'1', judge_16:'1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0', source:'playdata', battle_flag:'0', settings_p1_11:'1 2 0 0 5 4 0 0 0 0 0', clear_lamp:String(lamp), miss_count:String(bp), ex_score:String(ex) });
  const history = [make(6,20,1700,1), ...Array.from({length:100},(_,i)=>make(4,50,1400,2)), make(5,30,1600,2)];
  const result = api.evaluateAutomaticArrange(history); assert.equal(result.previous.lamp,6); assert.equal(result.count,0);
  assert.equal(api.evaluateAutomaticArrange([make(4,50,1400,1),make(5,40,1500,1)]).current.timestamp,'1');
  assert.equal(api.evaluateAutomaticArrange([make(4,50,1400,1),make(5,40,1500,2),{...make(5,40,1500,3),judge_16:'0 0'}]).excluded,true);
});
test('수동/pending/종료 업로드는 게임 없이 계속 실행, pending plays 생략, NULL/[] 계약', async () => {
  const calls = [];
  const api = sync({ window: { infohsorry: { serviceStatus: { get: async () => ({ uploadEnabled: true }) } } },
    fetch: async (url, options) => { calls.push({ url, body: options?.body && JSON.parse(options.body) }); return { ok: true, json: async () => [] }; } });
  const base = { appVersion: 'test', profile: { iidxId: 'C123456789012', djName: '한글' }, starResult: null, charts: [] };
  for (const trigger of ['manual', 'pending', 'final']) {
    calls.length = 0;
    assert.equal((await api.uploadProfile({ ...base, plays: [row(1)], gameRecognized: async () => false })).ok, true, trigger);
    const sent = calls.find(x => x.url.endsWith('/rpc/upsert_user'));
    assert.ok(sent);
    assert.equal('p_plays' in sent.body, false);
  }
  for (const plays of [undefined, null, [], [row(1)]]) {
    calls.length = 0;
    await api.uploadProfile({ ...base, plays, gameRecognized: async () => true });
    const body = calls.find(x => x.url.endsWith('/rpc/upsert_user')).body;
    assert.equal('p_plays' in body, plays !== undefined);
    if (plays !== undefined) assert.deepEqual(body.p_plays, plays);
  }
});
test('전송 순간 재확인: serviceStatus 대기 중 게임이 종료되어도 기존 업로드는 유지', async () => {
  let recognized = true; let body;
  const api = sync({ window: { infohsorry: { serviceStatus: { get: async () => { recognized = false; return { uploadEnabled: true }; } } } },
    fetch: async (url, options) => { if (url.endsWith('/rpc/upsert_user')) body = JSON.parse(options.body); return { ok: true, json: async () => [] }; } });
  assert.equal((await api.uploadProfile({ profile: { iidxId: 'C123456789012' }, charts: [], starResult: null,
    plays: [row(0)], gameRecognized: async () => recognized })).ok, true);
  assert.equal('p_plays' in body, false);
});
const actualCsv = `timestamp,song_id,title,difficulty,notes,ex_score,pgreat,great,miss_count,clear_lamp,dj_rate_pct,dj_rank,judge_16,settings_p1_11,settings_p2_11,battle_flag,gauge_p1_w77,gauge_p2_w78,source
2026-10-14T14:48:45.825Z,80121,"Bang Pad(Werk Mix)",SPA,1662,1637,656,325,126,-1,49.25,C,"271 161 219 38 53 385 164 138 7 28 68 32 64 66 316 236","1 1 1 0 5 1 0 0 0 0 1","0 2 0 0 5 0 0 0 0 0 0",1,0,8,currentsong
2026-10-14T14:51:17.972Z,80126,"The 88's Instigation",SPH,1672,1788,719,350,114,-1,53.47,C,"304 161 225 33 57 415 189 132 7 17 66 20 105 127 281 194","1 1 1 0 5 0 0 0 0 0 1","1 1 1 0 5 1 0 0 0 0 1",1,0,90,currentsong
2026-10-14T11:14:50.321Z,80118,"NEPHILIM DELTA",DPA,1631,1825,674,477,154,1,55.95,B,"292 224 232 39 79 382 253 150 5 31 77 21 179 189 277 214","0 2 0 0 5 0 0 0 0 0 0","0 2 0 0 5 0 0 0 0 0 0",0,0,24,playdata`
const actualCsvWithFinalLf = actualCsv.slice(0, -1) + String.fromCharCode(10);
const actualRows = () => sync().parseRecentPlays(actualCsvWithFinalLf.replaceAll(String.fromCharCode(10), String.fromCharCode(13, 10)));
const p1With = (r, index, value) => { const words = r.settings_p1_11.split(' '); words[index] = String(value); return { ...r, settings_p1_11: words.join(' ') }; };
test('실제 19열 3줄: Bang Pad DBR 램프 변환, 부적격 두 줄도 plays 유지', async () => {
  const api = sync(); const rows = api.parseRecentPlays(actualCsvWithFinalLf.replaceAll(String.fromCharCode(10), String.fromCharCode(13, 10)));
  assert.equal(keys.length, 21); assert.equal(rows.length, 3);
  assert.deepEqual(plain(api.decodeBattleRandomPlay(rows[0])), { diff: 3, lamp: 1, ex_score: 1637 });
  assert.equal(api.decodeBattleRandomPlay(rows[1]), null); assert.equal(api.decodeBattleRandomPlay(rows[2]), null);
  assert.deepEqual(plain(api.playsForGame(rows, true)), plain(rows));
  const calls = [];
  const songs = async () => new Map([[OhsorryNorm.norm('Bang Pad(Werk Mix)'), [{ song_id: 9001, title: 'Bang Pad(Werk Mix)', ac: 2, legen: 0 }]]]);
  await api.uploadAutomaticDbr(rows, 'C123456789012', async () => true, undefined, async () => 'token', async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true }; }, songs);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], { song_id: 9001, diff: 3, lamp: 1, ex_score: 1637, improvements_only: true });
  assert.equal('notes' in calls[0], false);
});
test('첫 실제 줄에서 각 필수 조건 OFF, RANDOM 계열 및 허용 범위 외 option은 부적격', () => {
  const api = sync(); const first = actualRows()[0];
  for (const [index, value] of [[0, 0], [5, 0], [2, 0], [0, 2], [0, 3], [1, 5], [2, 2]]) assert.equal(api.decodeBattleRandomPlay(p1With(first, index, value)), null);
  assert.equal(api.decodeBattleRandomPlay({ ...first, battle_flag: '0' }), null);
  assert.equal(api.decodeBattleRandomPlay({ ...first, settings_p2_11: '1 1 1 0 5 1 0 0 0 0 1' })?.lamp, 1);
  assert.equal(api.decodeBattleRandomPlay({ ...first, settings_p2_11: 'garbage' })?.lamp, 1);
});
test('게이지 경계는 p2_w78만 사용하고 clear_lamp와 AUTO SCRATCH는 별도 감점하지 않음', () => {
  const api = sync(); const first = actualRows()[0];
  for (const [kind, gauge, expected] of [[1,0,1],[1,59,1],[1,60,2],[1,79,2],[1,80,3],[1,100,3],[2,0,1],[2,59,1],[2,60,2],[2,79,2],[2,80,3],[2,100,3],[0,79,1],[0,80,4],[3,0,1],[3,1,5],[4,0,1],[4,1,6]]) {
    const row = { ...p1With(first, 1, kind), gauge_p2_w78: String(gauge), gauge_p1_w77: '100', clear_lamp: '6' };
    assert.equal(api.decodeBattleRandomPlay(row)?.lamp, expected, `kind=${kind}, gauge=${gauge}`);
  }
});
test('diff 매핑, EX·notes 원값, 잘못된 입력은 null', () => {
  const api = sync(); const first = actualRows()[0];
  for (const [difficulty, diff] of [['SPB',0],['SPN',1],['SPH',2],['SPA',3],['SPL',4]]) assert.equal(api.decodeBattleRandomPlay({ ...first, difficulty })?.diff, diff);
  for (const difficulty of ['DPN','DPA','unknown','']) assert.equal(api.decodeBattleRandomPlay({ ...first, difficulty }), null);
  assert.equal(api.decodeBattleRandomPlay({ ...first, ex_score: '1637.5' })?.ex_score, 1637.5);
  assert.deepEqual(plain(api.decodeBattleRandomPlay({ ...first, notes: '1662' })), { diff: 3, lamp: 1, ex_score: 1637 });
  for (const patch of [{ song_id: '' }, { song_id: 'bad' }, { song_id: '-1' }, { ex_score: '' }, { ex_score: 'bad' }, { ex_score: '-1' }, { notes: '' }, { notes: 'bad' }, { notes: '0' }, { gauge_p2_w78: '' }, { gauge_p2_w78: 'bad' }, { gauge_p2_w78: '-1' }, { settings_p1_11: '1 1 1' }, { settings_p1_11: '1 1 bad 0 5 1 0 0 0 0 1' }]) assert.equal(api.decodeBattleRandomPlay({ ...first, ...patch }), null);
});
test('확정 후보 테스트 경계: 기존 Bearer API에 improvements_only:true로 클라이언트 전체 직렬 전송', async () => {
  const api = sync(); const calls = []; let active = 0; let maxActive = 0;
  const decode = () => ({ diff: 3, lamp: 5, ex_score: 100 });
  const songs = async () => new Map([1, 2, 3].map(id => [OhsorryNorm.norm(`Fixture ${id}`), [{ song_id: 9000 + id, title: `Fixture ${id}`, ac: 2, legen: 0 }]]));
  const rows = ids => ids.map(id => ({ ...row(id), title: `Fixture ${id}` }));
  const send = async (url, options) => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    calls.push({ url, options, body: JSON.parse(options.body) }); active--;
    return { ok: true };
  };
  await Promise.all([
    api.uploadAutomaticDbr(rows([1, 2]), 'C123456789012', async () => true, decode, async () => 'existing-bearer', send, songs),
    api.uploadAutomaticDbr(rows([3]), 'C123456789012', async () => true, decode, async () => 'existing-bearer', send, songs),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map(x => x.body.song_id), [9001, 9002, 9003]);
  for (const call of calls) {
    assert.equal(call.url, 'https://iidx.in/api/me/dbr-scores');
    assert.equal(call.options.headers.Authorization, 'Bearer existing-bearer');
    assert.equal(call.body.improvements_only, true);
    assert.equal('iidx_id' in call.body, false);
    assert.equal('pw' in call.body, false);
  }
});
test('자동 DBR은 게임 미인식/전송 중 종료에서 생략', async () => {
  const api = sync(); let requests = 0; let recognized = false;
  const decode = () => ({ diff: 3, lamp: 5, ex_score: 100 });
  const bearer = async () => 'token';
  const send = async () => { requests++; recognized = false; return { ok: true }; };
  const songs = async () => new Map([[OhsorryNorm.norm('Fixture Song'), [{ song_id: 9001, title: 'Fixture Song', ac: 2, legen: 0 }]]]);
  await api.uploadAutomaticDbr([{ ...row(1), title: 'Fixture Song' }], 'C123456789012', async () => recognized, decode, bearer, send, songs);
  assert.equal(requests, 0);
  recognized = true;
  await api.uploadAutomaticDbr([{ ...row(1), title: 'Fixture Song' }, { ...row(2), title: 'Fixture Song' }], 'C123456789012', async () => recognized, decode, bearer, send, songs);
  assert.equal(requests, 1);
});
test('DBR은 0개/복수 후보만 건너뛰고 제목 정규화 후 단일 내부 ID를 전송', async () => {
  const api = sync(); const calls = [];
  const rows = ['Missing', 'Duplicate', ' Fixture Song  '].map((title, id) => ({ ...row(id), title }));
  const songs = async () => new Map([
    [OhsorryNorm.norm('Duplicate'), [
      { song_id: 9101, title: 'Duplicate', ac: 2, legen: 0 }, { song_id: 9102, title: 'Duplicate', ac: 2, legen: 0 },
    ]],
    [OhsorryNorm.norm('Fixture Song'), [{ song_id: 9001, title: 'Fixture Song', ac: 2, legen: 0 }]],
  ]);
  await api.uploadAutomaticDbr(rows, 'C123456789012', async () => true,
    () => ({ diff: 3, lamp: 1, ex_score: 99 }), async () => 'token', async (url, options) => {
      calls.push(JSON.parse(options.body)); return { ok: true };
    }, songs);
  assert.deepEqual(calls, [{ song_id: 9001, diff: 3, lamp: 1, ex_score: 99, improvements_only: true }]);
});
test('DBR은 SPA에 ac, SPL에 legen 비트를 적용하고 LEG 후보가 없으면 건너뜀', async () => {
  const api = sync(); const calls = [];
  const rows = [{ ...row(1), title: 'Fixture Song', difficulty: 'SPA' }, { ...row(2), title: 'Fixture Song', difficulty: 'SPL' }];
  const both = async () => new Map([[OhsorryNorm.norm('Fixture Song'), [
    { song_id: 9001, title: 'Fixture Song', ac: 2, legen: 0 }, { song_id: 9002, title: 'Fixture Song', ac: 0, legen: 2 },
  ]]]);
  await api.uploadAutomaticDbr(rows, 'C123456789012', async () => true,
    r => ({ diff: r.difficulty === 'SPL' ? 4 : 3, lamp: 1, ex_score: 99 }), async () => 'token', async (url, options) => {
      calls.push(JSON.parse(options.body)); return { ok: true };
    }, both);
  assert.deepEqual(calls, [
    { song_id: 9001, diff: 3, lamp: 1, ex_score: 99, improvements_only: true },
    { song_id: 9002, diff: 4, lamp: 1, ex_score: 99, improvements_only: true },
  ]);
  calls.length = 0;
  const acOnly = async () => new Map([[OhsorryNorm.norm('Fixture Song'), [{ song_id: 9001, title: 'Fixture Song', ac: 2, legen: 0 }]]]);
  await api.uploadAutomaticDbr([rows[1]], 'C123456789012', async () => true,
    () => ({ diff: 4, lamp: 1, ex_score: 99 }), async () => 'token', async (url, options) => {
      calls.push(JSON.parse(options.body)); return { ok: true };
    }, acOnly);
  assert.equal(calls.length, 0);
});
test('자동 배열 PUT은 INF/LEG 단일 후보를 웹 song_id로 정확히 전송하고 옵션을 보존', async () => {
  const songs = [
    { song_id: 9001, title: 'Fixture Song', ac: 2, legen: 0 },
    { song_id: 9002, title: 'Fixture Song', ac: 0, legen: 2 },
  ];
  let requests = [];
  const api = sync();
  const send = async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return { ok: true }; };
  const evaluation = { current: { title: 'Fixture Song', song_id: '123' }, diff: 3, arrange: -2, excluded: false };
  const songsForFixture = async () => new Map([[OhsorryNorm.norm('Fixture Song'), songs]]);
  await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async id => id === 'C123456789012' ? 'fixture-token' : null, send, songsForFixture);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests.map(x => [x.url, x.options.method, x.options.credentials, x.options.headers.Authorization, x.body]), [
    ['https://iidx.in/api/me/chart-arrange', 'PUT', 'omit', 'Bearer fixture-token', { song_id: 9001, diff: 3, play_style: 1, arrange: -2 }],
  ]);
  requests = [];
  await api.uploadAutomaticArrange({ ...evaluation, diff: 4, arrange: 40 }, 'C123456789012', async () => true,
    async () => 'fixture-token', send, songsForFixture);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://iidx.in/api/me/chart-arrange');
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.deepEqual(requests[0].body, { song_id: 9002, diff: 4, play_style: 1, arrange: 40 });
  requests = [];
  await api.uploadAutomaticArrange({ ...evaluation, diff: 4, arrange: 89 }, 'C123456789012', async () => true,
    async () => 'fixture-token', send, songsForFixture);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://iidx.in/api/me/chart-arrange');
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.equal(requests[0].body.arrange, 89);
});
test('자동 배열은 후보 누락/중복, 미인증, 계정 불일치, 게임 미인식에서 PUT하지 않음', async () => {
  const api = sync(); let puts = 0; let ensured = 0;
  const send = async () => { puts++; return { ok: true }; };
  const evaluation = { current: { title: 'Fixture Song', song_id: '123' }, diff: 3, arrange: 40, excluded: false };
  for (const candidates of [[], [{ song_id: 1, ac: 2, legen: 0 }, { song_id: 2, ac: 2, legen: 0 }]]) {
    const songs = async () => new Map([[OhsorryNorm.norm('Fixture Song'), candidates]]);
    await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => 'token', send, songs);
  }
  const songs = async () => new Map([[OhsorryNorm.norm('Fixture Song'), [{ song_id: 1, ac: 2, legen: 0 }]]]);
  await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => null, send, songs);
  await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async id => id === 'other' ? 'token' : null, send, songs);
  await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => false, async () => 'token', send, songs);
  assert.equal(puts, 0); assert.equal(ensured, 0);
});
test('자동 배열 HTTP/네트워크 실패는 재시도 없이 반환하고 다음 호출은 진행', async () => {
  const api = sync(); const songs = async () => new Map([[OhsorryNorm.norm('Fixture Song'), [{ song_id: 9001, ac: 2, legen: 0 }]]]);
  const evaluation = { current: { title: 'Fixture Song', song_id: '123' }, diff: 3, arrange: 89, excluded: false };
  const requests = [];
  const sendFor = response => async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    if (response instanceof Error) throw response;
    return response;
  };
  const expectedBody = { song_id: 9001, diff: 3, play_style: 1, arrange: 89 };
  assert.equal((await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => 'token', sendFor({ ok: false, status: 503 }), songs)).ok, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://iidx.in/api/me/chart-arrange');
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer token');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.deepEqual(requests[0].body, expectedBody);
  assert.equal((await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => 'token', sendFor(new Error('network')), songs)).ok, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://iidx.in/api/me/chart-arrange');
  assert.equal(requests[1].options.method, 'PUT');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer token');
  assert.equal(requests[1].options.credentials, 'omit');
  assert.deepEqual(requests[1].body, expectedBody);
  assert.equal((await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => 'token', sendFor({ ok: true }), songs)).ok, true);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, 'https://iidx.in/api/me/chart-arrange');
  assert.equal(requests[2].options.method, 'PUT');
  assert.equal(requests[2].options.headers.Authorization, 'Bearer token');
  assert.equal(requests[2].options.credentials, 'omit');
  assert.deepEqual(requests[2].body, expectedBody);
});
test('saveOnce 실제 저장 경계: A→B 경로, 미취득 생략, append 성공 후 해당 계정 알림, 공용 CSV 불변', () => {
  const store = load(read('../../main/accountTsvStore.ts'), { electron: { app: { getPath: () => '/fixture/userData' } }, fs: { promises: {} }, path,
    './tsv': {}, './memory': {}, '../shared/account': {} });
  const files = new Map([['/fixture/userData/play-log/plays.csv', Buffer.from('공용 원본\r\n')]]);
  const original = Buffer.from(files.values().next().value); const events = []; const logs = [];
  let id = 'C123456789012'; let phase = 0; let fail = false; let clock = 0; let serial = 0;
  const timers = new Map(); const scheduleTimer = (fn, ms) => { const timerId = ++serial; timers.set(timerId, { at: clock + ms, fn }); return timerId; };
  const memory = {
    findInfinitas: () => ({ pid: 7, handle: 7, modBaseAddr: 0x140000000n }), closeHandle() {},
    readBytes(_handle, address, size) {
      const buffer = Buffer.alloc(size);
      if (size === 96) for (const offset of [0,8,16]) buffer.writeInt32LE(20000, offset);
      else if (address === 0x1400010b0n) buffer.writeInt32LE(phase ? 0 : 1);
      else if (address === 0x140001fe8n) buffer.writeInt32LE(0);
      return buffer;
    },
  };
  const logger = load(read('../../main/playLogger.ts'), { fs: {
    statSync: () => ({ mtimeMs: 1, size: 1 }), readFileSync: () => 'judgeData=0x140001000\nplaySettings=0x140002000\nplayData=0x140003000\nsongList=0x140004000',
    existsSync: p => files.has(p), mkdirSync() {}, writeFileSync: (p, value) => files.set(p, Buffer.from(value)),
    appendFileSync: (p, value) => { if (fail) throw new Error('append failed'); const prior = files.get(p) ?? Buffer.alloc(0); files.set(p, Buffer.concat([prior, Buffer.from(value)])); },
  }, path: { dirname: p => path.dirname(p) }, './accountTsvStore': { accountPlayCsvPath: store.accountPlayCsvPath },
  './memory': memory, './playLog': load(read('../../main/playLog.ts')),
  '../shared/uploadSnapshot': shared }, {
    performance: { now: () => clock }, Date, setTimeout: scheduleTimer, clearTimeout: timerId => timers.delete(timerId),
  });
  const stop = logger.startPlayLogger({ offsetsPath: '/fixture/offsets.txt', appVersion: 'test', getGameVersion: () => 'game',
    getAccount: () => id, onAppend: event => events.push({ ...event }), log: line => logs.push(line) });
  const advance = to => {
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= to).sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0];
      if (!next) break;
      timers.delete(next[0]); clock = next[1].at; next[1].fn();
    }
    clock = to;
  };
  const play = accountId => { id = accountId; phase = 0; advance(clock + 2000); phase = 1; advance(clock + 500); advance(clock + 1500); };
  advance(2000); phase = 1; advance(2500); advance(4000);
  play('C999999999999'); play(null);
  assert.deepEqual(events, [{ iidxId: 'C123456789012' }, { iidxId: 'C999999999999' }], JSON.stringify(logs));
  for (const account of ['C123456789012', 'C999999999999']) assert.ok(files.has(store.accountPlayCsvPath(account)));
  assert.equal(logs.filter(line => line.includes('error -1 ')).length, 1);
  id = 'C123456789012'; fail = true; play(id); assert.equal(events.length, 2);
  assert.deepEqual(files.get('/fixture/userData/play-log/plays.csv'), original);
  assert.equal(store.accountPlayCsvPath('../outside'), null);
  stop();
});
test('기존 예약·초기 2초·재시작 pending·종료 흐름과 IPC 연결 유지', () => {
  const app = read('./App.tsx'); const main = read('../../main/index.ts'); const preload = read('../../preload/index.ts');
  assert.match(app, /AUTO_UPLOAD_MIN_GAP_MS = 3 \* 60 \* 1000/);
  assert.equal(load(read('./initialAutoUpload.ts')).INITIAL_AUTO_UPLOAD_STABLE_MS, 2000);
  assert.match(app, /INITIAL_AUTO_UPLOAD_DELAY_MS = INITIAL_AUTO_UPLOAD_STABLE_MS/);
  assert.match(app, /onPlayAppend\?\.\(\(\{ iidxId \}\) => runIfDue\(iidxId\)\)/);
  assert.match(app, /await uploadSnapshot\(snapshot, 'pending'\)/);
  assert.match(app, /await tryUpload\('final'\)/);
  assert.match(app, /finalDone\(outcome\)/);
  assert.match(preload, /ipcRenderer\.invoke\('account:readPlayCsv', iidxId\)/);
  assert.match(preload, /ipcRenderer\.on\('play:appended', listener\)/);
  assert.match(main, /webContents\.send\('play:appended', event\)/);
  assert.equal(main.match(/startPlayLogger\(\{/g).length, 1);
});

test('CSV 증가 알림은 기존 runIfDue 예약을 깨운다: 3분 간격과 초기 안정 대기 2초 유지', async () => {
  const app = read('./App.tsx');
  const scheduling = app.slice(app.indexOf('    let initialTimer: number | null = null;'), app.indexOf('    const runManual ='));
  const id = 'C123456789012'; const scope = { iidxId: id, epoch: 1 };
  const state = { bundleReady: true, scope, rowsRevision: 1, expectedBundle: {} };
  const initialAutoUploadSucceededRef = { current: true }; const autoUploadBusyRef = { current: false };
  const scheduled = []; const uploads = []; let now = 200_000; let last = 100_000;
  const api = load(`export function setup() { ${scheduling} return runIfDue; }`, {}, {
    uploadStateRef: { current: state }, sessionRef: { current: { pid: 123, generation: 1 } },
    lastSnapshotRef: { current: { iidxId: id, generation: 1 } }, accountScopeRef: { current: scope },
    selectedViewerIdRef: { current: id }, initialAutoUploadSucceededRef, autoUploadBusyRef,
    rowsRef: { current: [1] }, isFloorSeedCurrent: (a, b) => a.epoch === b.epoch,
    readLastUploadAt: () => last, isUploadDue: (at, time, gap) => time - at >= gap,
    Date: class extends Date { static now() { return now; } }, AUTO_UPLOAD_MIN_GAP_MS: 180_000, INITIAL_AUTO_UPLOAD_DELAY_MS: 2000,
    uploadIdentityOk: () => ({ ok: true, id }),
    tryUpload: async trigger => { uploads.push(trigger); return { kind: 'success' }; },
    window: { setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, clearTimeout() {} },
    setTimeout() {}, setVecRecomputeKey() {},
  });
  const runIfDue = api.setup();
  const onAppend = ({ iidxId }) => runIfDue(iidxId);
  onAppend({ iidxId: 'C999999999999' }); assert.equal(uploads.length, 0);
  onAppend({ iidxId: id }); assert.equal(uploads.length, 0);
  now = last + 180_000;
  onAppend({ iidxId: id }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uploads, ['auto']); assert.equal(scheduled.length, 0);
  initialAutoUploadSucceededRef.current = false; autoUploadBusyRef.current = false; uploads.length = 0;
  onAppend({ iidxId: id }); assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 2000); assert.equal(uploads.length, 0);
  scheduled[0].callback(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(uploads, ['auto']);
});

test('계정 CSV 읽기 IPC 저장소는 UTF-8 원본을 반환하고 없는 파일은 빈 CSV', async () => {
  const content = csv([row(1)]); const calls = [];
  const store = load(read('../../main/accountTsvStore.ts'), { electron: { app: { getPath: () => '/fixture/userData' } },
    fs: { promises: { readFile: async (file, encoding) => {
      calls.push({ file, encoding });
      if (file.includes('C999999999999')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return content;
    } } }, path, './tsv': {}, './memory': {}, '../shared/account': {} });
  assert.deepEqual(plain(await store.readAccountPlayCsv('C123456789012')), { ok: true, csv: content });
  assert.equal(calls[0].file, store.accountPlayCsvPath('C123456789012'));
  assert.equal(calls[0].encoding, 'utf8');
  assert.deepEqual(plain(await store.readAccountPlayCsv('C999999999999')), { ok: true, found: false, csv: '' });
  assert.deepEqual(plain(await store.readAccountPlayCsv('../outside')), { ok: false, error: 'invalid id' });
  assert.equal(calls.length, 2);
});
