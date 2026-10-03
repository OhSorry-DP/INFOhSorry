import { isPlainDto, isInputStamp } from './protocol';
import type { InputStamp } from './protocol';
import { S1_KINDS } from './kernels';
import type { ComputeInput, S1Kind } from './kernels';

export interface InstalledInput { stamp: InputStamp; data: ComputeInput }
export function isInstalledInput(value: unknown): value is InstalledInput {
  if (!isPlainDto(value) || !value || typeof value !== 'object') return false;
  const v = value as InstalledInput;
  return isInputStamp(v.stamp) && !!v.data && Array.isArray(v.data.rows) && Array.isArray(v.data.osrCharts)
    && Array.isArray(v.data.notInInf) && (v.data.songs === null || Array.isArray(v.data.songs))
    && (v.data.analysisCharts === undefined || Array.isArray(v.data.analysisCharts));
}
export function isS1Kind(kind: unknown): kind is S1Kind { return (S1_KINDS as readonly unknown[]).includes(kind); }

// Preserve UMD scalar values across a plain DTO wire boundary.
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
