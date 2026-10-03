import { createComputeClient } from './computeClient';
import type { ComputeInput } from './kernels';
import type { AccountScope } from '../../../shared/account';
import type { InputStamp } from './protocol';

// One service survives tab unmounts and StrictMode subscription cleanup.
export const computeClient = createComputeClient();
let sequence = 0;
export function rendererInput(scope: AccountScope, rowsRevision: number, data: ComputeInput, affinityHandle?: string) {
  const chartsRevision = ++sequence;
  const handle = `renderer-${chartsRevision}`;
  const stamp: InputStamp = { scope: { ...scope }, rowsRevision, chartsRevision,
    modelRevision: '', dataRevision: '', optionsKey: '{}' };
  let installed = false;
  return { handle, stamp, affinityHandle, ensure() {
    if (!installed) { computeClient.installInput(handle, { stamp, data }); installed = true; }
  } };
}
if (import.meta.hot) import.meta.hot.dispose(() => computeClient.dispose());
if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => computeClient.dispose());
