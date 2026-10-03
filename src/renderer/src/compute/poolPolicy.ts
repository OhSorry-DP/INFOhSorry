export function choosePoolSize(hardwareConcurrency: unknown): number {
  const concurrency = typeof hardwareConcurrency === 'number' &&
    Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
    ? Math.floor(hardwareConcurrency)
    : 2;
  const hardware = Math.max(1, concurrency);
  return Math.max(1, Math.min(4, hardware - 1));
}
