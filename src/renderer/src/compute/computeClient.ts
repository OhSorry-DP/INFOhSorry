import { choosePoolSize } from './poolPolicy';
import { createResultCache } from './resultCache';
import { createResourceCache } from './resourceCache';
import { isJobResponse, isPlainDto, isInputStamp } from './protocol';
import type { InputStamp, JobResponse, JobRequest } from './protocol';
import { makeJobKey, makeOptionsKey, stampsEqual } from './revisionKey';
import { decodeValue, isInstalledInput, isS1Kind } from './workerBoundary';
import type { InstalledInput } from './workerBoundary';
import type { KernelOptions, S1Kind } from './kernels';
import type { ResourceManifest, ResourceSpec } from './workerResources';
import { perfEvent } from '../perfDiag';

type ResultStage = Record<string, string | number | boolean | null>;
function recordResultStages(stages: ResultStage[]): void {
  try {
    for (const stage of stages) perfEvent('compute-result-stage', stage);
  } catch { /* diagnostics must not affect result delivery */ }
}
const monoNow = () => typeof performance === 'undefined' ? 0 : performance.now();
const epochNow = () => typeof performance === 'undefined' ? 0 : performance.timeOrigin + performance.now();
const duration = (start: number, end: number) => Math.max(0, end - start).toFixed(3);

export interface WorkerPort {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
export interface ComputeSubmission {
  kind: S1Kind;
  stamp: InputStamp;
  inputHandle: string;
  /** Layout can reuse the Worker that computed weakness for the same rows. */
  affinityHandle?: string;
  /** Independent UI stages and remote requests must not supersede each other. */
  lane?: string;
  options: KernelOptions;
  resources?: ResourceSpec[];
  priority?: number;
  /** S2 checks current accountScope, rows owner, viewer and revisions here, again before applying. */
  isCurrent: () => boolean;
}
export interface ComputeTicket {
  promise: Promise<JobResponse>;
  cancel(): void;
  /** Repeat the gate immediately before S2 mutates UI/floor/bundle state. */
  accept(response: JobResponse, apply: (response: JobResponse) => void): boolean;
}
interface Subscriber { resolve: (response: JobResponse) => void; current: () => boolean; cancelled: boolean; received?: JobResponse }
interface Job { id: number; key: string; spec: ComputeSubmission; subscribers: Subscriber[]; attempts: number }
interface QueueItem { kind: S1Kind; handle?: string; priority: number; queuedAt: number; order: number; job?: Job;
  prepare?: { resources?: ResourceSpec[]; resolve: (value: ResourceManifest) => void; reject: (error: Error) => void } }
interface Slot { worker: WorkerPort; generation: number; busy: boolean; inputs: Set<string>;
  pending?: { match: (value: Record<string, unknown>) => boolean; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } }

export function createComputeClient(config: {
  hardwareConcurrency?: unknown;
  workerFactory?: () => WorkerPort;
  watchdogMs?: number;
} = {}) {
  const cap = choosePoolSize(config.hardwareConcurrency ?? (typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency));
  const factory = config.workerFactory ?? (() => new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module', name: 'inf-compute' }));
  const timeout = config.watchdogMs ?? 120_000;
  const slots: Slot[] = [];
  const snapshots = new Map<string, InstalledInput>();
  const retainedInputs = new Map<string, number>();
  const usedHandles = new Set<string>();
  const snapshotRevisions = new Map<string, string>();
  const queue: QueueItem[] = [];
  const jobs = new Map<string, Job>();
  const latest = new Map<string, number>();
  const laneKey = (spec: ComputeSubmission) => makeOptionsKey([spec.kind, spec.lane ?? spec.kind]);
  const affinity = new Map<string, Slot>();
  const cache = createResultCache<unknown>();
  const receivedStages = new WeakMap<object, ResultStage[]>();
  const manifests = createResourceCache<ResourceManifest>();
  let sequence = 0, generation = 0, disposed = false;
  const counters = { cacheHit: 0, run: 0, stale: 0, retry: 0 };
  const inputRevision = (input: InstalledInput) => makeOptionsKey([input.stamp.scope, input.stamp.rowsRevision, input.stamp.chartsRevision]);
  const currentInput = (spec: ComputeSubmission) => {
    const input = snapshots.get(spec.inputHandle);
    return !!input && inputRevision(input) === makeOptionsKey([spec.stamp.scope, spec.stamp.rowsRevision, spec.stamp.chartsRevision]);
  };
  const dropSnapshot = (handle: string) => {
    const input = snapshots.get(handle);
    snapshots.delete(handle); affinity.delete(handle);
    if (input && ![...snapshots.values()].some(other => inputRevision(other) === inputRevision(input))) snapshotRevisions.delete(inputRevision(input));
    for (const slot of slots) if (!slot.busy && slot.inputs.delete(handle)) slot.worker.postMessage({ protocol: 1, type: 'release-input', inputHandle: handle });
  };
  const pruneSnapshots = () => {
    const protectedHandles = new Set([...snapshots.keys()].slice(-2));
    for (const handle of retainedInputs.keys()) protectedHandles.add(handle);
    for (const job of jobs.values()) protectedHandles.add(job.spec.inputHandle);
    for (const handle of snapshots.keys()) if (!protectedHandles.has(handle)) dropSnapshot(handle);
  };
  const errorResponse = (job: Job, code: string, message: string): JobResponse => ({ protocol: 1,
    workerGeneration: 0, requestId: job.id, kind: job.spec.kind, stamp: job.spec.stamp, status: 'error', code, message });
  const finish = (job: Job, response: JobResponse, trace?: { stages: ResultStage[]; start: number; origin: 'worker' | 'cache' }) => {
    const finishStart = monoNow();
    const cloneStart = monoNow(); let cloneCount = 0;
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    for (const subscriber of job.subscribers) {
      const current = !subscriber.cancelled && latest.get(laneKey(job.spec)) === job.id && currentInput(job.spec) && subscriber.current();
      if (current) {
        subscriber.received = structuredClone(response); cloneCount++;
        subscriber.resolve(subscriber.received);
      }
      else { counters.stale++; subscriber.resolve(errorResponse(job, 'STALE_RESULT', 'Calculation superseded or cancelled')); }
    }
    const finishEnd = monoNow();
    const pruneStart = monoNow(); pruneSnapshots();
    if (trace) {
      const cloneEnd = monoNow();
      trace.stages.push({ requestId: job.id, workerGeneration: response.workerGeneration, kind: job.spec.kind,
        rowsRev: job.spec.stamp.rowsRevision, epoch: job.spec.stamp.scope.epoch, stage: 'subscriber-clone',
        durMs: duration(cloneStart, cloneEnd), startMonoMs: cloneStart.toFixed(3), endMonoMs: cloneEnd.toFixed(3),
        origin: trace.origin, subscriberCount: job.subscribers.length, cloneCount });
      const end = monoNow();
      trace.stages.push({ requestId: job.id, workerGeneration: response.workerGeneration, kind: job.spec.kind,
        rowsRev: job.spec.stamp.rowsRevision, epoch: job.spec.stamp.scope.epoch, stage: 'prune',
        durMs: duration(pruneStart, end), startMonoMs: pruneStart.toFixed(3), endMonoMs: end.toFixed(3),
        origin: trace.origin, subscriberCount: job.subscribers.length });
      trace.stages.push({ requestId: job.id, workerGeneration: response.workerGeneration, kind: job.spec.kind,
        rowsRev: job.spec.stamp.rowsRevision, epoch: job.spec.stamp.scope.epoch, stage: 'finish',
        durMs: duration(finishStart, finishEnd), startMonoMs: finishStart.toFixed(3), endMonoMs: finishEnd.toFixed(3),
        origin: trace.origin, subscriberCount: job.subscribers.length });
      recordResultStages(trace.stages);
    }
  };
  const waitFor = (slot: Slot, message: unknown, match: (value: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      slot.pending = { match, resolve, reject, timer: setTimeout(() => fail(slot, new Error('WORKER_TIMEOUT')), timeout) };
      try { slot.worker.postMessage(message); } catch (error) { fail(slot, error as Error); }
    });
  const fail = (slot: Slot, error: Error) => {
    const pending = slot.pending;
    slot.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    slot.worker.terminate();
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
    for (const [key, owner] of affinity) if (owner === slot) affinity.delete(key);
  };
  const spawn = (): Slot => {
    const slot: Slot = { worker: factory(), generation: ++generation, busy: false, inputs: new Set() };
    slot.worker.onmessage = event => {
      const start = monoNow(), receiverEntryEpochMs = epochNow();
      const trace: ResultStage[] = [];
      const base = (stage: string, stageStart: number, end: number): ResultStage => ({ requestId: 0, workerGeneration: slot.generation,
        kind: 'unknown', rowsRev: 0, epoch: 0, stage, durMs: duration(stageStart, end), startMonoMs: stageStart.toFixed(3), endMonoMs: end.toFixed(3), origin: 'worker', subscriberCount: 0 });
      const dataStart = monoNow();
      const value = event.data as Record<string, unknown>;
      const dataEnd = monoNow();
      trace.push(base('receiver-entry', start, start), base('event-data-access', dataStart, dataEnd));
      const pending = slot.pending;
      const matchStart = monoNow();
      // 매칭 안 되는 메시지(prepare 응답 등)는 기록하지 않는다 — 결과 수신 구간만 잰다
      if (!value || value.protocol !== 1 || !pending || !pending.match(value)) return;
      const matchEnd = monoNow(); trace.push(base('pending-match', matchStart, matchEnd));
      const response = value as unknown as JobResponse;
      const job = [...jobs.values()].find(candidate => candidate.id === response.requestId);
      const common = job ? { requestId: job.id, workerGeneration: response.workerGeneration, kind: job.spec.kind,
        rowsRev: job.spec.stamp.rowsRevision, epoch: job.spec.stamp.scope.epoch, origin: 'worker' as const,
        subscriberCount: job.subscribers.length } : null;
      if (common) {
        for (const item of trace) Object.assign(item, common);
        const diag = (value as Record<string, unknown>).diag as Record<string, unknown> | undefined;
        if (diag?.version === 1 && typeof diag.workerReadyEpochMs === 'number' && Number.isFinite(diag.workerReadyEpochMs)) {
          const upper = receiverEntryEpochMs - diag.workerReadyEpochMs;
          const fields: ResultStage = { ...common, stage: 'transport-upper', available: upper >= 0,
            ...(upper >= 0 ? { transportUpperMs: upper.toFixed(3) } : {}) };
          for (const key of ['valueBytes', 'entriesCount', 'allChartsCount', 'encodeMs', 'dtoValidateMs', 'sizeMeasureMs']) {
            const n = diag[key]; if (typeof n === 'number' && Number.isFinite(n)) fields[key] = n;
          }
          trace.push(fields);
        }
        receivedStages.set(value as object, trace);
      }
      clearTimeout(pending.timer); slot.pending = undefined; pending.resolve(value);
    };
    slot.worker.onerror = event => fail(slot, new Error(event.message || 'WORKER_ERROR'));
    slot.worker.onmessageerror = () => fail(slot, new Error('WORKER_MESSAGE_ERROR'));
    slots.push(slot);
    return slot;
  };
  const execute = async (slot: Slot, item: QueueItem) => {
    slot.busy = true;
    const job = item.job;
    try {
      if (!slot.inputs.has('__ready__')) {
        await waitFor(slot, { protocol: 1, type: 'init', workerGeneration: slot.generation },
          value => value.type === 'ready' && value.workerGeneration === slot.generation);
        slot.inputs.add('__ready__');
      }
      if (item.prepare) {
        const prepareId = ++sequence;
        const v = await waitFor(slot, { protocol: 1, type: 'prepare', kind: item.kind, prepareId,
          workerGeneration: slot.generation, resources: item.prepare.resources }, value =>
          (value.type === 'prepared' || value.type === 'prepare-error') && value.prepareId === prepareId && value.workerGeneration === slot.generation);
        if (v.type === 'prepare-error') throw new Error(String(v.message));
        if (typeof v.modelRevision !== 'string' || typeof v.dataRevision !== 'string') throw new Error('INVALID_MANIFEST');
        item.prepare.resolve({ modelRevision: v.modelRevision, dataRevision: v.dataRevision });
        return;
      }
      if (!job) return;
      const { spec } = job;
      const input = snapshots.get(spec.inputHandle);
      if (!input || latest.get(laneKey(spec)) !== job.id || !job.subscribers.some(s => !s.cancelled && s.current())) {
        finish(job, errorResponse(job, 'STALE_INPUT', 'Input is no longer current')); return;
      }
      if (!slot.inputs.has(spec.inputHandle)) {
        await waitFor(slot, { protocol: 1, type: 'install-input', inputHandle: spec.inputHandle, input },
          value => value.type === 'input-installed' && value.inputHandle === spec.inputHandle);
        slot.inputs.add(spec.inputHandle);
        const handles = [...slot.inputs].filter(handle => handle !== '__ready__');
        while (handles.length > 2) slot.inputs.delete(handles.shift()!);
      }
      const request: JobRequest = { protocol: 1, workerGeneration: slot.generation, requestId: job.id,
        kind: spec.kind, stamp: spec.stamp, inputHandle: spec.inputHandle,
        payload: { options: spec.options, ...(spec.resources ? { resources: spec.resources } : {}) } };
      counters.run++;
      const v = await waitFor(slot, { ...request, type: 'run' }, value =>
        (value.type === 'result' || value.type === 'error') && isJobResponse(value)
        && value.workerGeneration === request.workerGeneration && value.requestId === request.requestId
        && value.kind === request.kind && stampsEqual(value.stamp, request.stamp));
      const response = v as unknown as JobResponse;
      const trace = receivedStages.get(v as object) ?? [];
      const continuation = monoNow();
      const stageFields = (stage: string, start: number, end: number, origin: 'worker' | 'cache' = 'worker'): ResultStage => ({
        requestId: job.id, workerGeneration: response.workerGeneration, kind: spec.kind, rowsRev: spec.stamp.rowsRevision,
        epoch: spec.stamp.scope.epoch, stage, durMs: duration(start, end), startMonoMs: start.toFixed(3), endMonoMs: end.toFixed(3), origin,
        subscriberCount: job.subscribers.length });
      trace.push(stageFields('promise-continuation-entry', continuation, continuation));
      if (response.status === 'ready') {
        if (latest.get(laneKey(spec)) === job.id && currentInput(spec) && job.subscribers.some(s => !s.cancelled && s.current())) {
          // 캐시에 넣을 때만 크기를 잰다(계측 때문에 stale 결과까지 직렬화하지 않는다)
          let byteLength: number;
          const reportedBytes = (v as Record<string, unknown>).valueBytes;
          if (Number.isSafeInteger(reportedBytes) && (reportedBytes as number) >= 0) {
            byteLength = reportedBytes as number;
          } else {
            const stringifyStart = monoNow();
            const serialized = JSON.stringify(response.value);
            const stringifyEnd = monoNow(); trace.push(stageFields('cache-stringify', stringifyStart, stringifyEnd));
            const bytesStart = monoNow();
            byteLength = new TextEncoder().encode(serialized).byteLength;
            const bytesEnd = monoNow(); trace.push(stageFields('cache-utf8-bytes', bytesStart, bytesEnd));
          }
          const cacheSetStart = monoNow(); cache.set(job.key, response.value, byteLength, makeOptionsKey(spec.stamp.scope));
          const cacheSetEnd = monoNow(); trace.push(stageFields('cache-set', cacheSetStart, cacheSetEnd));
        }
        const decodeStart = monoNow(); const decoded = decodeValue(response.value); const decodeEnd = monoNow();
        trace.push(stageFields('decode', decodeStart, decodeEnd));
        finish(job, { ...response, value: decoded }, { stages: trace, start: continuation, origin: 'worker' });
      } else { trace.push(stageFields('error-response', continuation, monoNow())); finish(job, response, { stages: trace, start: continuation, origin: 'worker' }); }
      if (spec.kind === 'weakness' || spec.kind === 'layout' || spec.kind.startsWith('rec-')) affinity.set(spec.inputHandle, slot);
    } catch (error) {
      if (item.prepare) item.prepare.reject(error as Error);
      else if (job) {
        if (!disposed && job.attempts++ === 0 && latest.get(laneKey(job.spec)) === job.id
          && job.subscribers.some(s => !s.cancelled && s.current())) {
          counters.retry++; queue.push({ ...item, queuedAt: Date.now() });
        } else finish(job, errorResponse(job, 'WORKER_FAILED', String(error)));
      }
      fail(slot, error as Error);
    } finally {
      slot.busy = false;
      for (const handle of [...slot.inputs]) if (handle !== '__ready__' && !snapshots.has(handle)) {
        slot.inputs.delete(handle);
        if (slots.includes(slot)) slot.worker.postMessage({ protocol: 1, type: 'release-input', inputHandle: handle });
      }
      pump();
    }
  };
  const pump = () => {
    if (disposed) return;
    queue.sort((a, b) => (a.priority - Math.floor((Date.now() - a.queuedAt) / 5000))
      - (b.priority - Math.floor((Date.now() - b.queuedAt) / 5000)) || a.order - b.order);
    while (queue.length) {
      const item = queue[0];
      let slot = item.handle ? affinity.get(item.handle) : undefined;
      if (slot?.busy && item.kind.startsWith('rec-')) {
        // Leave this affinity queue serial, but allow independent star jobs.
        const runnable = queue.findIndex(other => !other.handle || !affinity.get(other.handle)?.busy);
        if (runnable <= 0) return;
        const [next] = queue.splice(runnable, 1);
        queue.unshift(next);
        continue;
      }
      if (slot?.busy) slot = undefined;
      slot ??= slots.find(s => !s.busy);
      if (!slot && slots.length >= cap) return;
      try { slot ??= spawn(); }
      catch (error) {
        queue.shift();
        if (item.job) finish(item.job, errorResponse(item.job, 'WORKER_UNAVAILABLE', String(error)));
        else item.prepare?.reject(error as Error);
        continue;
      }
      if (item.handle && item.kind.startsWith('rec-')) affinity.set(item.handle, slot);
      queue.shift(); void execute(slot, item);
    }
  };
  return {
    retainInput(handle: string) {
      retainedInputs.set(handle, (retainedInputs.get(handle) ?? 0) + 1);
      return () => {
        const count = retainedInputs.get(handle) ?? 0;
        if (count <= 1) retainedInputs.delete(handle);
        else retainedInputs.set(handle, count - 1);
        queueMicrotask(pruneSnapshots);
      };
    },
    installInput(handle: string, input: InstalledInput) {
      if (disposed || !handle || !isInstalledInput(input) || usedHandles.has(handle)) throw new Error('INVALID_OR_REUSED_INPUT');
      const revision = makeOptionsKey([input.stamp.scope, input.stamp.rowsRevision, input.stamp.chartsRevision]);
      const content = makeOptionsKey(input.data);
      const old = snapshotRevisions.get(revision);
      if (old && old !== content) throw new Error('INPUT_REVISION_REUSED');
      snapshotRevisions.set(revision, content);
      usedHandles.add(handle);
      snapshots.set(handle, structuredClone(input));
      pruneSnapshots();
    },
    releaseInput(handle: string) {
      dropSnapshot(handle);
    },
    prepare(kind: S1Kind, resources?: ResourceSpec[]): Promise<ResourceManifest> {
      if (disposed || !isS1Kind(kind)) return Promise.reject(new Error('INVALID_KIND_OR_DISPOSED'));
      return manifests.load(makeOptionsKey([kind, resources ?? null]), () => new Promise((resolve, reject) => {
        queue.push({ kind, priority: 0, queuedAt: Date.now(), order: ++sequence, prepare: { resources, resolve, reject } }); pump();
      }));
    },
    submit(spec: ComputeSubmission): ComputeTicket {
      if (disposed || !isS1Kind(spec.kind) || !isInputStamp(spec.stamp) || !isPlainDto(spec.options)
        || makeOptionsKey(spec.options) !== spec.stamp.optionsKey || !snapshots.has(spec.inputHandle)) throw new Error('INVALID_SUBMISSION');
      const input = snapshots.get(spec.inputHandle)!;
      if (makeOptionsKey([input.stamp.scope, input.stamp.rowsRevision, input.stamp.chartsRevision]) !==
        makeOptionsKey([spec.stamp.scope, spec.stamp.rowsRevision, spec.stamp.chartsRevision])) throw new Error('INPUT_STALE');
      spec = { ...spec, stamp: structuredClone(spec.stamp), options: structuredClone(spec.options), resources: spec.resources && structuredClone(spec.resources) };
      const key = makeOptionsKey([makeJobKey(spec.kind, spec.stamp), laneKey(spec)]);
      let job = jobs.get(key);
      let subscriber!: Subscriber;
      const promise = new Promise<JobResponse>(resolve => { subscriber = { resolve, current: spec.isCurrent, cancelled: false }; });
      if (job && latest.get(laneKey(spec)) === job.id) { job.subscribers.push(subscriber); }
      else {
        job = { id: ++sequence, key, spec, subscribers: [subscriber], attempts: 0 };
        latest.set(laneKey(spec), job.id);
        // Keep one latest pending request per kind; running jobs are logically cancelled.
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].job && laneKey(queue[i].job!.spec) === laneKey(spec)) {
          const stale = queue.splice(i, 1)[0].job!; finish(stale, errorResponse(stale, 'SUPERSEDED', 'New input queued'));
        }
        jobs.set(key, job);
        if (cache.has(key)) {
          counters.cacheHit++;
          const cacheStart = monoNow();
          const hit = structuredClone(cache.get(key));
          const cacheEnd = monoNow();
          const cachedJob = job;
          const decodeStart = monoNow(); const decoded = decodeValue(hit); const decodeEnd = monoNow();
          const response: JobResponse = { protocol: 1, requestId: cachedJob.id, workerGeneration: generation,
            kind: spec.kind, stamp: spec.stamp, status: 'ready', value: decoded };
          const start = monoNow();
          queueMicrotask(() => {
            const stages: ResultStage[] = [{ requestId: cachedJob.id, workerGeneration: generation, kind: spec.kind,
              rowsRev: spec.stamp.rowsRevision, epoch: spec.stamp.scope.epoch, stage: 'cache-hit-clone-decode', durMs: duration(cacheStart, cacheEnd),
              startMonoMs: cacheStart.toFixed(3), endMonoMs: cacheEnd.toFixed(3), origin: 'cache', subscriberCount: cachedJob.subscribers.length }];
            stages.push({ requestId: cachedJob.id, workerGeneration: generation, kind: spec.kind, rowsRev: spec.stamp.rowsRevision,
              epoch: spec.stamp.scope.epoch, stage: 'decode', durMs: duration(decodeStart, decodeEnd), startMonoMs: decodeStart.toFixed(3),
              endMonoMs: decodeEnd.toFixed(3), origin: 'cache', subscriberCount: cachedJob.subscribers.length });
            finish(cachedJob, response, { stages, start, origin: 'cache' });
          });
        } else {
          queue.push({ kind: spec.kind, handle: spec.affinityHandle ?? spec.inputHandle, priority: spec.priority ?? (spec.kind.endsWith('star') ? 0 : 1),
            queuedAt: Date.now(), order: job.id, job }); pump();
        }
      }
      const ownedJob = job;
      return { promise, accept(response, apply) {
        if (disposed || subscriber.cancelled || response !== subscriber.received || latest.get(laneKey(spec)) !== ownedJob.id
          || !currentInput(spec) || !subscriber.current() || !stampsEqual(response.stamp, spec.stamp)) return false;
        apply(response);
        return true;
      }, cancel() {
        if (subscriber.cancelled) return;
        subscriber.cancelled = true;
        subscriber.resolve(errorResponse(ownedJob, 'CANCELLED', 'Subscription cancelled'));
        if (ownedJob.subscribers.every(s => s.cancelled)) {
          if (spec.lane?.startsWith('bridge:') && latest.get(laneKey(spec)) === ownedJob.id) latest.delete(laneKey(spec));
          const index = queue.findIndex(item => item.job === ownedJob);
          if (index >= 0) { queue.splice(index, 1); if (jobs.get(key) === ownedJob) jobs.delete(key); }
        }
      } };
    },
    invalidateScope() {
      retainedInputs.clear();
      latest.clear(); cache.clear(); snapshots.clear(); snapshotRevisions.clear(); usedHandles.clear(); affinity.clear();
      for (const job of [...jobs.values()]) finish(job, errorResponse(job, 'SCOPE_INVALIDATED', 'Account scope changed'));
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].job) queue.splice(i, 1);
      for (const slot of [...slots]) {
        if (slot.busy) fail(slot, new Error('SCOPE_INVALIDATED'));
        else {
          slot.worker.postMessage({ protocol: 1, type: 'dispose-context', contextHandle: '*' });
          for (const handle of [...slot.inputs]) if (handle !== '__ready__') {
            slot.inputs.delete(handle);
            slot.worker.postMessage({ protocol: 1, type: 'release-input', inputHandle: handle });
          }
        }
      }
      pump();
    },
    dispose() {
      disposed = true;
      manifests.clear(); retainedInputs.clear();
      for (const job of [...jobs.values()]) finish(job, errorResponse(job, 'DISPOSED', 'Client disposed'));
      for (const item of queue) item.prepare?.reject(new Error('DISPOSED'));
      queue.length = 0; cache.clear(); snapshots.clear(); snapshotRevisions.clear(); usedHandles.clear(); affinity.clear();
      for (const slot of [...slots]) fail(slot, new Error('DISPOSED'));
    },
    get stats() { return { ...counters, workers: slots.length, cap, queued: queue.length }; },
  };
}
