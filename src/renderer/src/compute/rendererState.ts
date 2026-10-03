import type { AccountScope } from '../../../shared/account';
import { scopesEqual } from './revisionKey';
import type { AcceptedTask, AcceptedBundle, BundleExpectation } from './acceptedBundle';
import { isUploadReady } from './acceptedBundle';

export interface DisplayTask<T> { scope: AccountScope; value: T | null }
export function previousDisplay<T>(previous: DisplayTask<T> | undefined, scope: AccountScope): T | null {
  return previous && scopesEqual(previous.scope, scope) ? previous.value : null;
}
export function starBundle(input: { handle: string; stamp: { scope: AccountScope; rowsRevision: number; chartsRevision: number } },
  dp: AcceptedTask, r: AcceptedTask, sp: AcceptedTask): { bundle: AcceptedBundle; expected: BundleExpectation; ready: boolean } {
  const modelRevision = JSON.stringify([dp.stamp.modelRevision, r.stamp.modelRevision, sp.stamp.modelRevision]);
  const dataRevision = JSON.stringify([dp.stamp.dataRevision, r.stamp.dataRevision, sp.stamp.dataRevision]);
  const common = { ...input.stamp, modelRevision, dataRevision, rowsHandle: input.handle };
  const bundle: AcceptedBundle = { ...common, dp, r, sp };
  const expected: BundleExpectation = { ...common, dp: dp.stamp, r: r.stamp, sp: sp.stamp, required: ['dp', 'r', 'sp'] };
  return { bundle, expected, ready: isUploadReady(bundle, expected)
    && [dp, r, sp].every(task => task.inputHandle === input.handle) };
}
