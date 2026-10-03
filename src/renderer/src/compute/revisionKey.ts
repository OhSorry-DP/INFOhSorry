import type { AccountScope } from '../../../shared/account';
import { CACHE_SCHEMA_VERSION, isAccountScope, isInputStamp, isJobKind } from './protocol';
import type { InputStamp, JobKind } from './protocol';

const UNDEFINED_MARKER = ['__compute_undefined__'] as const;

/**
 * Canonical JSON serializer for options. Undefined has an explicit array marker,
 * so it remains distinct from null. -0 is normalized to 0 (JSON number semantics).
 */
export function makeOptionsKey(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

/** Content identity only: requestId and workerGeneration intentionally do not participate. */
export function makeJobKey(kind: JobKind, stamp: InputStamp): string {
  if (!isJobKind(kind)) throw new TypeError('Invalid job kind');
  if (!isInputStamp(stamp)) throw new TypeError('Invalid input stamp');
  return JSON.stringify([
    CACHE_SCHEMA_VERSION,
    kind,
    stamp.scope.iidxId,
    stamp.scope.epoch,
    stamp.rowsRevision,
    stamp.chartsRevision,
    stamp.modelRevision,
    stamp.dataRevision,
    stamp.optionsKey,
  ]);
}

export function scopesEqual(left: AccountScope, right: AccountScope): boolean {
  return isAccountScope(left) && isAccountScope(right)
    && left.iidxId === right.iidxId && left.epoch === right.epoch;
}

export function stampsEqual(left: InputStamp, right: InputStamp): boolean {
  return isInputStamp(left) && isInputStamp(right)
    && scopesEqual(left.scope, right.scope)
    && left.rowsRevision === right.rowsRevision
    && left.chartsRevision === right.chartsRevision
    && left.modelRevision === right.modelRevision
    && left.dataRevision === right.dataRevision
    && left.optionsKey === right.optionsKey;
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === undefined) return UNDEFINED_MARKER;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Options cannot contain NaN or Infinity');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError(`Unsupported options value: ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError('Options cannot contain cycles');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Options must contain only plain objects and arrays');
    }
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalize(record[key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
