import { app } from 'electron';
import { appendDiagLine } from './diagLogStore';
import { exceedsThreshold, gpuStatusSummary, MAIN_HEARTBEAT_MS, timerLagMs } from '../shared/lagDiag';

export function startMainHeartbeat(): () => void {
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = timerLagMs(previous, now, MAIN_HEARTBEAT_MS);
    previous = now;
    if (exceedsThreshold(lag)) appendDiagLine(`PERF event=main-lag lagMs=${lag.toFixed(3)}`);
  }, MAIN_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function recordGpuStatus(event: string, reason?: string, exitCode?: number): void {
  try {
    const status = gpuStatusSummary(app.getGPUFeatureStatus());
    appendDiagLine(`GPU event=${event}${reason === undefined ? '' : ` reason=${JSON.stringify(reason)} exitCode=${exitCode}`} ${status}`);
  } catch {
    appendDiagLine(`GPU event=${event}${reason === undefined ? '' : ` reason=${JSON.stringify(reason)} exitCode=${exitCode}`} status=unavailable`);
  }
}
