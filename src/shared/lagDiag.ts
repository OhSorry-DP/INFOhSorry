export const LAG_THRESHOLD_MS = 200;
export const MAIN_HEARTBEAT_MS = 500;

// Strictly greater than the threshold; invalid clock samples never emit logs.
export function exceedsThreshold(durationMs: number, thresholdMs = LAG_THRESHOLD_MS): boolean {
  return Number.isFinite(durationMs) && durationMs > thresholdMs;
}

export function timerLagMs(previousMs: number, nowMs: number, intervalMs: number): number {
  return Math.max(0, nowMs - previousMs - intervalMs);
}

const GPU_FEATURES = ['gpu_compositing', 'rasterization', 'opengl', 'webgl', 'webgl2', 'video_decode'] as const;

export function gpuStatusSummary(status: Partial<Record<typeof GPU_FEATURES[number], string>>): string {
  return GPU_FEATURES
    .map(key => `${key}=${status[key] ?? 'unknown'}`).join(' ');
}
