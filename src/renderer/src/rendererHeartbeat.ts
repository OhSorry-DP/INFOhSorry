import { exceedsThreshold } from '../../shared/lagDiag';
import { flushStallContext, perfEvent, recordLongTask } from './perfDiag';

type LongTaskAttribution = { containerType?: string; containerName?: string; containerSrc?: string };
type LongTaskEntry = { startTime: number; duration: number; name: string; attribution?: LongTaskAttribution[] };
type LongTaskObserver = { observe(options: { type: string; buffered?: boolean }): void; disconnect(): void };
type LongTaskObserverConstructor = (new (callback: (list: { getEntries(): LongTaskEntry[] }) => void) => LongTaskObserver) & { supportedEntryTypes?: readonly string[] };
type ObserverWindow = Window & { PerformanceObserver?: LongTaskObserverConstructor };

// VM 테스트 harness 에는 window 가 없을 수 있다 — 있으면 window, 없으면 globalThis.
const hostWindow = (): Window => (typeof window !== 'undefined' ? window : globalThis as unknown) as Window;

function sanitizeSource(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'unknown';
  try {
    const url = new URL(value, hostWindow().location?.href);
    if (url.origin !== hostWindow().location?.origin) return 'unknown';
    return encodeURIComponent(`${url.origin}${url.pathname}`).slice(0, 160);
  } catch { return 'unknown'; }
}

export function startRendererHeartbeat(): () => void {
  let previous: number | null = null;
  let frame = 0;
  let disposed = false;
  let observer: LongTaskObserver | null = null;
  let lastLongTaskDiagAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  let stallSeq = 0;
  const reset = (): void => { previous = null; };
  const observerWindow = hostWindow() as ObserverWindow;
  const supported = observerWindow.PerformanceObserver?.supportedEntryTypes;
  if (supported?.includes('longtask') && observerWindow.PerformanceObserver) {
    try {
      observer = new observerWindow.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const attribution = (entry.attribution ?? []).slice(0, 8).map((item) => ({
            containerType: typeof item.containerType === 'string' ? item.containerType.slice(0, 40) : 'unknown',
            containerName: typeof item.containerName === 'string' ? item.containerName.slice(0, 80) : 'unknown',
            containerSrc: sanitizeSource(item.containerSrc),
          }));
          const startMonoMs = Number(entry.startTime);
          const durMs = Number(entry.duration);
          const name = typeof entry.name === 'string' ? entry.name.slice(0, 40) : 'unknown';
          recordLongTask({ kind: 'longtask', startMonoMs, endMonoMs: startMonoMs + durMs, durMs, name, attribution });
          const recordedAt = performance.now();
          if (durMs >= 100) {
            if (recordedAt - lastLongTaskDiagAt >= 1000) {
              const source = attribution[0]?.containerSrc ?? 'unknown';
              perfEvent('renderer-longtask', { startMonoMs: startMonoMs.toFixed(3), durMs: durMs.toFixed(3), name, source, suppressed });
              lastLongTaskDiagAt = recordedAt;
              suppressed = 0;
            } else suppressed += 1;
          }
        }
      });
      observer.observe({ type: 'longtask' });
    } catch {
      observer?.disconnect();
      observer = null;
      perfEvent('renderer-longtask-unavailable', { reason: 'observe-failed' });
    }
  }
  const tick = (): void => {
    if (disposed) return;
    const now = performance.now();
    if (document.visibilityState === 'visible') {
      if (previous !== null && exceedsThreshold(now - previous)) {
        const startMonoMs = previous;
        const stallId = `stall${++stallSeq}`;
        perfEvent('renderer-stall', { gapMs: (now - previous).toFixed(3), startMonoMs: startMonoMs.toFixed(3), endMonoMs: now.toFixed(3), stallId });
        flushStallContext(now - 1000, now, stallId);
      }
      previous = now;
    } else reset();
    frame = requestAnimationFrame(tick);
  };
  document.addEventListener('visibilitychange', reset);
  frame = requestAnimationFrame(tick);
  return () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', reset);
    observer?.disconnect();
    observer = null;
  };
}
