import type { RecInputChart } from './recommend';
import type { SongChart, StarResult } from './types';

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
