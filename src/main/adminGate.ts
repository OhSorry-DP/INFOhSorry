export type ElevationStatus = 'elevated' | 'not-elevated' | 'unknown';

// Only a confirmed non-elevated token blocks startup. Native loading and API
// errors must never prevent the application from opening.
export async function passAdminGate(deps: {
  isPackaged: boolean;
  probe: () => ElevationStatus | Promise<ElevationStatus>;
  notify: () => void;
  quit: () => void;
}): Promise<boolean> {
  if (!deps.isPackaged) return true;
  let status: ElevationStatus;
  try {
    status = await deps.probe();
  } catch {
    status = 'unknown';
  }
  if (status !== 'not-elevated') return true;
  try {
    deps.notify();
  } finally {
    deps.quit();
  }
  return false;
}
