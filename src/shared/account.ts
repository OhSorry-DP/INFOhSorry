import type { SnapshotProfileInfo, SnapshotRadarValues } from './uploadSnapshot';

export interface AccountMeta {
  iidxId: string;
  djName: string | null;
  lastUpdatedAt: number;
  spRank?: string | null;
  dpRank?: string | null;
  spRankInt?: number | null;
  dpRankInt?: number | null;
  spRadar?: SnapshotRadarValues | null;
  dpRadar?: SnapshotRadarValues | null;
  profileCapturedAt?: number | null;
}

export interface TsvChangedEvent {
  tsvPath: string;
  mtime: number;
  size: number;
  generation: number;
  pid: number | null;
}

export interface AccountSnapshotRequest {
  iidxId: string;
  djName: string | null;
  profile?: SnapshotProfileInfo | null;
  expect: { generation: number; pid: number | null };
}

const profileFields = ['spRank', 'dpRank', 'spRankInt', 'dpRankInt', 'spRadar', 'dpRadar'] as const;

export function mergeAccountMeta(
  iidxId: string,
  prev: Partial<AccountMeta>,
  profile: SnapshotProfileInfo | null | undefined,
  capturedAt: number,
): AccountMeta {
  const previous = prev.iidxId !== undefined && prev.iidxId !== iidxId ? {} : prev;
  const result: AccountMeta = {
    iidxId,
    djName: previous.djName ?? null,
    lastUpdatedAt: capturedAt,
  };

  for (const field of [...profileFields, 'profileCapturedAt'] as const) {
    if (Object.prototype.hasOwnProperty.call(previous, field)) {
      const value = previous[field];
      Object.assign(result, {
        [field]: field === 'spRadar' || field === 'dpRadar'
          ? value == null ? value : { ...(value as SnapshotRadarValues) }
          : value,
      });
    }
  }

  if (profile?.iidxId === iidxId) {
    result.djName = profile.djName ?? previous.djName ?? null;
    for (const field of profileFields) {
      const value = profile[field] ?? previous[field] ?? null;
      Object.assign(result, {
        [field]: field === 'spRadar' || field === 'dpRadar'
          ? value == null ? value : { ...(value as SnapshotRadarValues) }
          : value,
      });
    }
    result.profileCapturedAt = capturedAt;
  }

  return result;
}

export interface AccountScope {
  iidxId: string | null;
  epoch: number;
}

export function isFloorSeedCurrent(request: AccountScope, current: AccountScope): boolean {
  return request.iidxId !== null
    && /^[A-Z]\d{12}$/.test(request.iidxId)
    && request.iidxId === current.iidxId
    && request.epoch === current.epoch;
}

export function resolveAccountSnapshotProfile(
  iidxId: string,
  meta: AccountMeta | null | undefined,
  fallback: SnapshotProfileInfo | null | undefined,
): SnapshotProfileInfo | null {
  if (!/^[A-Z]\d{12}$/.test(iidxId)) return null;

  const sameMeta = meta?.iidxId === iidxId ? meta : null;
  let djName: string | null;
  let values: Pick<SnapshotProfileInfo, typeof profileFields[number]>;

  if (sameMeta && typeof sameMeta.profileCapturedAt === 'number' && Number.isFinite(sameMeta.profileCapturedAt)) {
    djName = sameMeta.djName;
    values = {
      spRank: sameMeta.spRank ?? null,
      dpRank: sameMeta.dpRank ?? null,
      spRankInt: sameMeta.spRankInt ?? null,
      dpRankInt: sameMeta.dpRankInt ?? null,
      spRadar: sameMeta.spRadar == null ? null : { ...sameMeta.spRadar },
      dpRadar: sameMeta.dpRadar == null ? null : { ...sameMeta.dpRadar },
    };
  } else if (fallback?.iidxId === iidxId) {
    djName = sameMeta?.djName ?? fallback.djName;
    values = {
      spRank: fallback.spRank,
      dpRank: fallback.dpRank,
      spRankInt: fallback.spRankInt,
      dpRankInt: fallback.dpRankInt,
      spRadar: fallback.spRadar == null ? null : { ...fallback.spRadar },
      dpRadar: fallback.dpRadar == null ? null : { ...fallback.dpRadar },
    };
  } else {
    return null;
  }

  return {
    iidxId,
    iidxIdFormatted: `${iidxId[0]}-${iidxId.slice(1, 5)}-${iidxId.slice(5, 9)}-${iidxId.slice(9, 13)}`,
    djName,
    ...values,
  };
}

export interface AccountSnapshotResult {
  ok: boolean;
  iidxId?: string;
  tsvMtime?: number;
  generation?: number;
  reason?: 'id-format' | 'no-live-session' | 'generation-changed' | 'pid-mismatch' | 'source-empty' | 'source-changed' | 'write-failed';
}
