import { EventEmitter } from 'events';
import type { InfinitasSessionState } from '../shared/session';
import { findProcessId } from './memory';
import { appendDiagLine } from './diagLogStore';
import { exceedsThreshold } from '../shared/lagDiag';

export class InfinitasSessionMonitor extends EventEmitter {
  private prevPid = 0;
  private generation = 0;
  private startedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    appendDiagLine(`SESSION event=monitor-start pid=${this.prevPid || 'null'} generation=${this.generation}`);
    this.timer = setInterval(() => this.poll(), 1000);
    this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getState(): InfinitasSessionState {
    return { pid: this.prevPid || null, generation: this.generation, startedAt: this.startedAt };
  }

  private poll(): void {
    const start = performance.now();
    let newPid: number;
    try {
      newPid = findProcessId('bm2dx.exe');
    } finally {
      const duration = performance.now() - start;
      if (exceedsThreshold(duration)) appendDiagLine(`PERF event=session-poll durMs=${duration.toFixed(3)}`);
    }
    const prev = this.prevPid;
    if (prev === newPid) return;
    appendDiagLine(`SESSION event=pid-change prevPid=${prev || 'null'} pid=${newPid || 'null'} generation=${this.generation + (newPid > 0 ? 1 : 0)}`);
    if (prev === 0 && newPid > 0) {
      this.generation++;
      this.startedAt = Date.now();
      this.prevPid = newPid;
      this.emit('state', this.getState());
      this.emit('start', { pid: newPid, generation: this.generation });
    } else if (prev > 0 && newPid === 0) {
      this.prevPid = 0;
      this.startedAt = null;
      this.emit('state', this.getState());
      this.emit('end', { prevPid: prev, generation: this.generation });
    } else if (prev > 0 && newPid > 0) {
      this.emit('end', { prevPid: prev, generation: this.generation });
      this.generation++;
      this.startedAt = Date.now();
      this.prevPid = newPid;
      this.emit('state', this.getState());
      this.emit('start', { pid: newPid, generation: this.generation });
    }
  }
}
