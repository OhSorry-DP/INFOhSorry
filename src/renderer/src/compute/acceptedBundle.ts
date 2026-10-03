import type { AccountScope } from '../../../shared/account';
import { isFloorSeedCurrent } from '../../../shared/account';
import { isJobResponse, isJobKind, isInputStamp, isNonNegativeSafeInteger, PROTOCOL_VERSION } from './protocol';
import type { InputStamp, JobKind, JobResponse } from './protocol';
import { scopesEqual, stampsEqual } from './revisionKey';

export interface ContextExpectation { contextHandle: string; contextGeneration: number }
export interface AcceptExpectation {
  kind: JobKind; latestRequestId: number; workerGeneration: number; inputHandle: string;
  stamp: InputStamp; selectedViewerId: string | null; rowsScope: AccountScope;
  accountScope: AccountScope; context?: ContextExpectation;
}
export type ResultEnvelope = JobResponse & { inputHandle: string; contextHandle?: string; contextGeneration?: number };

export function canAccept(resultEnvelope: unknown, expected: AcceptExpectation): boolean {
  if (!validExpected(expected) || !isJobResponse(resultEnvelope) || !isJobKind(expected.kind)) return false;
  const result = resultEnvelope as ResultEnvelope;
  if (result.protocol !== PROTOCOL_VERSION || result.kind !== expected.kind
    || result.requestId !== expected.latestRequestId || result.workerGeneration !== expected.workerGeneration
    || result.inputHandle !== expected.inputHandle || !stampsEqual(result.stamp, expected.stamp)) return false;
  if (expected.stamp.scope.iidxId !== expected.selectedViewerId
    || !isFloorSeedCurrent(expected.stamp.scope, expected.rowsScope)
    || !isFloorSeedCurrent(expected.stamp.scope, expected.accountScope)) return false;
  if (expected.context && (result.contextHandle !== expected.context.contextHandle
    || result.contextGeneration !== expected.context.contextGeneration)) return false;
  return true;
}

export type TaskState<T = unknown> = { status: 'pending' } | { status: 'error'; error?: unknown } | { status: 'ready'; value: T | null; stamp: InputStamp; requestId: number; workerGeneration: number; inputHandle: string; contextHandle?: string; contextGeneration?: number };
export interface AcceptedTask<T = unknown> { status: TaskState<T>['status']; stamp: InputStamp; value?: T | null; requestId?: number; workerGeneration?: number; inputHandle?: string; contextHandle?: string; contextGeneration?: number }
export interface AcceptedBundle {
  scope: AccountScope; rowsRevision: number; chartsRevision: number; modelRevision: string; dataRevision: string;
  rowsHandle: string; dp: AcceptedTask; r: AcceptedTask; sp: AcceptedTask;
  previousDisplay?: { dp?: unknown; r?: unknown; sp?: unknown };
}
export interface BundleExpectation {
  scope: AccountScope; rowsRevision: number; chartsRevision: number; modelRevision: string; dataRevision: string; rowsHandle: string;
  dp: InputStamp; r: InputStamp; sp: InputStamp; required: readonly ('dp' | 'r' | 'sp')[];
}

export function isUploadReady(bundle: AcceptedBundle, expectedBundle: BundleExpectation): boolean {
  if (!bundle || !expectedBundle || !scopesEqual(bundle.scope, expectedBundle.scope)
    || bundle.rowsRevision !== expectedBundle.rowsRevision || bundle.chartsRevision !== expectedBundle.chartsRevision
    || bundle.modelRevision !== expectedBundle.modelRevision || bundle.dataRevision !== expectedBundle.dataRevision
    || bundle.rowsHandle !== expectedBundle.rowsHandle || !Array.isArray(expectedBundle.required)) return false;
  for (const key of expectedBundle.required as readonly ('dp' | 'r' | 'sp')[]) {
    const task = bundle[key];
    if (!task || task.status !== 'ready' || !stampsEqual(task.stamp, expectedBundle[key])) return false;
    if (!scopesEqual(task.stamp.scope, bundle.scope) || task.stamp.rowsRevision !== bundle.rowsRevision
      || task.stamp.chartsRevision !== bundle.chartsRevision) return false;
  }
  return true;
}

export function invalidateBundle(bundle: AcceptedBundle, nextExpected: BundleExpectation): AcceptedBundle {
  if (!bundle) return bundle;
  if (!scopesEqual(bundle.scope, nextExpected.scope)) return {
    scope: nextExpected.scope, rowsRevision: nextExpected.rowsRevision, chartsRevision: nextExpected.chartsRevision,
    modelRevision: nextExpected.modelRevision, dataRevision: nextExpected.dataRevision, rowsHandle: nextExpected.rowsHandle,
    dp: pending(nextExpected.dp), r: pending(nextExpected.r), sp: pending(nextExpected.sp),
  };
  const update = (key: 'dp' | 'r' | 'sp'): AcceptedTask => stampsEqual(bundle[key].stamp, nextExpected[key]) ? bundle[key] : pending(nextExpected[key]);
  return { ...bundle, scope: nextExpected.scope, rowsRevision: nextExpected.rowsRevision, chartsRevision: nextExpected.chartsRevision,
    modelRevision: nextExpected.modelRevision, dataRevision: nextExpected.dataRevision, rowsHandle: nextExpected.rowsHandle,
    dp: update('dp'), r: update('r'), sp: update('sp') };
}

/** Capture upload rows from the same ready bundle/rowsHandle as the accepted snapshot. */
export function snapshotBundleRowsHandle(bundle: AcceptedBundle, expected: BundleExpectation): string | null {
  return isUploadReady(bundle, expected) ? bundle.rowsHandle : null;
}

function validExpected(e: AcceptExpectation): boolean {
  return !!e && isJobKind(e.kind) && isNonNegativeSafeInteger(e.latestRequestId) && isNonNegativeSafeInteger(e.workerGeneration)
    && typeof e.inputHandle === 'string' && isInputStamp(e.stamp) && (e.selectedViewerId === null || typeof e.selectedViewerId === 'string')
    && e.selectedViewerId !== null && e.selectedViewerId === e.stamp.scope.iidxId
    && e.rowsScope !== undefined && e.accountScope !== undefined && (!e.context || (typeof e.context.contextHandle === 'string' && isNonNegativeSafeInteger(e.context.contextGeneration)));
}
function pending(stamp: InputStamp): AcceptedTask { return { status: 'pending', stamp }; }
