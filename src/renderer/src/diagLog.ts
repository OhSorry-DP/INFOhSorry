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
  // 디스크 영속화 — fire-and-forget, 실패해도 화면 동작에 영향 주면 안 된다.
  //   PC2(브라우저 원격)에선 window.infohsorry.diag.append 가 no-op (src/renderer/src/api.ts 참고).
  try {
    window.infohsorry?.diag?.append(line);
  } catch {
    // 로그 실패가 본 기능을 막으면 안 됨 — 삼킴
  }
}

export function getDiagLines(): string[] {
  return [...diagLines];
}

export function subscribeDiagLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
