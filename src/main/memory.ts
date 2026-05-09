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
import iconv from 'iconv-lite';

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

// 프로세스의 모든 로드된 모듈 (.exe + 모든 DLL) 정보
export interface ModuleInfo {
  base: bigint;
  size: number;
  name: string; // e.g., "bm2dx.exe", "kernel32.dll", "acsl.dll"
}
export function listAllModules(pid: number): ModuleInfo[] {
  const out: ModuleInfo[] = [];
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
  if (isInvalidHandle(snap)) return out;
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
    let ok = Module32FirstW(snap, me);
    while (ok) {
      const name = utf16ToString(me.szModule);
      const base =
        typeof me.modBaseAddr === 'bigint' ? me.modBaseAddr : BigInt(me.modBaseAddr);
      out.push({ base, size: me.modBaseSize, name });
      ok = Module32NextW(snap, me);
    }
  } finally {
    CloseHandle(snap);
  }
  return out;
}
// 주어진 주소가 어떤 모듈 안에 있는지 찾기
export function findModuleContaining(modules: ModuleInfo[], addr: bigint): ModuleInfo | null {
  for (const m of modules) {
    if (addr >= m.base && addr < m.base + BigInt(m.size)) return m;
  }
  return null;
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

// ============================================================
// 메모리 스캔 — VirtualQueryEx 로 commit 된 region enumerate 후
// chunk 단위로 읽으면서 byte pattern 검색
// ============================================================

// VirtualQueryEx 반환 구조체
const MEMORY_BASIC_INFORMATION = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'uintptr_t',
  AllocationBase: 'uintptr_t',
  AllocationProtect: 'uint32_t',
  PartitionId: 'uint16_t',
  __pad: 'uint16_t', // 패딩 (size_t 정렬)
  RegionSize: 'size_t',
  State: 'uint32_t',
  Protect: 'uint32_t',
  Type: 'uint32_t',
});

const VirtualQueryEx = kernel32.func(
  'size_t __stdcall VirtualQueryEx(void* hProcess, uintptr_t lpAddress, _Out_ MEMORY_BASIC_INFORMATION *lpBuffer, size_t dwLength)',
);

const MEM_COMMIT = 0x1000;
const PAGE_GUARD = 0x100;
const PAGE_NOACCESS = 0x01;
// 읽기 가능한 protect flags (READONLY/READWRITE/EXECUTE_READ/EXECUTE_READWRITE/WRITECOPY/EXECUTE_WRITECOPY)
const READABLE_MASK = 0x02 | 0x04 | 0x20 | 0x40 | 0x08 | 0x80;

export interface MemoryRegion {
  base: bigint;
  size: number;
  protect: number;
}

// 프로세스의 commit 된 + 읽기 가능한 메모리 영역 enum (userland 만)
export function listMemoryRegions(handle: unknown): MemoryRegion[] {
  const regions: MemoryRegion[] = [];
  // x64 userland 상한 — 실제로는 0x7FFE_0000 부근까지 들어가지만 충분히 크게.
  const MAX_ADDR = 0x7fff_ffff_0000n;
  let addr: bigint = 0n;
  const mbi: {
    BaseAddress: bigint | number;
    AllocationBase: bigint | number;
    AllocationProtect: number;
    PartitionId: number;
    __pad: number;
    RegionSize: number;
    State: number;
    Protect: number;
    Type: number;
  } = {
    BaseAddress: 0n,
    AllocationBase: 0n,
    AllocationProtect: 0,
    PartitionId: 0,
    __pad: 0,
    RegionSize: 0,
    State: 0,
    Protect: 0,
    Type: 0,
  };
  const mbiSize = koffi.sizeof(MEMORY_BASIC_INFORMATION);
  while (addr < MAX_ADDR) {
    const ret = VirtualQueryEx(handle, addr, mbi, mbiSize);
    if (!ret || ret === 0) break;
    const baseN =
      typeof mbi.BaseAddress === 'bigint' ? mbi.BaseAddress : BigInt(mbi.BaseAddress);
    const size = mbi.RegionSize;
    const protect = mbi.Protect;
    const isCommit = mbi.State === MEM_COMMIT;
    const readable = (protect & READABLE_MASK) !== 0;
    const blocked = (protect & PAGE_GUARD) !== 0 || (protect & PAGE_NOACCESS) !== 0;
    if (isCommit && readable && !blocked) {
      regions.push({ base: baseN, size, protect });
    }
    const next = baseN + BigInt(size);
    if (next <= addr) break; // 안전망 (무한 루프 방지)
    addr = next;
  }
  return regions;
}

// 패턴 (Buffer) 을 프로세스 메모리 전체에서 찾아 모든 매칭 절대 주소 반환.
// maxMatches: 매칭 너무 많을 때 cut-off (기본 200, 너무 많으면 false-positive 추측 부담)
export function scanForBytes(
  handle: unknown,
  pattern: Buffer,
  maxMatches: number = 200,
): bigint[] {
  const matches: bigint[] = [];
  if (pattern.length === 0) return matches;
  const regions = listMemoryRegions(handle);
  const CHUNK = 4 * 1024 * 1024; // 4 MB
  outer: for (const r of regions) {
    let offset = 0;
    while (offset < r.size) {
      const readSize = Math.min(CHUNK, r.size - offset);
      let buf: Buffer;
      try {
        buf = readBytes(handle, r.base + BigInt(offset), readSize);
      } catch {
        // 일부 region 은 ReadProcessMemory 가 실패 — skip
        break;
      }
      // 청크 경계에 패턴이 걸치는 경우 대비 — 다음 청크 첫 (pattern.length-1) 바이트와 겹치게 읽음
      // (이 단순 구현은 그 처리는 안 함 — 4MB chunk 이고 패턴 < 100 바이트라 false negative 확률 낮음)
      let idx = 0;
      while (idx < buf.length) {
        const found = buf.indexOf(pattern, idx);
        if (found < 0) break;
        matches.push(r.base + BigInt(offset + found));
        if (matches.length >= maxMatches) break outer;
        idx = found + 1;
      }
      offset += readSize;
    }
  }
  return matches;
}

// 지원 인코딩: utf16le (Windows 표준 wide), utf8 (모던 UTF), ascii (Latin-1 호환), shiftjis (일본어, IIDX 의 한자)
export type StringEncoding = 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';

export function encodeString(text: string, enc: StringEncoding): Buffer {
  if (enc === 'utf16le') return Buffer.from(text, 'utf16le');
  if (enc === 'utf8') return Buffer.from(text, 'utf8');
  if (enc === 'ascii') return Buffer.from(text, 'ascii');
  // shiftjis — iconv-lite 로 인코딩 (한자 / 가나)
  return iconv.encode(text, 'shift_jis');
}

export function decodeString(buf: Buffer, enc: StringEncoding): string {
  if (enc === 'utf16le') {
    let s = '';
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const c = buf.readUInt16LE(i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  // 1바이트 단위 — null terminate
  const end = buf.indexOf(0);
  const slice = end >= 0 ? buf.subarray(0, end) : buf;
  if (enc === 'utf8') return slice.toString('utf8');
  if (enc === 'ascii') return slice.toString('ascii');
  // shiftjis
  return iconv.decode(slice, 'shift_jis');
}

// 패턴을 여러 인코딩으로 시도해서 하나라도 매칭되는 모든 주소 반환.
// 각 인코딩별 매칭 그룹화해서 반환.
export interface ScanResult {
  encoding: StringEncoding;
  pattern: Buffer; // 인코딩된 바이트 (디버그/검증용)
  matches: bigint[];
}

export function scanString(
  handle: unknown,
  text: string,
  encodings: StringEncoding[] = ['utf16le', 'utf8', 'ascii', 'shiftjis'],
  maxMatches: number = 200,
): ScanResult[] {
  const out: ScanResult[] = [];
  for (const enc of encodings) {
    let pattern: Buffer;
    try {
      pattern = encodeString(text, enc);
    } catch {
      continue;
    }
    if (pattern.length === 0) continue;
    const matches = scanForBytes(handle, pattern, maxMatches);
    out.push({ encoding: enc, pattern, matches });
  }
  return out;
}

// 특정 범위 [targetMin, targetMax] 의 64-bit pointer 들을 정적 메모리 안에서 찾기.
// 8-byte aligned 위치만 검사 (정상적인 컴파일러는 pointer 를 8-byte 정렬).
// 반환: { ptrAddr, targetValue } — pointer 가 위치한 절대 주소 + 그 pointer 가 가리키는 값.
//
// 직접 매칭 (target == X) 이 없을 때 "struct base + offset" 패턴 찾는데 씀:
// targetValue 가 우리 string 보다 약간 앞이면, 그게 struct base 일 가능성 높음.
// valueOffset = string_addr - targetValue 가 struct 안에서의 string 위치.
export function scanForPointersInRange(
  handle: unknown,
  regionBase: bigint,
  regionSize: number,
  targetMin: bigint,
  targetMax: bigint,
  maxMatches: number = 50,
): { ptrAddr: bigint; targetValue: bigint }[] {
  const matches: { ptrAddr: bigint; targetValue: bigint }[] = [];
  const CHUNK = 4 * 1024 * 1024;
  let offset = 0;
  while (offset < regionSize) {
    const readSize = Math.min(CHUNK, regionSize - offset);
    let buf: Buffer;
    try {
      buf = readBytes(handle, regionBase + BigInt(offset), readSize);
    } catch {
      break;
    }
    for (let i = 0; i + 7 < buf.length; i += 8) {
      const value = buf.readBigUInt64LE(i);
      if (value >= targetMin && value <= targetMax) {
        matches.push({
          ptrAddr: regionBase + BigInt(offset + i),
          targetValue: value,
        });
        if (matches.length >= maxMatches) return matches;
      }
    }
    offset += readSize;
  }
  return matches;
}

// 특정 메모리 region 안에서 64-bit pointer (= target 값) 인 모든 위치 반환.
// 보통 정적 메모리 (modBase ~ modBase+modSize) 안에서 heap 주소를 찾을 때 쓰임.
export function scanForPointer(
  handle: unknown,
  regionBase: bigint,
  regionSize: number,
  target: bigint,
  maxMatches: number = 100,
): bigint[] {
  const matches: bigint[] = [];
  // target 을 8바이트 LE 로 인코딩
  const pat = Buffer.alloc(8);
  pat.writeBigUInt64LE(target, 0);
  const CHUNK = 4 * 1024 * 1024;
  let offset = 0;
  while (offset < regionSize) {
    const readSize = Math.min(CHUNK, regionSize - offset);
    let buf: Buffer;
    try {
      buf = readBytes(handle, regionBase + BigInt(offset), readSize);
    } catch {
      break;
    }
    let idx = 0;
    while (idx < buf.length - 7) {
      const found = buf.indexOf(pat, idx);
      if (found < 0) break;
      // 8바이트 정렬 권장 (대부분의 컴파일러는 pointer 를 8 바이트 정렬)
      // 정렬 안 된 매치도 일단 포함 (필요 시 필터)
      matches.push(regionBase + BigInt(offset + found));
      if (matches.length >= maxMatches) return matches;
      idx = found + 1;
    }
    offset += readSize;
  }
  return matches;
}
