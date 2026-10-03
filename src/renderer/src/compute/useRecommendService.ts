import { useEffect, useMemo, useRef, useState } from 'react';
import { computeClient } from './rendererService';
import type { rendererInput } from './rendererService';
import type { KernelOptions } from './kernels';
import type { ResourceSpec } from './workerResources';
import { makeOptionsKey } from './revisionKey';
import { beginPerf, endPerf } from '../perfDiag';

export interface RecommendMetadata {
  contextHandle: string;
  coreVersion: string | null;
  practiceParents: unknown;
  practiceSubfeats: unknown;
  practiceSubfeatsHidden: unknown;
  practiceZasaDefault: { min: number; max: number };
}
export interface RecommendService extends RecommendMetadata {
  query(options: KernelOptions, lane?: string): Promise<any>;
}

/** Metadata and a gated async facade are the only renderer context objects. */
export function useRecommendService(input: ReturnType<typeof rendererInput>, resources: ResourceSpec[] | undefined,
  enabled: boolean, isCurrent: () => boolean) {
  const [retryRevision, setRetryRevision] = useState(0);
  const token = useMemo(() => ({}), [input, resources, enabled, retryRevision]);
  const live = useRef({ token, isCurrent });
  live.current = { token, isCurrent };
  const [state, setState] = useState<{ token: object; service?: RecommendService; targets?: { query: RecommendService['query'] }; error?: string }>();
  useEffect(() => {
    let cancelled = false;
    const tickets = new Set<ReturnType<typeof computeClient.submit>>();
    const valid = () => !cancelled && live.current.token === token && live.current.isCurrent();
    input.ensure();
    const release = computeClient.retainInput(input.handle);
    if (!resources) return release;
    const run = async (kind: 'rec-context' | 'rec-query', options: KernelOptions, lane: string, sources = resources) => {
      const manifest = await computeClient.prepare(kind, sources);
      if (!valid()) throw new Error('STALE_RECOMMEND_CONTEXT');
      const stamp = { ...input.stamp, ...manifest, optionsKey: makeOptionsKey(options) };
      const calc = kind === 'rec-context' ? 'recCtx' : 'recommend';
      const perf = beginPerf(calc, stamp.rowsRevision, stamp.scope.epoch, stamp.scope.iidxId);
      const ticket = computeClient.submit({ kind, stamp, inputHandle: input.handle, affinityHandle: input.affinityHandle ?? input.handle,
        options, resources: sources, lane, priority: lane.startsWith('bridge:') ? 0 : 1, isCurrent: valid });
      tickets.add(ticket);
      try {
        const response = await ticket.promise;
        endPerf(calc, perf, stamp.rowsRevision, stamp.scope.epoch, stamp.scope.iidxId, response.status === 'ready' ? 'ok' : 'error');
        let value: unknown;
        if (!ticket.accept(response, accepted => {
          if (accepted.status !== 'ready') throw new Error(accepted.message);
          value = accepted.value;
        })) throw new Error('STALE_RECOMMEND_RESULT');
        return value;
      } finally { tickets.delete(ticket); ticket.cancel(); }
    };
    const targetSources = resources.filter(spec => spec.key === 'OhsorryNorm' || spec.key === 'rating');
    const targets = { query: (options: KernelOptions, lane = 'targets') => run('rec-query',
      { ...options, operation: 'targets' }, lane, targetSources) };
    setState({ token, targets });
    if (enabled) void run('rec-context', {}, 'context').then(value => {
      if (!valid()) return;
      const metadata = value as RecommendMetadata;
      const service: RecommendService = { ...metadata,
        query: (options, lane = 'ui') => run('rec-query', { ...options, contextHandle: metadata.contextHandle }, lane) };
      setState({ token, service, targets });
    }).catch(error => { if (valid()) setState({ token, targets, error: String(error) }); });
    return () => { cancelled = true; for (const ticket of tickets) ticket.cancel(); release(); };
  }, [token]);
  return { service: state?.token === token ? state.service ?? null : null,
    targets: state?.token === token ? state.targets ?? null : null,
    status: state?.token === token ? state.error ? 'error' : state.service ? 'ready' : 'pending' : 'pending',
    error: state?.token === token ? state.error : undefined,
    retry: () => setRetryRevision(n => n + 1) };
}
