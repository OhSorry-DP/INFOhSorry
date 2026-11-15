import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => dependencies[name], ...globals });
  return exports;
}
const offsets = load('../../shared/profileOffsets.ts');
const flush = () => new Promise(resolve => setImmediate(resolve));
const goodRadar = [100, ...Array(11).fill(0)];

function profile(options = {}) {
  const calls = [], timers = [], hooks = [];
  const data = { id: 'A123456789012', radar: goodRadar, dan: [5, 6], session: { pid: 123, generation: 1 }, ...options };
  let cursor = 0, mounted = false, fetchCount = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; calls.push(['set', i, hooks[i]]); }]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
    useEffect(fn) { cursor++; if (!mounted) fn(); },
  };
  const window = { infohsorry: {
    session: { getState: async () => ({ ...data.session }) },
    offsets: { getProfile: async () => { fetchCount++; return data.getProfile ? data.getProfile(fetchCount) : { profilePolicy: data.policy ?? 'normal', profile: data.remote ?? null }; } },
    memory: {
      readString: async (_exe, offset) => { calls.push(['string', offset]); return { ok: true, text: offset === BigInt(offsets.PROFILE_OFFSETS.iidxId.offset).toString() ? data.id : offset === '99' ? 'legacy' : 'DJ' }; },
      readViaAnchor: async (...args) => { calls.push(['anchor', ...args]); return { ok: false }; },
      readInts: async (_exe, offset) => { const key = offset === BigInt(offsets.PROFILE_NUMERIC_OFFSETS.radar.offset).toString() ? 'radar' : 'dan'; calls.push(['ints', key]); const value = data[key]; if (data.onRead) data.onRead(key); if (value instanceof Error) throw value; return value === null ? { ok: false } : { ok: true, values: value }; },
      setPlayAccount: async () => ({ ok: true }),
    },
  }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} };
  const localStorage = { getItem(key) { calls.push(['storage', key]); return key.includes('sprank') || key.includes('dprank') ? data.storage ?? null : null; } };
  const api = load('./useProfile.ts', { react, '../../shared/profileOffsets': offsets, './NotesRadar': {}, '../../shared/types': {}, './diagLog': { addDiagLine() {} } }, { window, localStorage, console: { warn() {}, log() {} } });
  const render = () => { cursor = 0; const result = api.useProfile({ stage: 'ready' }); mounted = true; return result; };
  const next = async () => { assert.ok(timers.length, '다음 poll 예약'); timers.shift()(); await flush(); };
  return { data, calls, timers, render, next, fetchCount: () => fetchCount, start: async () => { render(); await flush(); }, read: async () => { await next(); return render(); } };
}

test('권위 있는 -1 종단과 스타일별 레이더', async () => {
  const radar = Array(12).fill(0); radar[1] = 100;
  const h = profile({ radar, dan: [-1, 16] }); await h.start(); const p = await h.read();
  assert.equal(p.spRankReadState, 'none');
  assert.equal(p.spRank, null); assert.equal(p.spRankInt, null); assert.equal(p.spRadar, null);
  assert.equal(p.dpRankReadState, 'value'); assert.equal(p.dpRank, '十段'); assert.equal(p.dpRankInt, 10); assert.ok(p.dpRadar);
});
test('로그인 전 0 레이더는 unread이며 이전 문자열을 보존한다', async () => {
  const h = profile(); await h.start(); await h.read(); h.data.radar = Array(12).fill(0); h.data.dan = [-1, -1]; const p = await h.read();
  assert.equal(p.spRankReadState, 'unread'); assert.equal(p.dpRankReadState, 'unread'); assert.equal(p.spRank, '二級'); assert.equal(p.dpRank, '一級');
});
test('권위 실패와 부분 실패는 이전 값을 보존한다', async () => {
  for (const failure of [{ id: 'bad-id' }, { radar: null }, { radar: [1] }, { dan: new Error('dan') }, { dan: [5] }]) {
    const h = profile(); await h.start(); await h.read(); Object.assign(h.data, failure); const p = await h.read();
    assert.equal(p.spRankReadState, 'unread'); assert.equal(p.dpRankReadState, 'unread'); assert.equal(p.spRank, '二級'); assert.equal(p.dpRank, '一級');
  }
  const h = profile(); await h.start(); await h.read(); h.data.dan = [16, 99]; const p = await h.read();
  assert.equal(p.spRankReadState, 'value'); assert.equal(p.spRank, '十段'); assert.equal(p.dpRankReadState, 'unread'); assert.equal(p.dpRank, '一級');
  const blockedRadar = profile({ remote: { radar: null } }); await blockedRadar.start(); const q = await blockedRadar.read();
  assert.equal(q.spRankReadState, 'unread'); assert.equal(q.dpRankReadState, 'unread'); assert.equal(blockedRadar.calls.some(c => c[0] === 'ints' && c[1] === 'radar'), false);
});
test('legacy 충돌에서 숫자 성공 우선, unread는 문자열 보강', async () => {
  const storage = JSON.stringify({ mode: 'direct', offset: '99', encoding: 'ascii' });
  const h = profile({ storage, dan: [-1, 16] }); await h.start(); let p = await h.read();
  assert.equal(p.spRankReadState, 'none'); assert.equal(p.spRank, null); assert.equal(p.dpRank, '十段'); assert.equal(p.dpRankInt, 10);
  h.data.dan = new Error('dan'); p = await h.read();
  assert.equal(p.spRankReadState, 'unread'); assert.equal(p.spRank, 'legacy'); assert.equal(p.dpRank, 'legacy'); assert.equal(p.dpRankInt, null);
});
test('pending과 blocked 판독 없음, 정책 재조회 및 constants-only 슬롯 차단', async () => {
  const b = profile({ policy: 'blocked' }); await b.start(); await b.read(); assert.equal(b.calls.some(c => ['string', 'anchor', 'ints', 'storage'].includes(c[0])), false);
  const c = profile({ policy: 'constants-only', storage: JSON.stringify({ mode: 'direct', offset: '99', encoding: 'ascii' }) }); await c.start(); await c.read(); assert.equal(c.calls.some(c => c[0] === 'storage'), false); assert.ok(c.calls.some(c => c[0] === 'string'));
  let release; const pending = new Promise(resolve => { release = resolve; });
  const r = profile({ getProfile: async n => { if (n === 1) throw Error('offline'); if (n === 2) return pending; return { profilePolicy: 'normal', profile: null }; } });
  await r.start(); assert.equal(r.fetchCount(), 2); assert.equal(r.calls.some(c => ['string', 'anchor', 'ints', 'storage'].includes(c[0])), false);
  release(null); await flush(); await r.next(); assert.equal(r.fetchCount(), 3); assert.equal(r.calls.some(c => c[0] === 'string'), false); await r.read(); assert.ok(r.calls.some(c => c[0] === 'string'));
});
test('세션 변경 중 결과 폐기와 poll 간 ID 레이더 격리', async () => {
  const h = profile(); await h.start(); const before = h.calls.filter(c => c[0] === 'set').length;
  h.data.onRead = key => { if (key === 'dan') h.data.session = { pid: 123, generation: 2 }; };
  await h.next(); assert.equal(h.calls.filter(c => c[0] === 'set').length, before); assert.ok(h.timers.length);
  h.data.onRead = null; await h.next(); h.data.id = 'bad-id'; h.data.radar = goodRadar; let p = await h.read(); assert.equal(p.spRankReadState, 'unread');
  h.data.id = 'A123456789012'; h.data.radar = null; p = await h.read(); assert.equal(p.spRankReadState, 'unread'); assert.equal(p.dpRankReadState, 'unread');
});
