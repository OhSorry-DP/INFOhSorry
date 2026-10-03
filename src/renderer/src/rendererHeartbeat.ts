import { exceedsThreshold } from '../../shared/lagDiag';
import { perfEvent } from './perfDiag';

// Animation frames run on the same thread as React and browser rendering.
// Hidden windows suspend frames normally, so reset the baseline on visibility changes.
export function startRendererHeartbeat(): () => void {
  let previous: number | null = null;
  let frame = 0;
  const reset = (): void => { previous = null; };
  const tick = (): void => {
    const now = performance.now();
    if (document.visibilityState === 'visible') {
      if (previous !== null && exceedsThreshold(now - previous)) {
        perfEvent('renderer-stall', { gapMs: (now - previous).toFixed(3) });
      }
      previous = now;
    } else reset();
    frame = requestAnimationFrame(tick);
  };
  document.addEventListener('visibilitychange', reset);
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', reset);
  };
}
