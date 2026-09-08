import { EventEmitter } from 'events';
import type { InfinitasSessionState } from '../shared/session';
import { findProcessId } from './memory';

export class InfinitasSessionMonitor extends EventEmitter {
  private prevPid = 0;
  private generation = 0;
  private startedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
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
    const newPid = findProcessId('bm2dx.exe');
    const prev = this.prevPid;
    if (prev === newPid) return;
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
