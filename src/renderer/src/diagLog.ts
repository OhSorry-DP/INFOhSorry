const MAX_DIAG_LINES = 30;

const diagLines: string[] = [];
const listeners = new Set<() => void>();

export function addDiagLine(line: string): void {
  if (!line) return;
  diagLines.push(line);
  if (diagLines.length > MAX_DIAG_LINES) {
    diagLines.splice(0, diagLines.length - MAX_DIAG_LINES);
  }
  for (const listener of listeners) listener();
}

export function getDiagLines(): string[] {
  return [...diagLines];
}

export function subscribeDiagLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
