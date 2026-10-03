/** Keep a manual/periodic intent until the latest bundle settles in this scope. */
export async function waitForBundle(read: () => 'ready' | 'pending' | 'invalid', timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = read();
    if (status !== 'pending') return status === 'ready';
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
