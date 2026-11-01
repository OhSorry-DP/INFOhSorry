// 플레이 상세 기록 (메모리 I/O 없음 — 테스트 가능). 문서: docs/play-logger.md 「12. 플레이 상세」
// 게임 메모리에는 FAST/SLOW 합계(judgeData 12..15)와 레인별 판정 카운터만 있고,
// 「GREAT 중 FAST」 같은 등급별 FAST/SLOW 는 따로 저장되지 않는다.
// 그래서 플레이 중 짧은 간격으로 읽어, 같은 샘플에서 함께 오른 증가분을 짝지어 복원한다.

import type { FsCounts, PlayDetail, SideDetail } from '../shared/uploadSnapshot';
export type { FsCounts, PlayDetail, SideDetail } from '../shared/uploadSnapshot';

export const PLAY_DETAIL_LAYOUT = {
  // judgeData 기준 int32 word 위치 (2026101400 빌드 실측). 레인 8개 x 6칸
  laneWordsP1: 3448349,
  laneWordsP2: 3452263,
  lanes: 8,
  laneStride: 6,   // [PGREAT, GREAT, GOOD, BAD, POOR, 공POOR]
} as const;

export const LANE_BLOCK_WORDS = PLAY_DETAIL_LAYOUT.lanes * PLAY_DETAIL_LAYOUT.laneStride;

export interface DetailSample {
  /** judgeData 0..15 (docs/play-logger.md 의 judge_16 순서) */
  judge: number[];
  p1Lanes: number[];
  p2Lanes: number[];
  /** 읽은 시각(ms). 샘플 간격 통계용 */
  at: number;
}

interface Carry {
  gr: number; gd: number; f: number; s: number;
  laneGr: number[]; laneGd: number[];
  age: number;
}

const MAX_CARRY = 3;
const newCarry = (): Carry => ({
  gr: 0, gd: 0, f: 0, s: 0,
  laneGr: new Array(PLAY_DETAIL_LAYOUT.lanes).fill(0),
  laneGd: new Array(PLAY_DETAIL_LAYOUT.lanes).fill(0),
  age: 0,
});

interface SideAcc {
  carry: Carry;
  fs: FsCounts;
  unresolved: number;
  laneFs: FsCounts[];
  laneUnresolved: number;
}

const newAcc = (): SideAcc => ({
  carry: newCarry(),
  fs: [0, 0, 0, 0],
  unresolved: 0,
  laneFs: Array.from({ length: PLAY_DETAIL_LAYOUT.lanes }, () => [0, 0, 0, 0] as FsCounts),
  laneUnresolved: 0,
});

const judgeTotal = (j: number[], side: 0 | 1): number => {
  const o = side * 5;
  return j[o] + j[o + 1] + j[o + 2] + j[o + 3] + j[o + 4];
};
const laneTotal = (lanes: number[]): number => lanes.reduce((a, b) => a + b, 0);

export class PlayDetailTracker {
  private prev: DetailSample | null = null;
  private acc: [SideAcc, SideAcc] = [newAcc(), newAcc()];
  private started = false;
  private samples = 0;
  private firstAt = 0;
  private lastAt = 0;

  feed(s: DetailSample): void {
    const prev = this.prev;
    this.prev = s;
    if (this.samples === 0) this.firstAt = s.at;
    this.lastAt = s.at;
    this.samples++;
    if (!prev) {
      // 첫 샘플이 이미 0 이면 처음부터 본 것. 아니면 리셋(새 판 시작)을 기다린다.
      this.started = judgeTotal(s.judge, 0) + judgeTotal(s.judge, 1) === 0;
      return;
    }
    const reset = judgeTotal(s.judge, 0) < judgeTotal(prev.judge, 0)
      || judgeTotal(s.judge, 1) < judgeTotal(prev.judge, 1)
      || laneTotal(s.p1Lanes) < laneTotal(prev.p1Lanes)
      || laneTotal(s.p2Lanes) < laneTotal(prev.p2Lanes);
    if (reset) {
      this.acc = [newAcc(), newAcc()];
      this.started = true;
      this.samples = 1;
      this.firstAt = s.at;
      return;
    }
    if (!this.started) return;
    this.pair(0, prev, s);
    this.pair(1, prev, s);
  }

  // 판정·FAST/SLOW·레인 word 는 한 번에 갱신되지 않는다. 한 샘플에서 균형이 안 맞으면 다음 샘플로 이월하고,
  // 맞으면 그때 짝짓는다. MAX_CARRY 샘플이 지나도 안 맞으면 미확정으로 버린다.
  private pair(side: 0 | 1, prev: DetailSample, cur: DetailSample): void {
    const acc = this.acc[side];
    const c = acc.carry;
    const o = side * 5;
    c.gr += cur.judge[o + 1] - prev.judge[o + 1];
    c.gd += cur.judge[o + 2] - prev.judge[o + 2];
    c.f += cur.judge[12 + side] - prev.judge[12 + side];
    c.s += cur.judge[14 + side] - prev.judge[14 + side];
    const lanes = side === 0 ? [prev.p1Lanes, cur.p1Lanes] : [prev.p2Lanes, cur.p2Lanes];
    const st = PLAY_DETAIL_LAYOUT.laneStride;
    for (let k = 0; k < PLAY_DETAIL_LAYOUT.lanes; k++) {
      c.laneGr[k] += lanes[1][k * st + 1] - lanes[0][k * st + 1];
      c.laneGd[k] += lanes[1][k * st + 2] - lanes[0][k * st + 2];
    }
    const events = c.gr + c.gd;
    if (events === 0 && c.f === 0 && c.s === 0) { c.age = 0; return; }
    if (c.gr >= 0 && c.gd >= 0 && c.f >= 0 && c.s >= 0 && events === c.f + c.s) { this.resolve(acc); return; }
    if (++c.age > MAX_CARRY) this.drop(acc);
  }

  private resolve(acc: SideAcc): void {
    const c = acc.carry;
    const events = c.gr + c.gd;
    // 등급별
    if (c.s === 0) { acc.fs[0] += c.gr; acc.fs[1] += c.gd; }
    else if (c.f === 0) { acc.fs[2] += c.gr; acc.fs[3] += c.gd; }
    else if (c.gr === 0) { acc.fs[1] += c.f; acc.fs[3] += c.s; }
    else if (c.gd === 0) { acc.fs[0] += c.f; acc.fs[2] += c.s; }
    else acc.unresolved += events;
    // 레인별: 방향이 하나뿐이고 레인 합이 전체와 같을 때만. FAST·SLOW 가 섞이면 어느 레인이 어느 쪽인지 알 수 없다.
    const sumGr = c.laneGr.reduce((a, b) => a + b, 0);
    const sumGd = c.laneGd.reduce((a, b) => a + b, 0);
    if (sumGr !== c.gr || sumGd !== c.gd || c.laneGr.some(n => n < 0) || c.laneGd.some(n => n < 0) || (c.f > 0 && c.s > 0)) acc.laneUnresolved += events;
    else for (let k = 0; k < PLAY_DETAIL_LAYOUT.lanes; k++) {
      const base = c.s === 0 ? 0 : 2;
      acc.laneFs[k][base] += c.laneGr[k];
      acc.laneFs[k][base + 1] += c.laneGd[k];
    }
    acc.carry = newCarry();
  }

  private drop(acc: SideAcc): void {
    const c = acc.carry;
    const n = Math.max(c.gr + c.gd, c.f + c.s, 0);
    acc.unresolved += n;
    acc.laneUnresolved += n;
    acc.carry = newCarry();
  }

  /** 마지막 샘플(결과 화면 값)을 반영하고 상세 기록을 만든다. */
  finish(final: DetailSample, timestamp: string): PlayDetail {
    // 샘플 간격은 최종 샘플(결과 화면에서 한참 뒤에 읽음)을 넣기 전의 값으로 계산한다.
    const samplesBefore = this.samples;
    const dt = samplesBefore > 1 ? (this.lastAt - this.firstAt) / (samplesBefore - 1) : 0;
    this.feed(final);
    if (this.started) for (const a of this.acc) { const c = a.carry; if (c.gr + c.gd + c.f + c.s !== 0) this.drop(a); }
    const complete = this.started;
    const side = (i: 0 | 1): SideDetail => {
      const acc = this.acc[i];
      const lanes = Array.from({ length: PLAY_DETAIL_LAYOUT.lanes }, (_, k) =>
        (i === 0 ? final.p1Lanes : final.p2Lanes).slice(k * PLAY_DETAIL_LAYOUT.laneStride, (k + 1) * PLAY_DETAIL_LAYOUT.laneStride));
      const sum = (c: number) => lanes.reduce((a, l) => a + l[c], 0);
      const j = final.judge;
      const o = i * 5;
      const lanes_ok = sum(0) === j[o] && sum(1) === j[o + 1] && sum(2) === j[o + 2] && sum(3) === j[o + 3] && sum(4) + sum(5) === j[o + 4];
      const fastTotal = j[12 + i];
      const slowTotal = j[14 + i];
      const fs_ok = complete && acc.fs[0] + acc.fs[1] <= fastTotal && acc.fs[2] + acc.fs[3] <= slowTotal
        && acc.fs[0] + acc.fs[1] + acc.fs[2] + acc.fs[3] + acc.unresolved === fastTotal + slowTotal;
      return {
        fs: complete ? { fast_great: acc.fs[0], fast_good: acc.fs[1], slow_great: acc.fs[2], slow_good: acc.fs[3] } : null,
        fs_unresolved: complete ? acc.unresolved : 0,
        fs_ok,
        lanes,
        lanes_ok,
        lane_fs: complete ? acc.laneFs.map(r => [...r] as FsCounts) : null,
        lane_fs_unresolved: complete ? acc.laneUnresolved : 0,
      };
    };
    return { v: 1, timestamp, complete, samples: this.samples, dt_ms: Math.round(dt * 10) / 10, p1: side(0), p2: side(1) };
  }
}
