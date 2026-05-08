// koffi 로 Win32 API 호출해서 INFINITAS 프로세스에 attach + 메모리 읽기
//
// memoryjs 와 다르게 prebuild 가 있어서 빌드 도구 불필요하지만,
// Process32First/Module32First 를 직접 호출해야 해서 약간의 ceremony 가 있음
//
// 핵심 흐름:
//   1. CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS) → 모든 프로세스 enum
//   2. exe 이름 일치하는 프로세스의 PID 획득
//   3. OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid) → handle
//   4. CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid) → main 모듈의 base 주소 획득
//   5. ReadProcessMemory(handle, base + offset, ...) 로 값 읽기
import koffi from 'koffi';

// ----- Win32 상수 -----
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_INFORMATION = 0x0400;
const TH32CS_SNAPPROCESS = 0x00000002;
const TH32CS_SNAPMODULE = 0x00000008;
const TH32CS_SNAPMODULE32 = 0x00000010;
const INVALID_HANDLE_VALUE = -1n; // (HANDLE)-1; koffi 에서 비교는 BigInt 또는 == -1
const MAX_PATH = 260;

// ----- 라이브러리 로드 -----
const kernel32 = koffi.load('kernel32.dll');

// ----- 구조체 정의 -----
// PROCESSENTRY32W (UTF-16 wide char). szExeFile 는 char16[260], 일부 koffi 버전은
// 'String' 어노테이션으로 자동 변환 가능하지만, 안전하게 array of uint16 로 받고 직접 디코드
const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32_t',
  cntUsage: 'uint32_t',
  th32ProcessID: 'uint32_t',
  th32DefaultHeapID: 'size_t',
  th32ModuleID: 'uint32_t',
  cntThreads: 'uint32_t',
  th32ParentProcessID: 'uint32_t',
  pcPriClassBase: 'int32_t',
  dwFlags: 'uint32_t',
  szExeFile: koffi.array('uint16_t', MAX_PATH),
});

// MODULEENTRY32W
const MODULEENTRY32W = koffi.struct('MODULEENTRY32W', {
  dwSize: 'uint32_t',
  th32ModuleID: 'uint32_t',
  th32ProcessID: 'uint32_t',
  GlblcntUsage: 'uint32_t',
  ProccntUsage: 'uint32_t',
  modBaseAddr: 'uintptr_t',
  modBaseSize: 'uint32_t',
  hModule: 'uintptr_t',
  szModule: koffi.array('uint16_t', 256),
  szExePath: koffi.array('uint16_t', MAX_PATH),
});

// ----- API 바인딩 -----
const CreateToolhelp32Snapshot = kernel32.func(
  'void* __stdcall CreateToolhelp32Snapshot(uint32_t dwFlags, uint32_t th32ProcessID)',
);
const Process32FirstW = kernel32.func(
  'int __stdcall Process32FirstW(void* hSnapshot, _Inout_ PROCESSENTRY32W *lppe)',
);
const Process32NextW = kernel32.func(
  'int __stdcall Process32NextW(void* hSnapshot, _Inout_ PROCESSENTRY32W *lppe)',
);
const Module32FirstW = kernel32.func(
  'int __stdcall Module32FirstW(void* hSnapshot, _Inout_ MODULEENTRY32W *lpme)',
);
const Module32NextW = kernel32.func(
  'int __stdcall Module32NextW(void* hSnapshot, _Inout_ MODULEENTRY32W *lpme)',
);
const OpenProcess = kernel32.func(
  'void* __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)',
);
const CloseHandle = kernel32.func('int __stdcall CloseHandle(void* hObject)');
const ReadProcessMemory = kernel32.func(
  'int __stdcall ReadProcessMemory(void* hProcess, uintptr_t lpBaseAddress, _Out_ void *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)',
);
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');

// ----- 헬퍼 -----
// UTF-16 null-terminated 배열 (uint16[]) → JS 문자열
function utf16ToString(arr: number[] | Uint16Array): string {
  let s = '';
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// koffi 가 반환하는 핸들이 -1 (INVALID_HANDLE_VALUE) 인지 확인
// 64-bit 환경에서 핸들은 BigInt 또는 number 로 올 수 있음
function isInvalidHandle(h: unknown): boolean {
  if (h == null) return true;
  if (typeof h === 'number') return h === -1 || h === 0;
  if (typeof h === 'bigint') return h === -1n || h === 0n;
  return false;
}

// ----- 공개 API -----
export interface InfinitasHandle {
  handle: unknown; // 닫을 때 CloseHandle 에 그대로 전달
  pid: number;
  modBaseAddr: bigint; // 64-bit 주소를 표현하기 위해 bigint
  modBaseSize: number;
  modName: string;
}

// 프로세스 enum 으로 exe 이름 일치하는 PID 찾기
// 반환: PID (대소문자 구분 X), 없으면 0
export function findProcessId(exeName: string): number {
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (isInvalidHandle(snap)) return 0;

  let foundPid = 0;
  try {
    const entry: { dwSize: number; th32ProcessID: number; szExeFile: number[] } = {
      dwSize: koffi.sizeof(PROCESSENTRY32W),
      cntUsage: 0,
      th32ProcessID: 0,
      th32DefaultHeapID: 0,
      th32ModuleID: 0,
      cntThreads: 0,
      th32ParentProcessID: 0,
      pcPriClassBase: 0,
      dwFlags: 0,
      szExeFile: new Array(MAX_PATH).fill(0),
    } as never;

    const target = exeName.toLowerCase();
    let ok = Process32FirstW(snap, entry);
    while (ok) {
      const name = utf16ToString(entry.szExeFile).toLowerCase();
      if (name === target) {
        foundPid = entry.th32ProcessID;
        break;
      }
      ok = Process32NextW(snap, entry);
    }
  } finally {
    CloseHandle(snap);
  }
  return foundPid;
}

// 프로세스의 주 모듈 (보통 .exe 자체) 의 base 주소 + 크기 획득
export function findMainModule(
  pid: number,
  exeName: string,
): { modBaseAddr: bigint; modBaseSize: number; modName: string } | null {
  // SNAPMODULE | SNAPMODULE32 → 32-bit / 64-bit 모두 (게임이 어떤 빌드든)
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
  if (isInvalidHandle(snap)) return null;

  try {
    const me: {
      dwSize: number;
      modBaseAddr: bigint | number;
      modBaseSize: number;
      szModule: number[];
    } = {
      dwSize: koffi.sizeof(MODULEENTRY32W),
      th32ModuleID: 0,
      th32ProcessID: 0,
      GlblcntUsage: 0,
      ProccntUsage: 0,
      modBaseAddr: 0,
      modBaseSize: 0,
      hModule: 0,
      szModule: new Array(256).fill(0),
      szExePath: new Array(MAX_PATH).fill(0),
    } as never;

    const target = exeName.toLowerCase();
    let ok = Module32FirstW(snap, me);
    while (ok) {
      const name = utf16ToString(me.szModule);
      if (name.toLowerCase() === target) {
        return {
          modBaseAddr: typeof me.modBaseAddr === 'bigint' ? me.modBaseAddr : BigInt(me.modBaseAddr),
          modBaseSize: me.modBaseSize,
          modName: name,
        };
      }
      ok = Module32NextW(snap, me);
    }
  } finally {
    CloseHandle(snap);
  }
  return null;
}

// 프로세스 핸들 열기 + 모듈 base 정보 함께 반환
export function findInfinitas(exeName: string): InfinitasHandle | null {
  const pid = findProcessId(exeName);
  if (!pid) return null;

  const handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid);
  if (isInvalidHandle(handle)) {
    const err = GetLastError();
    throw new Error(`OpenProcess 실패 (pid=${pid}, lastError=${err})`);
  }

  const mod = findMainModule(pid, exeName);
  if (!mod) {
    CloseHandle(handle);
    throw new Error(`주 모듈 "${exeName}" 못 찾음 (pid=${pid})`);
  }

  return {
    handle,
    pid,
    modBaseAddr: mod.modBaseAddr,
    modBaseSize: mod.modBaseSize,
    modName: mod.modName,
  };
}

// 메모리 읽기 — 임의의 바이트
// addr 는 절대 주소 (보통 modBaseAddr + offset). bigint 권장 (64-bit 주소 안전).
export function readBytes(handle: unknown, addr: bigint | number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  const bytesRead = [0]; // koffi 가 _Out_ 으로 size_t* 를 채워줌 (배열로 전달)
  const ok = ReadProcessMemory(handle, addr, buf, size, bytesRead);
  if (!ok) {
    const err = GetLastError();
    throw new Error(`ReadProcessMemory 실패 (addr=0x${addr.toString(16)}, lastError=${err})`);
  }
  return buf;
}

// 자주 쓰는 타입 헬퍼
export function readInt32(handle: unknown, addr: bigint | number): number {
  return readBytes(handle, addr, 4).readInt32LE(0);
}
export function readUint32(handle: unknown, addr: bigint | number): number {
  return readBytes(handle, addr, 4).readUInt32LE(0);
}
export function readFloat(handle: unknown, addr: bigint | number): number {
  return readBytes(handle, addr, 4).readFloatLE(0);
}
export function readDouble(handle: unknown, addr: bigint | number): number {
  return readBytes(handle, addr, 8).readDoubleLE(0);
}
export function readPointer(handle: unknown, addr: bigint | number): bigint {
  return readBytes(handle, addr, 8).readBigUInt64LE(0);
}
// null-terminated UTF-16 문자열 (Windows 표준)
export function readStringW(handle: unknown, addr: bigint | number, maxBytes = 512): string {
  const buf = readBytes(handle, addr, maxBytes);
  const codes: number[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = buf.readUInt16LE(i);
    if (c === 0) break;
    codes.push(c);
  }
  return String.fromCharCode(...codes);
}
// null-terminated UTF-8 / shift-jis 등 1바이트 문자열
export function readStringA(handle: unknown, addr: bigint | number, maxBytes = 256): Buffer {
  const buf = readBytes(handle, addr, maxBytes);
  const end = buf.indexOf(0);
  return end >= 0 ? buf.subarray(0, end) : buf;
}

// 핸들 닫기 (필수, 누수 방지)
export function closeHandle(handle: unknown): void {
  if (handle != null) CloseHandle(handle);
}
