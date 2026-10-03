import type { AccountScope } from '../../../shared/account';

export const PROTOCOL_VERSION = 1 as const;
export const CACHE_SCHEMA_VERSION = 1 as const;

export const JOB_KINDS = [
  'dp-star', 'r-star', 'sp-star', 'weakness', 'pattern-score',
  'rec-context', 'rec-query', 'layout',
] as const;
export type JobKind = typeof JOB_KINDS[number];

export interface InputStamp {
  scope: AccountScope;
  rowsRevision: number;
  chartsRevision: number;
  modelRevision: string;
  dataRevision: string;
  optionsKey: string;
}

export interface JobRequest<Payload = unknown> {
  protocol: typeof PROTOCOL_VERSION;
  requestId: number;
  workerGeneration: number;
  kind: JobKind;
  stamp: InputStamp;
  inputHandle: string;
  payload: Payload;
}

export interface JobResult<T = unknown> {
  protocol: typeof PROTOCOL_VERSION;
  requestId: number;
  workerGeneration: number;
  kind: JobKind;
  stamp: InputStamp;
  status: 'ready';
  value: T | null;
}

export interface JobError {
  protocol: typeof PROTOCOL_VERSION;
  requestId: number;
  workerGeneration: number;
  kind: JobKind;
  stamp: InputStamp;
  status: 'error';
  code: string;
  message: string;
}

export type JobResponse<T = unknown> = JobResult<T> | JobError;

/** UI-to-worker data must be structured-cloneable plain DTOs. */
export interface InstallInputMessage<InputDto = unknown> {
  protocol: typeof PROTOCOL_VERSION;
  type: 'install-input';
  inputHandle: string;
  input: InputDto;
}

export interface InputInstalledMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: 'input-installed';
  inputHandle: string;
}

export interface InitMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: 'init';
  workerGeneration: number;
}

export interface ReadyMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: 'ready';
  workerGeneration: number;
}

export interface ReleaseInputMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: 'release-input';
  inputHandle: string;
}

export interface DisposeContextMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: 'dispose-context';
  contextHandle: string;
}

export type WorkerCommand<InputDto = unknown> =
  | InstallInputMessage<InputDto>
  | InitMessage
  | ReleaseInputMessage
  | DisposeContextMessage
  | JobRequest;

export type WorkerNotification =
  | InputInstalledMessage
  | ReadyMessage
  | JobResponse;

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

export function isAccountScope(value: unknown): value is AccountScope {
  if (!isRecord(value)) return false;
  return (value.iidxId === null || typeof value.iidxId === 'string')
    && isNonNegativeSafeInteger(value.epoch);
}

export function isInputStamp(value: unknown): value is InputStamp {
  if (!isRecord(value)) return false;
  return isAccountScope(value.scope)
    && isNonNegativeSafeInteger(value.rowsRevision)
    && isNonNegativeSafeInteger(value.chartsRevision)
    && typeof value.modelRevision === 'string'
    && typeof value.dataRevision === 'string'
    && typeof value.optionsKey === 'string';
}

export function isJobRequest(value: unknown): value is JobRequest {
  if (!isRecord(value)) return false;
  return value.protocol === PROTOCOL_VERSION
    && isNonNegativeSafeInteger(value.requestId)
    && isNonNegativeSafeInteger(value.workerGeneration)
    && isJobKind(value.kind)
    && isInputStamp(value.stamp)
    && typeof value.inputHandle === 'string'
    && Object.prototype.hasOwnProperty.call(value, 'payload');
}

export function isJobResult(value: unknown): value is JobResult {
  return isJobEnvelope(value) && value.status === 'ready'
    && (value.value === null || isPlainDto(value.value));
}

export function isJobError(value: unknown): value is JobError {
  return isJobEnvelope(value) && value.status === 'error'
    && typeof value.code === 'string' && typeof value.message === 'string';
}

export function isJobResponse(value: unknown): value is JobResponse {
  return isJobResult(value) || isJobError(value);
}

export function isWorkerCommand(value: unknown): value is WorkerCommand {
  if (!isRecord(value) || value.protocol !== PROTOCOL_VERSION || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'install-input': return typeof value.inputHandle === 'string' && isPlainDto(value.input);
    case 'input-installed': return typeof value.inputHandle === 'string';
    case 'init':
    case 'ready': return isNonNegativeSafeInteger(value.workerGeneration);
    case 'release-input': return typeof value.inputHandle === 'string';
    case 'dispose-context': return typeof value.contextHandle === 'string';
    case 'run': return isJobRequest(value);
    default: return false;
  }
}

export function isWorkerNotification(value: unknown): value is WorkerNotification {
  if (!isRecord(value) || value.protocol !== PROTOCOL_VERSION || typeof value.type !== 'string') return false;
  if (value.type === 'input-installed') return typeof value.inputHandle === 'string';
  if (value.type === 'ready') return isNonNegativeSafeInteger(value.workerGeneration);
  if (value.type === 'result' || value.type === 'error') return isJobResponse(value);
  return false;
}

/** Only JSON-like plain DTOs cross the boundary; class instances are rejected. */
export function isPlainDto(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let valid: boolean;
  if (Array.isArray(value)) {
    valid = value.every((item) => isPlainDto(item, seen));
  } else {
    const proto = Object.getPrototypeOf(value);
    valid = (proto === Object.prototype || proto === null)
      && Object.values(value).every((item) => isPlainDto(item, seen));
  }
  seen.delete(value);
  return valid;
}

function isJobEnvelope(value: unknown): value is Record<string, unknown> & {
  protocol: 1; requestId: number; workerGeneration: number; kind: JobKind; stamp: InputStamp;
} {
  if (!isRecord(value)) return false;
  return value.protocol === PROTOCOL_VERSION
    && isNonNegativeSafeInteger(value.requestId)
    && isNonNegativeSafeInteger(value.workerGeneration)
    && isJobKind(value.kind)
    && isInputStamp(value.stamp);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
