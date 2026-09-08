export interface AccountMeta { iidxId: string; djName: string | null; lastUpdatedAt: number; }
export interface TsvChangedEvent { tsvPath: string; mtime: number; size: number; generation: number; pid: number | null; }
export interface AccountSnapshotRequest { iidxId: string; djName: string | null; expect: { generation: number; pid: number | null; mtime: number; size: number }; }
export interface AccountSnapshotResult { ok: boolean; iidxId?: string; tsvMtime?: number; generation?: number; reason?: 'id-format'|'no-live-session'|'generation-changed'|'pid-mismatch'|'source-empty'|'source-changed'|'write-failed'; }
