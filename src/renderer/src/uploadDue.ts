// 자동 업로드 주기 판정 — 타이머 대신 「마지막 업로드 시각 vs 현재 시각」 비교.
//   기록 없음(0)이면 바로 올린다. 시스템 시계가 뒤로 갔으면(now < lastAt) 영원히 막히지 않게 바로 올린다.
export function isUploadDue(lastAt: number, now: number, intervalMs: number): boolean {
  if (!Number.isFinite(lastAt) || lastAt <= 0) return true;
  if (now < lastAt) return true;
  return now - lastAt >= intervalMs;
}
