param(
  [Parameter(Mandatory=$true)][string]$Addr,   # 시작 절대주소 (hex), 예 0x1425DD900
  [int]$Count = 32,                            # 읽을 int32 개수
  [string]$Tag = ""                            # 있으면 같은 폴더에 dump_<Tag>.txt 로 저장
)
# bm2dx.exe 메모리를 읽기 전용으로 int32 열로 덤프한다.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MemDump {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  public static byte[] Read(int pid, long addr, int len) {
    IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
    if (h == IntPtr.Zero) throw new Exception("OpenProcess 실패");
    try { byte[] b = new byte[len]; IntPtr rd; if (!ReadProcessMemory(h, (IntPtr)addr, b, (IntPtr)len, out rd)) throw new Exception("읽기 실패"); return b; }
    finally { CloseHandle(h); }
  }
}
"@
$proc = Get-Process bm2dx -ErrorAction Stop | Select-Object -First 1
$start = [Convert]::ToInt64($Addr.Replace('0x',''), 16)
$buf = [MemDump]::Read($proc.Id, $start, $Count * 4)
$lines = for ($i = 0; $i -lt $Count; $i++) {
  '0x{0:X}  {1}' -f ($start + $i * 4), [BitConverter]::ToInt32($buf, $i * 4)
}
if ($Tag) { $lines | Set-Content -Encoding utf8 (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "dump_$Tag.txt") }
$lines
