import { useEffect, useMemo, useRef, useState } from 'react';
import { computeClient } from './rendererService';
import type { rendererInput } from './rendererService';
import { DEFAULT_RESOURCES } from './workerResources';
import type { ResourceSpec } from './workerResources';
import type { S1Kind, KernelOptions } from './kernels';
import type { AcceptedTask } from './acceptedBundle';
import { makeOptionsKey } from './revisionKey';
import { previousDisplay } from './rendererState';
import type { DisplayTask } from './rendererState';
import { beginPerf, endPerf, perfEvent } from '../perfDiag';

/** Exact App data snapshots, rather than an independent remote JSON version. */
export function useSnapshotResources(kind: S1Kind, snapshots: Record<string, unknown>) {
  const token = useMemo(() => ({}), Object.values(snapshots));
  const [state, setState] = useState<{ token: object; specs: ResourceSpec[] }>();
  useEffect(() => {
    const urls: string[] = [];
    const specs = DEFAULT_RESOURCES[kind].map(spec => {
      if (!Object.prototype.hasOwnProperty.call(snapshots, spec.key)) return spec;
      const value = snapshots[spec.key];
      if (value == null) return { ...spec, url: null };
      const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
      urls.push(url);
      return { ...spec, url };
    });
    setState({ token, specs });
    return () => urls.forEach(url => URL.revokeObjectURL(url));
  }, [kind, token]);
  return state?.token === token ? state.specs : undefined;
}

export function useComputeTask<T>(kind: S1Kind, input: ReturnType<typeof rendererInput>,
  options: KernelOptions, resources: ResourceSpec[] | undefined, enabled: boolean,
  isCurrent: () => boolean, onReady?: (value: T | null) => void, perfExtra?: Record<string, string | number>) {
  const optionsKey = makeOptionsKey(options);
  const [retryRevision, setRetryRevision] = useState(0);
  const token = useMemo(() => ({}), [input, optionsKey, resources, enabled, retryRevision]);
  const current = useRef({ token, isCurrent, onReady });
  current.current = { token, isCurrent, onReady };
  const previous = useRef<DisplayTask<T>>();
  const [state, setState] = useState<{ token: object; task: AcceptedTask<T> }>();
  useEffect(() => {
    let cancelled = false;
    let ticket: ReturnType<typeof computeClient.submit> | undefined;
    const valid = () => !cancelled && current.current.token === token && current.current.isCurrent();
    input.ensure();
    const release = computeClient.retainInput(input.handle);
    if (!enabled || !resources) return release;
    void (async () => {
      try {
        const manifest = await computeClient.prepare(kind, resources);
        if (!valid()) return;
        const stamp = { ...input.stamp, ...manifest, optionsKey };
        const calc = ({ 'dp-star': 'dp', 'r-star': 'r', 'sp-star': 'sp', weakness: options.adapter === 'analysis-songcharts-v1' ? 'analysisWeakness' : 'playDataWeakness', 'pattern-score': 'analysisPatternScore', layout: 'playDataLayout', 'rec-context': 'recCtx', 'rec-query': 'recommend' })[kind];
        const { rowsRevision, scope } = stamp;
        const diagnosticExtra = { ...perfExtra };
        const perf = beginPerf(calc, rowsRevision, scope.epoch, scope.iidxId, diagnosticExtra);
        ticket = computeClient.submit({ kind, stamp, inputHandle: input.handle, affinityHandle: input.affinityHandle,
          options, resources, isCurrent: valid });
        const perfNow = () => {
          try { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : undefined; }
          catch { return undefined; }
        };
        const promiseWaitStart = perfNow();
        const response = await ticket.promise;
        const stage = (name: string, start: number | undefined, fields: Record<string, string | number | boolean> = {}, end = perfNow()) => {
          const startMonoMs = start?.toFixed(3), endMonoMs = end?.toFixed(3);
          try { perfEvent('compute-adopt-stage', { requestId: response.requestId, workerGeneration: response.workerGeneration,
            kind, rowsRev: rowsRevision, epoch: scope.epoch, stage: name,
            ...(startMonoMs !== undefined ? { startMonoMs } : {}), ...(endMonoMs !== undefined ? { endMonoMs } : {}),
            ...(start !== undefined && end !== undefined ? { durMs: (end - start).toFixed(3) } : {}), ...fields }); } catch { /* diagnostics must not affect adoption */ }
        };
        stage('promise-resume', promiseWaitStart);
        let applied = false;
        const acceptStart = perfNow();
        const acceptCallbackStart = perfNow();
        ticket.accept(response, accepted => {
          const acceptStageStart = acceptCallbackStart;
          stage('accept-total', acceptStageStart, { accepted: true });
          applied = true;
          const createStart = perfNow();
          const task: AcceptedTask<T> = { status: accepted.status, stamp, inputHandle: input.handle,
            requestId: accepted.requestId, workerGeneration: accepted.workerGeneration,
            ...(accepted.status === 'ready' ? { value: accepted.value as T | null } : {}) };
          stage('task-create', createStart);
          if (accepted.status === 'ready') {
            const previousStart = perfNow();
            previous.current = { scope, value: task.value ?? null };
            const previousEnd = perfNow();
            stage('previous-current', previousStart, {}, previousEnd);
            const onReady = current.current.onReady;
            const onReadyStart = perfNow();
            if (onReady) onReady(task.value ?? null);
            const onReadyEnd = perfNow();
            stage('onReady', onReadyStart, { called: !!onReady }, onReadyEnd);
          }
          const setStateStart = perfNow();
          setState({ token, task });
          const setStateEnd = perfNow();
          stage('set-state', setStateStart, {}, setStateEnd);
        });
        if (!applied) {
          const rejectEnd = perfNow();
          try { perfEvent('compute-adopt-stage', { requestId: response.requestId, workerGeneration: response.workerGeneration,
            kind, rowsRev: rowsRevision, epoch: scope.epoch, stage: 'accept-total', accepted: false,
            ...(acceptStart !== undefined ? { startMonoMs: acceptStart.toFixed(3) } : {}),
            ...(rejectEnd !== undefined ? { endMonoMs: rejectEnd.toFixed(3) } : {}),
            ...(acceptStart !== undefined && rejectEnd !== undefined ? { durMs: (rejectEnd - acceptStart).toFixed(3) } : {}) }); } catch { /* diagnostics must not affect adoption */ }
        }
        const beforeEnd = perfNow();
        try { perfEvent('compute-adopt-stage', { requestId: response.requestId, workerGeneration: response.workerGeneration,
          kind, rowsRev: rowsRevision, epoch: scope.epoch, stage: 'before-end',
          ...(beforeEnd !== undefined ? { startMonoMs: beforeEnd.toFixed(3), endMonoMs: beforeEnd.toFixed(3), durMs: '0.000' } : {}) }); } catch { /* diagnostics must not affect adoption */ }
        endPerf(calc, perf, rowsRevision, scope.epoch, scope.iidxId, applied && response.status === 'ready' ? 'ok' : 'error', { ...diagnosticExtra, ...(applied ? {} : { outcome: 'cancel' }) });
      } catch (error) {
        if (valid()) setState({ token, task: { status: 'error', stamp: { ...input.stamp, optionsKey } } });
      }
    })();
    return () => { cancelled = true; ticket?.cancel(); release(); };
  }, [kind, token]);
  const task: AcceptedTask<T> = state?.token === token ? state.task : { status: 'pending', stamp: { ...input.stamp, optionsKey } };
  const value = task.status === 'ready' ? task.value ?? null
    : task.status === 'pending' ? previousDisplay(previous.current, input.stamp.scope) : null;
  return { task, value, retry: () => setRetryRevision(revision => revision + 1) };
}
