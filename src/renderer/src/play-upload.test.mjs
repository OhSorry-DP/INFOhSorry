import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';

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
    '../../shared/match': { norm: x => x, slotToDiff: x => x }, '../../shared/dataSource': { DATA_BASE: 'https://fixture.invalid' } }, globals);
}
const row = i => Object.fromEntries(keys.map(key => [key, key === 'timestamp' ? String(i) : key === 'title' ? '??, "?" \\ ??\n?? ?' : key === 'difficulty' ? ['SPN', 'DPA', 'SPA'][i % 3] : key === 'battle_flag' ? String(i % 2) : key === 'source' ? (i % 2 ? 'currentsong' : 'playdata') : '001']));
const csvLine = value => keys.map(key => `"${value[key].replaceAll('"', '""')}"`).join(',') + '\r\n';
const csv = rows => keys.join(',') + '\n' + rows.map(csvLine).join('');
const plain = x => JSON.parse(JSON.stringify(x));

test('101??? ??? 100?: ?? SP/DP/??, ?? source ???? ?? ?? ??', () => {
  const rows = Array.from({ length: 101 }, (_, i) => row(i));
  const parsed = plain(sync().parseRecentPlays(csv(rows)));
  assert.deepEqual(parsed, rows.slice(1));
  assert.equal(keys.length, 19);
  assert.equal(keys.at(-1), 'source');
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
  assert.equal(keys.length, 19); assert.equal(rows.length, 3);
  assert.deepEqual(plain(api.decodeBattleRandomPlay(rows[0])), { song_id: 80121, diff: 3, lamp: 1, ex_score: 1637 });
  assert.equal(api.decodeBattleRandomPlay(rows[1]), null); assert.equal(api.decodeBattleRandomPlay(rows[2]), null);
  assert.deepEqual(plain(api.playsForGame(rows, true)), plain(rows));
  const calls = [];
  await api.uploadAutomaticDbr(rows, 'C123456789012', async () => true, undefined, async () => 'token', async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: true }; });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], { song_id: 80121, diff: 3, lamp: 1, ex_score: 1637, improvements_only: true });
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
  assert.equal(api.decodeBattleRandomPlay({ ...first, notes: '1662' })?.song_id, 80121);
  for (const patch of [{ song_id: '' }, { song_id: 'bad' }, { song_id: '-1' }, { ex_score: '' }, { ex_score: 'bad' }, { ex_score: '-1' }, { notes: '' }, { notes: 'bad' }, { notes: '0' }, { gauge_p2_w78: '' }, { gauge_p2_w78: 'bad' }, { gauge_p2_w78: '-1' }, { settings_p1_11: '1 1 1' }, { settings_p1_11: '1 1 bad 0 5 1 0 0 0 0 1' }]) assert.equal(api.decodeBattleRandomPlay({ ...first, ...patch }), null);
});
test('확정 후보 테스트 경계: 기존 Bearer API에 improvements_only:true로 클라이언트 전체 직렬 전송', async () => {
  const api = sync(); const calls = []; let active = 0; let maxActive = 0;
  const decode = r => ({ song_id: Number(r.timestamp), diff: 3, lamp: 5, ex_score: 100 });
  const send = async (url, options) => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    calls.push({ url, options, body: JSON.parse(options.body) }); active--;
    return { ok: true };
  };
  await Promise.all([
    api.uploadAutomaticDbr([row(1), row(2)], 'C123456789012', async () => true, decode, async () => 'existing-bearer', send),
    api.uploadAutomaticDbr([row(3)], 'C123456789012', async () => true, decode, async () => 'existing-bearer', send),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(calls.map(x => x.body.song_id), [1, 2, 3]);
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
  const decode = () => ({ song_id: 1, diff: 3, lamp: 5, ex_score: 100 });
  const bearer = async () => 'token';
  const send = async () => { requests++; recognized = false; return { ok: true }; };
  await api.uploadAutomaticDbr([row(1)], 'C123456789012', async () => recognized, decode, bearer, send);
  assert.equal(requests, 0);
  recognized = true;
  await api.uploadAutomaticDbr([row(1), row(2)], 'C123456789012', async () => recognized, decode, bearer, send);
  assert.equal(requests, 1);
});
test('자동 배열 PUT은 INF/LEG 단일 후보를 웹 song_id로 정확히 전송하고 옵션을 보존', async () => {
  const songs = [
    { song_id: 9001, title: 'Fixture Song', ac: 2, legen: 0 },
    { song_id: 9002, title: 'Fixture Song', ac: 0, legen: 2 },
  ];
  let requests = [];
  const api = sync({ fetch: async () => ({ ok: true, json: async () => songs }) });
  api.getSongsCache = async () => new Map([['fixture song', songs]]);
  const send = async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return { ok: true }; };
  const evaluation = { current: { title: 'Fixture Song', song_id: '123' }, diff: 3, arrange: -2, excluded: false };
  await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async id => id === 'C123456789012' ? 'fixture-token' : null, send);
  assert.deepEqual(requests.map(x => [x.url, x.options.method, x.options.credentials, x.options.headers.Authorization, x.body]), [
    ['https://iidx.in/api/me/chart-arrange', 'PUT', 'omit', 'Bearer fixture-token', { song_id: 9001, diff: 3, play_style: 1, arrange: -2 }],
  ]);
  requests = [];
  await api.uploadAutomaticArrange({ ...evaluation, diff: 4, arrange: 40 }, 'C123456789012', async () => true,
    async () => 'fixture-token', send);
  assert.deepEqual(requests[0].body, { song_id: 9002, diff: 4, play_style: 1, arrange: 40 });
  requests = [];
  await api.uploadAutomaticArrange({ ...evaluation, diff: 4, arrange: 89 }, 'C123456789012', async () => true,
    async () => 'fixture-token', send);
  assert.equal(requests[0].body.arrange, 89);
});
test('자동 배열은 후보 누락/중복, 미인증, 계정 불일치, 게임 미인식에서 PUT하지 않음', async () => {
  const api = sync(); let puts = 0; let ensured = 0;
  const send = async () => { puts++; return { ok: true }; };
  const evaluation = { current: { title: 'Fixture Song', song_id: '123' }, diff: 3, arrange: 40, excluded: false };
  for (const candidates of [[], [{ song_id: 1, ac: 2, legen: 0 }, { song_id: 2, ac: 2, legen: 0 }]]) {
    api.getSongsCache = async () => new Map([['fixture song', candidates]]);
    await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => 'token', send);
  }
  api.getSongsCache = async () => new Map([['fixture song', [{ song_id: 1, ac: 2, legen: 0 }]]]);
  await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => null, send);
  await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async id => id === 'other' ? 'token' : null, send);
  await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => false, async () => 'token', send);
  assert.equal(puts, 0); assert.equal(ensured, 0);
});
test('자동 배열 HTTP/네트워크 실패는 재시도 없이 반환하고 다음 호출은 진행', async () => {
  const api = sync(); api.getSongsCache = async () => new Map([['Fixture Song', [{ song_id: 9001, ac: 2, legen: 0 }]]]);
  const evaluation = { current: { title: 'Fixture Song', song_id: '123' }, diff: 3, arrange: 89, excluded: false };
  let calls = 0;
  const failing = async () => { calls++; return { ok: false, status: 503 }; };
  assert.equal((await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => 'token', failing)).ok, false);
  assert.equal(calls, 1);
  const network = async () => { calls++; throw new Error('network'); };
  assert.equal((await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => 'token', network)).ok, false);
  assert.equal(calls, 2);
  const next = async () => { calls++; return { ok: true }; };
  assert.equal((await api.uploadAutomaticArrange(evaluation, 'C123456789012', async () => true, async () => 'token', next)).ok, true);
  assert.equal(calls, 3);
});
test('saveOnce 실제 저장 경계: A→B 경로, 미취득 생략, append 성공 후 해당 계정 알림, 공용 CSV 불변', () => {
  const store = load(read('../../main/accountTsvStore.ts'), { electron: { app: { getPath: () => '/fixture/userData' } }, fs: { promises: {} }, path,
    './tsv': {}, './memory': {}, '../shared/account': {} });
  const logger = read('../../main/playLogger.ts');
  const save = logger.slice(logger.indexOf('  const saveOnce ='), logger.indexOf('  const tick ='));
  const files = new Map([['/fixture/userData/play-log/plays.csv', Buffer.from('공용 원본\r\n')]]);
  const original = Buffer.from(files.values().next().value); const events = []; let id = 'C123456789012'; let fail = false;
  const api = load(`export function save() { ${save} saveOnce(); }`, {}, {
    opts: { getAccount: () => id, onAppend: e => events.push({ ...e }), log() {} }, handle: {},
    accountPlayCsvPath: store.accountPlayCsvPath, dirname: path.dirname, mkdirSync() {},
    existsSync: p => files.has(p), writeFileSync: (p, value) => files.set(p, Buffer.from(value)),
    appendFileSync: (p, value) => { if (fail) throw new Error('append failed'); files.set(p, Buffer.concat([files.get(p), Buffer.from(value)])); },
    PLAY_LOG_HEADER: keys.join(','), buildSnapshotRow: () => ({ row: csvLine(row(1)).trimEnd(), songId: 1 }),
  });
  api.save(); id = 'C999999999999'; api.save(); id = null; api.save();
  assert.deepEqual(events, [{ iidxId: 'C123456789012' }, { iidxId: 'C999999999999' }]);
  for (const account of ['C123456789012', 'C999999999999']) assert.ok(files.has(store.accountPlayCsvPath(account)));
  id = 'C123456789012'; fail = true; assert.throws(() => api.save(), /append failed/); assert.equal(events.length, 2);
  assert.deepEqual(files.get('/fixture/userData/play-log/plays.csv'), original);
  assert.equal(store.accountPlayCsvPath('../outside'), null);
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
  assert.deepEqual(plain(await store.readAccountPlayCsv('C999999999999')), { ok: true, csv: '' });
  assert.deepEqual(plain(await store.readAccountPlayCsv('../outside')), { ok: false, error: 'invalid id' });
  assert.equal(calls.length, 2);
});
