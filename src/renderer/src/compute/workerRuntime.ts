import { isJobRequest, isPlainDto, isWorkerCommand } from './protocol';
import type { JobRequest } from './protocol';
import { makeOptionsKey, scopesEqual } from './revisionKey';
import { runKernel } from './kernels';
import type { KernelOptions } from './kernels';
import { createWorkerResources, sha256 } from './workerResources';
import type { ResourceSpec } from './workerResources';
import { createRecommendEngine } from './recommendEngine';
import { handleRecommendRequest } from './recommendBridgeHandler';

import { encodeValue, isInstalledInput, isS1Kind } from './workerBoundary';
import type { InstalledInput } from './workerBoundary';
export { encodeValue, decodeValue, isInstalledInput, isS1Kind } from './workerBoundary';
export type { InstalledInput } from './workerBoundary';

export function createWorkerRuntime(post: (message: unknown) => void) {
  let generation = -1;
  const inputs = new Map<string, InstalledInput>();
  const rowsDigests = new Map<string, string>();
  const vectors = new Map<string, { key: string; value: unknown }>();
  const resources = createWorkerResources();
  const recommendations = createRecommendEngine();
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
          inputs.delete(old); rowsDigests.delete(old);
        }
        const inputDigest = await sha256(makeOptionsKey(m.input.data));
        rowsDigests.set(m.inputHandle as string, await sha256(makeOptionsKey(m.input.data.rows)));
        post({ protocol: 1, type: 'input-installed', inputHandle: m.inputHandle, inputDigest }); return;
      }
      case 'release-input':
        inputs.delete(m.inputHandle as string); rowsDigests.delete(m.inputHandle as string);
        if (!inputs.size) vectors.clear();
        return;
      case 'dispose-context': recommendations.clear(); return;
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
        // Song metadata affects labels, not weakness. Reuse the exact rows vector
        // when layout installs a later songs snapshot for the same account.
        const vectorKey = makeOptionsKey([input.stamp.scope, rowsDigests.get(request.inputHandle), manifest]);
        let vector = vectors.get(vectorKey);
        if (!vector) {
          vector = { key: vectorKey, value: runKernel('weakness', input.data, payload.options, libs) };
          vectors.set(vectorKey, vector);
          while (vectors.size > 2) vectors.delete(vectors.keys().next().value!);
        }
        libs.userVec = vector.value;
      }
      let result: unknown;
      if (request.kind === 'rec-query' && payload.options.operation === 'targets') {
        const options = payload.options as any;
        if (options.request?.kind !== 'targets') throw new Error('INVALID_TARGET_REQUEST');
        result = handleRecommendRequest(options.request, { recCtx: null, ratingData: libs.rating,
          baseStar: options.bridge?.baseStar ?? null, userRStar: options.bridge?.userRStar ?? null,
          userCharts: options.bridge?.userCharts ?? [], normFn: libs.OhsorryNorm.norm, coreVersion: null });
      } else if (request.kind === 'rec-context' || request.kind === 'rec-query') {
        // Content identity is computed off the renderer. Metadata arrival with
        // identical bytes reuses the mutable context and its candidate indexes.
        const contextKey = await sha256(makeOptionsKey([input.stamp.scope,
          rowsDigests.get(request.inputHandle), manifest, input.data.notInInf, input.data.songs]));
        const context = recommendations.context(contextKey, input.data, libs);
        if (request.kind === 'rec-query') {
          if (payload.options.contextHandle !== contextKey) throw new Error('CONTEXT_STALE');
          result = recommendations.query(contextKey, payload.options as never);
        } else result = context;
      } else result = request.kind === 'weakness' ? libs.userVec : runKernel(request.kind, input.data, payload.options, libs);
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
