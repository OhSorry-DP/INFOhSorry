param(
  [Parameter(Mandatory=$true)][string]$P1,   # 화면에 보인 1P 배치, 예 4567231 (없으면 -)
  [Parameter(Mandatory=$true)][string]$P2,   # 화면에 보인 2P 배치, 예 3576142 (없으면 -)
  [Parameter(Mandatory=$true)][string]$Tag,  # 라운드 이름 (결과 파일 이름)
  [string]$OutDir = (Join-Path $PSScriptRoot "scan")
)
# bm2dx.exe 의 읽기 가능한 메모리 전체에서 레인 배치 순열을 여러 표현으로 찾는다 (읽기 전용).
# 사용: 결과 화면에서 멈춘 채로
#   powershell -ExecutionPolicy Bypass -File .\tools\scan-lanes.ps1 -P1 4567231 -P2 3576142 -Tag r1
# 결과는 tools\scan\<Tag>.tsv (라벨 · 절대주소 · 모듈 상대주소/heap)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class LaneScan {
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI { public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect; public uint __a; public IntPtr RegionSize; public uint State; public uint Protect; public uint Type; public uint __b; }
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI m, IntPtr len);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);

  // patterns[i] = 바이트 열, labels[i] = 이름
  public static List<string> Scan(int pid, List<byte[]> patterns, List<string> labels, long modBase, long modSize) {
    var hits = new List<string>();
    IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
    if (h == IntPtr.Zero) throw new Exception("OpenProcess 실패");
    try {
      long addr = 0; MBI m;
      int msz = Marshal.SizeOf(typeof(MBI));
      while (VirtualQueryEx(h, (IntPtr)addr, out m, (IntPtr)msz) != IntPtr.Zero) {
        long b = m.BaseAddress.ToInt64(); long sz = m.RegionSize.ToInt64();
        uint p = m.Protect;
        bool readable = m.State == 0x1000 && (p & 0x100) == 0 && (p & 0x01) == 0 &&
          ((p & 0x02) != 0 || (p & 0x04) != 0 || (p & 0x08) != 0 || (p & 0x20) != 0 || (p & 0x40) != 0 || (p & 0x80) != 0);
        if (readable && sz < (1L << 31)) {
          long off = 0; const int CH = 16 << 20; const int OV = 64;
          while (off < sz) {
            int len = (int)Math.Min(CH + OV, sz - off);
            byte[] buf = new byte[len]; IntPtr rd;
            if (ReadProcessMemory(h, (IntPtr)(b + off), buf, (IntPtr)len, out rd)) {
              int n = rd.ToInt32();
              for (int pi = 0; pi < patterns.Count; pi++) {
                byte[] pat = patterns[pi]; byte f = pat[0];
                int lim = Math.Min(n - pat.Length, CH - 1);
                for (int i = 0; i <= lim; i++) {
                  if (buf[i] != f) continue;
                  int k = 1; while (k < pat.Length && buf[i + k] == pat[k]) k++;
                  if (k == pat.Length) {
                    long a = b + off + i;
                    string rel = (a >= modBase && a < modBase + modSize) ? ("mod+0x" + (a - modBase).ToString("X")) : "heap";
                    hits.Add(labels[pi] + "\t0x" + a.ToString("X") + "\t" + rel);
                  }
                }
              }
            }
            off += CH;
          }
        }
        long next = b + sz; if (next <= addr) break; addr = next;
      }
    } finally { CloseHandle(h); }
    return hits;
  }
}
"@

$proc = Get-Process bm2dx -ErrorAction Stop | Select-Object -First 1
$mod = $proc.MainModule
$modBase = $mod.BaseAddress.ToInt64(); $modSize = [int64]$mod.ModuleMemorySize

function Inv([int[]]$v) { $r = New-Object int[] 7; for ($i = 0; $i -lt 7; $i++) { $r[$v[$i] - 1] = $i + 1 }; return ,$r }

$patterns = New-Object 'System.Collections.Generic.List[byte[]]'
$labels = New-Object 'System.Collections.Generic.List[string]'
foreach ($side in @(@('P1', $P1), @('P2', $P2))) {
  $name = $side[0]; $s = $side[1]
  if ($s -notmatch '^[1-7]{7}$') { continue }
  $v = [int[]]($s.ToCharArray() | ForEach-Object { [int][string]$_ })
  foreach ($form in @(@('fwd', $v), @('inv', (Inv $v)))) {
    foreach ($base in @(0, 1, 7, 8)) {   # 값 - 1 + base : 0기반, 1기반, 2P 7·8 시작
      $vals = $form[1] | ForEach-Object { $_ - 1 + $base }
      foreach ($stride in @(1, 2, 4)) {
        $bytes = New-Object byte[] (7 * $stride)
        for ($i = 0; $i -lt 7; $i++) { $bytes[$i * $stride] = [byte]$vals[$i] }
        $patterns.Add($bytes); $labels.Add("$name/$($form[0])/b$base/s$stride")
      }
    }
  }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$hits = [LaneScan]::Scan($proc.Id, $patterns, $labels, $modBase, $modSize)
$out = Join-Path $OutDir "$Tag.tsv"
$hits | Set-Content -Encoding utf8 $out
"pid=$($proc.Id) modBase=0x$($modBase.ToString('X')) hits=$($hits.Count) sec=$([math]::Round($sw.Elapsed.TotalSeconds,1)) -> $out"
$hits | ForEach-Object { ($_ -split "`t")[0] } | Group-Object | Sort-Object Count | Select-Object Count, Name | Format-Table -AutoSize | Out-String
