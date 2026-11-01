import test from 'node:test';
import assert from 'node:assert/strict';
import { LANE_BLOCK_WORDS, PlayDetailTracker } from './playDetail.ts';

const zero = () => ({ judge: new Array(16).fill(0), p1Lanes: new Array(LANE_BLOCK_WORDS).fill(0), p2Lanes: new Array(LANE_BLOCK_WORDS).fill(0), at: 0 });
const clone = (s) => ({ judge: [...s.judge], p1Lanes: [...s.p1Lanes], p2Lanes: [...s.p2Lanes], at: s.at });
// side 0/1, lane, grade: 0 PG 1 GR 2 GD 3 BD 4 POOR, dir: 'F' | 'S' | null(FAST/SLOW 없음)
function hit(s, side, lane, grade, dir) {
  const n = clone(s);
  n.at = s.at + 5;
  n.judge[side * 5 + grade] += 1;
  (side === 0 ? n.p1Lanes : n.p2Lanes)[lane * 6 + grade] += 1;
  if (dir === 'F') n.judge[12 + side] += 1;
  if (dir === 'S') n.judge[14 + side] += 1;
  return n;
}

test('한 노트씩 짝지으면 등급별·레인별 FAST/SLOW 가 정확히 복원된다', () => {
  const t = new PlayDetailTracker();
  let s = zero();
  t.feed(s);
  const seq = [[0, 0, 1, 'F'], [0, 0, 1, 'S'], [0, 3, 2, 'F'], [0, 3, 2, 'S'], [0, 3, 2, 'S'], [0, 1, 0, null], [1, 7, 1, 'S']];
  for (const [side, lane, grade, dir] of seq) { s = hit(s, side, lane, grade, dir); t.feed(s); }
  const d = t.finish(s, '2026-11-01T00:00:00.000Z');
  assert.equal(d.complete, true);
  assert.deepEqual(d.p1.fs, { fast_great: 1, fast_good: 1, slow_great: 1, slow_good: 2 });
  assert.equal(d.p1.fs_ok, true);
  assert.equal(d.p1.fs_unresolved, 0);
  assert.deepEqual(d.p1.lane_fs[0], [1, 0, 1, 0]);
  assert.deepEqual(d.p1.lane_fs[3], [0, 1, 0, 2]);
  assert.deepEqual(d.p2.fs, { fast_great: 0, fast_good: 0, slow_great: 1, slow_good: 0 });
  assert.deepEqual(d.p2.lane_fs[7], [0, 0, 1, 0]);
  assert.equal(d.p1.lanes_ok, true);
  assert.equal(d.p2.lanes_ok, true);
});

test('한 샘플에 여러 노트가 같이 올라도 방향이나 등급이 하나면 확정한다', () => {
  const t = new PlayDetailTracker();
  const s0 = zero();
  t.feed(s0);
  // GREAT 1 + GOOD 1 이 모두 FAST: 등급별·레인별 모두 확정
  let s = clone(s0); s.at = 5;
  s.judge[1] += 1; s.judge[2] += 1; s.judge[12] += 2;
  s.p1Lanes[0 * 6 + 1] += 1; s.p1Lanes[4 * 6 + 2] += 1;
  t.feed(s);
  // GREAT 2 개, FAST 1 + SLOW 1: 등급별은 확정, 레인별은 모호(레인 2개)
  let u = clone(s); u.at = 10;
  u.judge[1] += 2; u.judge[12] += 1; u.judge[14] += 1;
  u.p1Lanes[1 * 6 + 1] += 1; u.p1Lanes[2 * 6 + 1] += 1;
  t.feed(u);
  const d = t.finish(u, 'x');
  assert.deepEqual(d.p1.fs, { fast_great: 2, fast_good: 1, slow_great: 1, slow_good: 0 });
  assert.equal(d.p1.fs_unresolved, 0);
  assert.equal(d.p1.fs_ok, true);
  assert.deepEqual(d.p1.lane_fs[0], [1, 0, 0, 0]);
  assert.deepEqual(d.p1.lane_fs[4], [0, 1, 0, 0]);
  assert.equal(d.p1.lane_fs_unresolved, 2);
});

test('GREAT·GOOD·FAST·SLOW 가 한 샘플에 전부 섞이면 미확정으로 센다', () => {
  const t = new PlayDetailTracker();
  const s0 = zero();
  t.feed(s0);
  const s = clone(s0); s.at = 5;
  s.judge[1] += 1; s.judge[2] += 1; s.judge[12] += 1; s.judge[14] += 1;
  s.p1Lanes[1] += 1; s.p1Lanes[2 * 6 + 2] += 1;
  t.feed(s);
  const d = t.finish(s, 'x');
  assert.equal(d.p1.fs_unresolved, 2);
  assert.equal(d.p1.fs_ok, true); // 확정 0 + 미확정 2 = FAST 1 + SLOW 1
});

test('BAD·POOR 는 FAST/SLOW 에 영향을 주지 않고 공POOR 는 POOR 합계에 포함된다', () => {
  const t = new PlayDetailTracker();
  let s = zero();
  t.feed(s);
  s = hit(s, 0, 2, 3, null); t.feed(s);
  s = hit(s, 0, 2, 4, null); t.feed(s);
  // 공POOR: 레인 6번째 칸과 judge POOR 가 같이 오른다
  const a = clone(s); a.at += 5; a.judge[4] += 1; a.p1Lanes[2 * 6 + 5] += 1; t.feed(a);
  const d = t.finish(a, 'x');
  assert.equal(d.p1.lanes_ok, true);
  assert.equal(d.p1.fs_ok, true);
  assert.deepEqual(d.p1.lanes[2], [0, 0, 0, 1, 1, 1]);
});

test('플레이 중간에 붙으면 리셋을 볼 때까지 complete=false, 리셋 뒤부터 누적한다', () => {
  const t = new PlayDetailTracker();
  let s = zero();
  s.judge[1] = 5; s.judge[12] = 3; s.judge[14] = 2; s.p1Lanes[1] = 5; // 이미 진행 중이거나 지난 판 값
  t.feed(s);
  let mid = t.finish(clone(s), 'x');
  assert.equal(mid.complete, false);
  assert.equal(mid.p1.fs, null);
  assert.equal(mid.p1.lane_fs, null);

  const t2 = new PlayDetailTracker();
  t2.feed(s);
  s = zero(); s.at = 5; t2.feed(s);           // 새 판 시작: 0 으로 리셋
  s = hit(s, 0, 0, 2, 'S'); t2.feed(s);
  const d = t2.finish(s, 'x');
  assert.equal(d.complete, true);
  assert.deepEqual(d.p1.fs, { fast_great: 0, fast_good: 0, slow_great: 0, slow_good: 1 });
  assert.equal(d.p1.fs_ok, true);
});

test('레인 합이 판정 합계와 다르면 lanes_ok=false (주소가 어긋난 빌드를 걸러낸다)', () => {
  const t = new PlayDetailTracker();
  let s = zero();
  t.feed(s);
  s = hit(s, 0, 0, 1, 'F'); t.feed(s);
  s.p1Lanes[0 * 6 + 1] += 1; // 레인에만 하나 더
  const d = t.finish(s, 'x');
  assert.equal(d.p1.lanes_ok, false);
});

test('샘플 간격 통계', () => {
  const t = new PlayDetailTracker();
  let s = zero();
  t.feed(s);
  for (let i = 0; i < 9; i++) { s = hit(s, 0, 0, 0, null); t.feed(s); }
  const last = clone(s); last.at += 5;
  const d = t.finish(last, 'x');
  assert.equal(d.dt_ms, 5);
  assert.equal(d.timestamp, 'x');
});

test('FAST 가 먼저 오르고 GREAT 가 다음 샘플에 오르는 찢어진 읽기도 한 노트로 짝짓는다', () => {
  const t = new PlayDetailTracker();
  const s0 = zero();
  t.feed(s0);
  const a = clone(s0); a.at = 5; a.judge[12] += 1; t.feed(a);                         // FAST 만
  const b = clone(a); b.at = 10; b.judge[1] += 1; b.p1Lanes[2 * 6 + 1] += 1; t.feed(b); // 다음 샘플에 GREAT·레인
  const last = clone(b); last.at = 15;
  const d = t.finish(last, 'x');
  assert.deepEqual(d.p1.fs, { fast_great: 1, fast_good: 0, slow_great: 0, slow_good: 0 });
  assert.equal(d.p1.fs_unresolved, 0);
  assert.equal(d.p1.fs_ok, true);
  assert.deepEqual(d.p1.lane_fs[2], [1, 0, 0, 0]);
});

test('균형이 끝내 안 맞으면 미확정으로 버린다', () => {
  const t = new PlayDetailTracker();
  const s0 = zero();
  t.feed(s0);
  let s = clone(s0);
  s.judge[12] += 1;
  for (let i = 1; i <= 6; i++) { s = clone(s); s.at = i * 5; t.feed(s); }
  const d = t.finish(s, 'x');
  assert.equal(d.p1.fs_unresolved, 1);
  assert.equal(d.p1.fs_ok, true);
});
