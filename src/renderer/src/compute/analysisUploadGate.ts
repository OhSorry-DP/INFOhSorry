import type { AccountScope } from '../../../shared/account';
import type { InputStamp } from './protocol';
import { isAccountScope, isInputStamp } from './protocol';
import type { AcceptedTask } from './acceptedBundle';
import { scopesEqual, stampsEqual } from './revisionKey';

export interface AnalysisUploadExpectation {
  targetId: string;
  remote: boolean;
  scope: AccountScope;
  inputHandle: string;
  weaknessStamp: InputStamp;
  patternStamp: InputStamp;
  intentToken: number;
}

export interface AnalysisWeaknessValue {
  vec: Record<string, number>;
  allCharts: unknown;
}

export interface AnalysisPatternValue {
  vec: Record<string, number>;
  digest: string;
}

/**
 * Pure snapshot gate. The caller must separately validate live current state (scope,
 * owner, rows, and chart revisions) immediately before sending and after awaiting.
 */
export function canUploadAnalysis(
  weakness: AcceptedTask<AnalysisWeaknessValue>,
  pattern: AcceptedTask<AnalysisPatternValue>,
  expected: AnalysisUploadExpectation,
): boolean {
  if (!expected || expected.remote !== false || !validTarget(expected.targetId)
    || !isAccountScope(expected.scope) || !isInputStamp(expected.weaknessStamp)
    || !isInputStamp(expected.patternStamp) || typeof expected.inputHandle !== 'string'
    || !Number.isSafeInteger(expected.intentToken) || expected.intentToken < 0) return false;
  if (!sameOwner(expected.targetId, expected.scope.iidxId)
    || !sameOwner(expected.targetId, expected.weaknessStamp.scope.iidxId)
    || !sameOwner(expected.targetId, expected.patternStamp.scope.iidxId)) return false;
  if (!readyTask(weakness) || !readyTask(pattern)
    || weakness.value == null || pattern.value == null) return false;
  if (!stampsEqual(weakness.stamp, expected.weaknessStamp)
    || !stampsEqual(pattern.stamp, expected.patternStamp)
    || weakness.inputHandle !== expected.inputHandle || pattern.inputHandle !== expected.inputHandle) return false;
  if (!scopesEqual(weakness.stamp.scope, pattern.stamp.scope)
    || weakness.stamp.rowsRevision !== pattern.stamp.rowsRevision
    || weakness.stamp.chartsRevision !== pattern.stamp.chartsRevision) return false;
  return validWeakness(weakness.value) && validPattern(pattern.value);
}

/** Content key excludes revisions, handles, and request ids; intent is its last tuple item. */
export function analysisUploadKey(expected: AnalysisUploadExpectation, patternDigest: string): string {
  if (!expected || !isAccountScope(expected.scope) || !isInputStamp(expected.weaknessStamp)
    || !isInputStamp(expected.patternStamp) || !validDigest(patternDigest)
    || !Number.isSafeInteger(expected.intentToken) || expected.intentToken < 0) {
    throw new TypeError('Invalid analysis upload key input');
  }
  return JSON.stringify([
    'analysis-upsert-v1', normalizeTargetId(expected.targetId),
    [expected.scope.iidxId, expected.scope.epoch], patternDigest,
    stampContent(expected.weaknessStamp), stampContent(expected.patternStamp), expected.intentToken,
  ]);
}

export type AnalysisUploadToken = number;

export interface AnalysisUploadLedger {
  reserve(key: string): AnalysisUploadToken | null;
  finish(token: AnalysisUploadToken, ok: boolean, current: boolean): boolean;
  release(token: AnalysisUploadToken): boolean;
  clear(): void;
}

/**
 * Bounded, shareable ledger. In-flight entries are never evicted; when capacity is
 * fully occupied by them, reserve refuses new work. Construct at service scope to
 * share across remounts, and clear on scope/epoch invalidation.
 */
export function createAnalysisUploadLedger(limit = 64): AnalysisUploadLedger {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive safe integer');
  let nextToken = 1;
  const inflight = new Map<AnalysisUploadToken, string>();
  const inflightKeys = new Map<string, AnalysisUploadToken>();
  const completed = new Map<string, true>();

  const trim = (): void => {
    while (completed.size > limit - inflight.size) {
      const oldestCompleted = completed.keys().next();
      if (oldestCompleted.done) return;
      completed.delete(oldestCompleted.value);
    }
  };

  return {
    reserve(key: string): AnalysisUploadToken | null {
      if (typeof key !== 'string') throw new TypeError('key must be a string');
      if (completed.has(key)) {
        completed.delete(key);
        completed.set(key, true);
        return null;
      }
      if (inflightKeys.has(key)) return null;
      if (inflight.size + completed.size >= limit) {
        const oldestCompleted = completed.keys().next();
        if (oldestCompleted.done) return null;
        completed.delete(oldestCompleted.value);
      }
      const token = nextToken++;
      inflight.set(token, key);
      inflightKeys.set(key, token);
      return token;
    },
    finish(token: AnalysisUploadToken, ok: boolean, current: boolean): boolean {
      const key = inflight.get(token);
      if (key === undefined) return false;
      inflight.delete(token);
      if (inflightKeys.get(key) === token) inflightKeys.delete(key);
      if (ok && current) {
        completed.delete(key);
        completed.set(key, true);
        trim();
      }
      return true;
    },
    release(token: AnalysisUploadToken): boolean {
      const key = inflight.get(token);
      if (key === undefined) return false;
      inflight.delete(token);
      if (inflightKeys.get(key) === token) inflightKeys.delete(key);
      return true;
    },
    clear(): void {
      inflight.clear();
      inflightKeys.clear();
      completed.clear();
    },
  };
}

/** Module-service singleton with no browser globals; it survives component remounts. */
export const analysisUploadLedger = createAnalysisUploadLedger(64);

function normalizeTargetId(value: string): string { return value.replace(/-/g, ''); }
function sameOwner(target: string, owner: string | null): boolean {
  return owner !== null && normalizeTargetId(target).toLowerCase() === normalizeTargetId(owner).toLowerCase();
}
function validTarget(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function validDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f\d]{64}$/i.test(value); }
function readyTask<T>(task: AcceptedTask<T> | null | undefined): task is AcceptedTask<T> & { status: 'ready'; stamp: InputStamp; inputHandle: string; value: T | null } {
  return !!task && task.status === 'ready' && isInputStamp(task.stamp)
    && typeof task.inputHandle === 'string' && Object.prototype.hasOwnProperty.call(task, 'value');
}
function validPattern(value: AnalysisPatternValue): boolean {
  return !!value && validVector(value.vec) && validDigest(value.digest);
}
function validWeakness(value: AnalysisWeaknessValue): boolean {
  if (!value || value.allCharts === undefined || !validObject(value.vec) || !validEntries(value.vec.__entries)) return false;
  return Object.entries(value.vec).every(([key, item]) => key === '__entries' || (key.length > 0 && typeof item === 'number' && Number.isFinite(item)));
}
function validObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return true;
}
function validVector(value: unknown): value is Record<string, number> {
  if (!validObject(value)) return false;
  return Object.entries(value).every(([key, item]) => key.length > 0 && typeof item === 'number' && Number.isFinite(item));
}
function validEntries(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}
function stampContent(stamp: InputStamp): readonly unknown[] {
  return [stamp.modelRevision, stamp.dataRevision, stamp.optionsKey];
}
