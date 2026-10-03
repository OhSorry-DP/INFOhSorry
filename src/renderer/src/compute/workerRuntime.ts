import { isJobRequest, isPlainDto, isWorkerCommand, isInputStamp } from './protocol';
import type { InputStamp, JobRequest } from './protocol';
import { makeOptionsKey, scopesEqual } from './revisionKey';
import { runKernel, S1_KINDS } from './kernels';
import type { ComputeInput, KernelOptions, S1Kind } from './kernels';
import { createWorkerResources, sha256 } from './workerResources';
import type { ResourceSpec } from './workerResources';

export interface InstalledInput { stamp: InputStamp; data: ComputeInput }
export function isInstalledInput(value: unknown): value is InstalledInput {
  if (!isPlainDto(value) || !value || typeof value !== 'object') return false;
  const v = value as InstalledInput;
  return isInputStamp(v.stamp) && !!v.data && Array.isArray(v.data.rows) && Array.isArray(v.data.osrCharts)
    && Array.isArray(v.data.notInInf) && Array.isArray(v.data.songs);
}
export function isS1Kind(kind: unknown): kind is S1Kind { return (S1_KINDS as readonly unknown[]).includes(kind); }

// Wire values remain plain DTOs while preserving undefined/NaN in UMD outputs.
export function encodeValue(value: unknown): unknown {
  if (value === undefined) return { __computeScalar: 'undefined' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { __computeScalar: String(value) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('NON_DTO_RESULT');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)]));
  }
  return value;
}
export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length === 1 && typeof v.__computeScalar === 'string') {
      if (v.__computeScalar === 'undefined') return undefined;
      if (v.__computeScalar === 'NaN') return NaN;
      if (v.__computeScalar === 'Infinity') return Infinity;
      if (v.__computeScalar === '-Infinity') return -Infinity;
    }
    return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, decodeValue(item)]));
  }
  return value;
}

export function createWorkerRuntime(post: (message: unknown) => void) {
  let generation = -1;
  const inputs = new Map<string, InstalledInput>();
  const vectors = new Map<string, { key: string; value: unknown }>();
  const resources = createWorkerResources();
  let tail: Promise<unknown> = Promise.resolve();
  const handle = async (message: unknown) => {
    const m = message as Record<string, unknown>;
    if (!m || m.protocol !== 1) throw new Error('INVALID_PROTOCOL');
    if (m.type === 'prepare' && isS1Kind(m.kind) && Number.isSafeInteger(m.prepareId) && m.workerGeneration === generation) {
      try {
        const loaded = await resources.load(m.kind, m.resources as ResourceSpec[] | undefined);
        post({ protocol: 1, type: 'prepared', prepareId: m.prepareId, workerGeneration: generation, ...loaded.manifest });
      } catch (error) {
        post({ protocol: 1, type: 'prepare-error', prepareId: m.prepareId, workerGeneration: generation, message: String(error) });
      }
      return;
    }
    if (!isWorkerCommand(message)) throw new Error('INVALID_COMMAND');
    switch (m.type) {
      case 'init': generation = m.workerGeneration as number; post({ protocol: 1, type: 'ready', workerGeneration: generation }); return;
      case 'install-input': {
        if (!isInstalledInput(m.input)) throw new Error('INVALID_INPUT');
        if (inputs.has(m.inputHandle as string)) throw new Error('INPUT_HANDLE_REUSED');
        inputs.set(m.inputHandle as string, m.input);
        while (inputs.size > 2) {
          const old = inputs.keys().next().value!;
          inputs.delete(old); vectors.delete(old);
        }
        const inputDigest = await sha256(makeOptionsKey(m.input.data));
        post({ protocol: 1, type: 'input-installed', inputHandle: m.inputHandle, inputDigest }); return;
      }
      case 'release-input': inputs.delete(m.inputHandle as string); vectors.delete(m.inputHandle as string); return;
      case 'dispose-context': return; // S1 has no recommendation contexts.
      case 'run': break;
      default: throw new Error('INVALID_COMMAND');
    }
    if (!isJobRequest(message)) throw new Error('INVALID_REQUEST');
    const request: JobRequest = message;
    const envelope = { protocol: 1, requestId: request.requestId, workerGeneration: request.workerGeneration,
      kind: request.kind, stamp: request.stamp };
    try {
      if (request.workerGeneration !== generation || !isS1Kind(request.kind)) throw new Error('INVALID_GENERATION_OR_KIND');
      const input = inputs.get(request.inputHandle);
      if (!input || !scopesEqual(input.stamp.scope, request.stamp.scope)
        || input.stamp.rowsRevision !== request.stamp.rowsRevision || input.stamp.chartsRevision !== request.stamp.chartsRevision) throw new Error('INPUT_STALE');
      const payload = request.payload as { options: KernelOptions; resources?: ResourceSpec[] };
      if (!payload || !isPlainDto(payload.options) || makeOptionsKey(payload.options) !== request.stamp.optionsKey) throw new Error('OPTIONS_STALE');
      const { libs, manifest } = await resources.load(request.kind, payload.resources);
      if (manifest.modelRevision !== request.stamp.modelRevision || manifest.dataRevision !== request.stamp.dataRevision) throw new Error('RESOURCE_DRIFT');
      if (request.kind === 'weakness' || (request.kind === 'layout' && payload.options.style !== 'sp' && payload.options.layoutMode)) {
        const vectorKey = makeOptionsKey(manifest);
        let vector = vectors.get(request.inputHandle);
        if (!vector || vector.key !== vectorKey) {
          vector = { key: vectorKey, value: runKernel('weakness', input.data, payload.options, libs) };
          vectors.set(request.inputHandle, vector);
        }
        libs.userVec = vector.value;
      }
      const result = request.kind === 'weakness' ? libs.userVec : runKernel(request.kind, input.data, payload.options, libs);
      const value = encodeValue(result);
      if (!isPlainDto(value)) throw new Error('NON_DTO_RESULT');
      post({ ...envelope, type: 'result', status: 'ready', value });
    } catch (error) {
      post({ ...envelope, type: 'error', status: 'error', code: 'COMPUTE_FAILED', message: String(error) });
    }
  };
  return (message: unknown): Promise<unknown> => {
    const task = tail.then(() => handle(message));
    tail = task.catch(() => {});
    return task;
  };
}
