import koffi from 'koffi';
import type { ElevationStatus } from './adminGate';

// Loaded lazily by the startup gate so binding/load failures are fail-open.
// No child process, shell, network request, or polling is involved.
export function probeCurrentProcessElevation(): ElevationStatus {
  if (process.platform !== 'win32') return 'unknown';
  try {
    const kernel32 = koffi.load('kernel32.dll');
    const advapi32 = koffi.load('advapi32.dll');
    const getCurrentProcess = kernel32.func('void* __stdcall GetCurrentProcess()');
    const closeHandle = kernel32.func('int __stdcall CloseHandle(void* handle)');
    const openProcessToken = advapi32.func(
      'int __stdcall OpenProcessToken(void* process, uint32_t access, _Out_ void** token)',
    );
    const getTokenInformation = advapi32.func(
      'int __stdcall GetTokenInformation(void* token, int infoClass, _Out_ void* info, uint32_t size, _Out_ uint32_t* returnedSize)',
    );
    const token: unknown[] = [null];
    const TOKEN_QUERY = 0x0008;
    const TokenElevation = 20;
    if (!openProcessToken(getCurrentProcess(), TOKEN_QUERY, token) || !token[0]) return 'unknown';
    try {
      const elevation = Buffer.alloc(4);
      const returnedSize = [0];
      if (!getTokenInformation(token[0], TokenElevation, elevation, elevation.length, returnedSize)
        || returnedSize[0] !== elevation.length) return 'unknown';
      return elevation.readUInt32LE(0) !== 0 ? 'elevated' : 'not-elevated';
    } finally {
      closeHandle(token[0]);
    }
  } catch {
    return 'unknown';
  }
}
