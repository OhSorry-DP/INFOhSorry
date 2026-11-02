import type { RecInputChart } from './recommend';
import type { SongChart, StarResult } from './types';

/** [FAST GREAT, FAST GOOD, SLOW GREAT, SLOW GOOD] */
export type FsCounts = [number, number, number, number];

export interface SideDetail {
  /** 등급별 FAST/SLOW. 플레이 시작부터 못 봤으면 null */
  fs: { fast_great: number; fast_good: number; slow_great: number; slow_good: number } | null;
  /** 짝지을 수 없어 위 값에서 빠진 GREAT/GOOD 노트 수 */
  fs_unresolved: number;
  /** 확정값 + 미확정이 최종 FAST+SLOW 합계와 같고, 확정 FAST·SLOW 가 각각 합계를 넘지 않는가 */
  fs_ok: boolean;
  /** 레인별 [PGREAT, GREAT, GOOD, BAD, POOR, 공POOR] 최종값 */
  lanes: number[][];
  /** 레인 합이 judge_16 판정 합계와 같은가 (POOR 는 공POOR 포함) */
  lanes_ok: boolean;
  /** 레인별 [FAST GREAT, FAST GOOD, SLOW GREAT, SLOW GOOD]. 못 봤으면 null */
  lane_fs: FsCounts[] | null;
  lane_fs_unresolved: number;
}

export interface PlayDetail {
  v: 1;
  timestamp: string;
  /** 플레이 시작(카운터 0 리셋)부터 관찰했는가 */
  complete: boolean;
  samples: number;
  /** 평균 샘플 간격(ms). 클수록 짝짓기 모호성이 늘어난다 */
  dt_ms: number;
  p1: SideDetail;
  p2: SideDetail;
}

export const SNAPSHOT_VERSION = 1;

export type SnapshotReason = 'periodic' | 'game-exit' | 'id-switch' | 'app-close' | 'manual';

// main project도 이 shared 파일을 컴파일하므로 renderer TSX를 type import하지 않는다.
// useProfile.ProfileInfo와 같은 필드를 가진 구조적 타입이다.
export interface SnapshotRadarValues {
  notes: number | null;
  chord: number | null;
  peak: number | null;
  charge: number | null;
  scratch: number | null;
  soft: number | null;
}

export interface SnapshotProfileInfo {
  djName: string | null;
  iidxId: string | null;
  iidxIdFormatted: string | null;
  spRank: string | null;
  dpRank: string | null;
  spRankInt: number | null;
  dpRankInt: number | null;
  spRadar: SnapshotRadarValues | null;
  dpRadar: SnapshotRadarValues | null;
}

// UploadInput의 값 경계를 디스크에 보존한다. type import만 사용하므로 main runtime에는 renderer 의존성이 없다.
export interface UploadSnapshot {
  plays?: PlayCsvRow[] | null;
  v: number;
  capturedAt: number;
  reason: SnapshotReason;
  iidxId: string;
  djName: string;
  sourceIidxId: string;
  tsvMtime: number;
  appVersion: string;
  profile: SnapshotProfileInfo;
  starResult: StarResult | null;
  rStar: number | null;
  charts: RecInputChart[];
  unclassifiedCharts: Omit<RecInputChart, 'level'>[];
  spCpi: number | null;
  spStar: number | null;
  spCharts: SongChart[];
  dpAllCharts: SongChart[];
  allTsvCharts: SongChart[];
}

export type UploadOutcome =
  | { kind: 'success'; durationMs: number }
  | { kind: 'pending-clear-failed'; error: string; durationMs: number }
  | { kind: 'http-failure'; error: string; durationMs: number }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'skip-no-dirty' }
  | { kind: 'skip-no-snapshot'; reason: string };

export const PLAY_CSV_LEGACY_KEYS = ["timestamp", "song_id", "title", "difficulty", "notes", "ex_score", "pgreat", "great", "miss_count", "clear_lamp", "dj_rate_pct", "dj_rank", "judge_16", "settings_p1_11", "settings_p2_11", "battle_flag", "gauge_p1_w77", "gauge_p2_w78", "source"] as const;
export const PLAY_CSV_KEYS = [...PLAY_CSV_LEGACY_KEYS, "app_version", "game_version"] as const;
export const PLAY_CSV_SPEED_KEYS = [...PLAY_CSV_KEYS, 'play_speed'] as const;
export type PlayCsvRow = Record<(typeof PLAY_CSV_KEYS)[number], string> & { play_speed?: string } & { detail?: PlayDetail };

export const PLAY_ERROR_CODES = {
  id: -1, skipped: -2, memory: -3, write: -4, marker: -5, offsets: -6,
  requiredKey: -7, csvMissing: -8, header: -9, row0: -10, read: -11,
} as const;

export type PlayCsvReadResult = { ok: boolean; csv?: string; error?: string; found?: boolean; appVersion?: string; gameVersion?: string } & { details?: PlayDetail[] };
export type PlayErrorCode = (typeof PLAY_ERROR_CODES)[keyof typeof PLAY_ERROR_CODES];

export function buildPlayErrorRow(code: number, versions: { appVersion: string; gameVersion: string }, timestamp: string): PlayCsvRow {
  if (!Number.isInteger(code) || code >= 0) throw new RangeError('Play error code must be a negative integer');
  const row = Object.fromEntries(PLAY_CSV_KEYS.map((key) => [key, ''])) as Record<(typeof PLAY_CSV_KEYS)[number], string> & { play_speed?: string };
  row.timestamp = timestamp;
  for (const key of PLAY_CSV_KEYS.slice(1, 19)) row[key] = String(code);
  row.app_version = versions.appVersion;
  row.game_version = versions.gameVersion;
  return row;
}

export function isPlayErrorRow(row: PlayCsvRow): boolean {
  const values = PLAY_CSV_KEYS.slice(1, 19).map((key) => row[key]);
  return /^-\d+$/.test(values[0]) && values.every((value) => value === values[0]);
}
