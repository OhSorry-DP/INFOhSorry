<#
.SYNOPSIS
  INFINITAS(bm2dx.exe) 새 빌드의 메모리 offset 을 읽기 전용으로 찾는다.

.DESCRIPTION
  절차 전체는 docs/offset-update-runbook.md 를 따른다. 이 스크립트는 그 중 "찾기" 단계만 맡는다.
  게임 메모리에 쓰지 않는다 (OpenProcess PROCESS_VM_READ|QUERY 만 사용).
  주소는 Reflux offsets.txt 와 같은 기준(선호 베이스 0x140000000 가정 절대주소)으로 출력한다.

  모드 (여러 개 동시에 지정 가능):
    -Static   빌드 datecode, songList, unlockdata, datamap, playSettings(레인 배열 서명)
    -Profile  djName, iidxId, DJ POINT, dan, radar  (화면에 보이는 값을 인자로 준다)
    -Play     judgeData, currentsong, playData, 레인별 판정 블록  (한 판 친 뒤 결과 화면에서, 화면 수치를 인자로 준다)

.EXAMPLE
  # 1) 게임 선곡 화면(옵션 전부 OFF, 방금 켠 상태)에서
  powershell -ExecutionPolicy Bypass -File tools\scan\find-offsets.ps1 -Static

  # 2) 프로필 화면 값으로
  powershell -ExecutionPolicy Bypass -File tools\scan\find-offsets.ps1 -Profile -DjName GROM -IidxId C2000-7477-7849 `
    -SpDan -1 -DpDan 16 -SpPoint 14130 -DpPoint 45149 `
    -Radar 9419,11012,9346,11766,9716,13303,7974,12659,11569,13889,10083,12777

  # 3) 한 판 치고 결과 화면에서 (DP 는 화면의 합계 수치 그대로)
  powershell -ExecutionPolicy Bypass -File tools\scan\find-offsets.ps1 -Play -SongId 11015 -Notes 1288 `
    -Pg 663 -Gr 287 -Gd 209 -Bd 18 -Poor 103 -ComboBreak 99 -Fast 105 -Slow 391 -Ex 1613
#>
param(
  [switch]$Static,
  [switch]$Profile,
  [switch]$Play,
  # 직전 빌드 offsets.txt (datamap 검색 창 기준 + 이동폭 표시). 기본: Reflux 작업 폴더의 offsets.txt
  [string]$PrevOffsets = (Join-Path $env:APPDATA 'ohSorryScoreINF\Reflux\offsets.txt'),
  # Profile
  [string]$DjName, [string]$IidxId,
  [int]$SpDan = -1, [int]$DpDan = -1, [int]$SpPoint = -1, [int]$DpPoint = -1,
  [string]$Radar,   # 쉼표 구분 12개 (SP,DP 쌍이 축 순서대로: notes,peak,scratch,soflan,charge,chord) x100 정수
  # Play (화면 수치. DP 는 1P+2P 합계 그대로 넣는다)
  [int]$SongId, [int]$Notes, [int]$Ex = -1,
  [int]$Pg, [int]$Gr, [int]$Gd, [int]$Bd, [int]$Poor,
  [int]$ComboBreak, [int]$Fast, [int]$Slow
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if (-not ($Static -or $Profile -or $Play)) { throw '모드를 하나 이상 지정하세요: -Static / -Profile / -Play' }

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class OffScan {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool b, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] buf, IntPtr n, out IntPtr r);
  public byte[] Mem; public int Size;
  public void Load(int pid, long baseAddr, int size) {
    Size = size; Mem = new byte[size];
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) throw new Exception("OpenProcess 실패 (관리자 권한/보호 프로세스 확인)");
    int C = 4 << 20;
    for (int off = 0; off < size; off += C) {
      int n = Math.Min(C, size - off); byte[] b = new byte[n]; IntPtr r;
      if (ReadProcessMemory(h, (IntPtr)(baseAddr + off), b, (IntPtr)n, out r)) Buffer.BlockCopy(b, 0, Mem, off, (int)r);
    }
    CloseHandle(h);
  }
  public int I(int o) { return BitConverter.ToInt32(Mem, o); }
  public List<int> Bytes(byte[] pat) {
    List<int> res = new List<int>(); int last = Size - pat.Length; byte f = pat[0];
    for (int i = Array.IndexOf(Mem, f, 0); i >= 0 && i <= last; i = Array.IndexOf(Mem, f, i + 1)) {
      int j = 1; while (j < pat.Length && Mem[i + j] == pat[j]) j++;
      if (j == pat.Length) res.Add(i);
    }
    return res;
  }
  public List<int> Ints(int[] p) {
    byte[] b = new byte[p.Length * 4];
    for (int i = 0; i < p.Length; i++) BitConverter.GetBytes(p[i]).CopyTo(b, i * 4);
    return Bytes(b);
  }
  // judgeData 16워드 창: 쪽별 블록(P1 0..4, P2 5..9)의 합이 화면 합계와 같은 위치.
  //   s = { pg, gr, gd, bd, poor, comboBreak, fast, slow }
  public List<int> Judge(int[] s) {
    List<int> res = new List<int>();
    for (int i = 0; i + 64 <= Size; i += 4) {
      if (I(i) + I(i + 20) != s[0]) continue;
      if (I(i + 4) + I(i + 24) != s[1]) continue;
      if (I(i + 8) + I(i + 28) != s[2]) continue;
      if (I(i + 12) + I(i + 32) != s[3]) continue;
      if (I(i + 16) + I(i + 36) != s[4]) continue;
      if (I(i + 40) + I(i + 44) != s[5]) continue;
      if (I(i + 48) + I(i + 52) != s[6]) continue;
      if (I(i + 56) + I(i + 60) != s[7]) continue;
      res.Add(i);
    }
    return res;
  }
  // 레인 블록: lanes 개 x 6칸([PG,GR,GD,BAD,POOR,공POOR]) 의 열 합이 t = {pg,gr,gd,bd,poor+공poor} 와 같은 위치
  public List<int> Lane(int[] t, int lanes) {
    List<int> res = new List<int>(); int blk = lanes * 24;
    for (int i = 0; i + blk <= Size; i += 4) {
      int s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
      for (int k = 0; k < lanes; k++) {
        int o = i + k * 24;
        s0 += I(o); s1 += I(o + 4); s2 += I(o + 8); s3 += I(o + 12); s4 += I(o + 16) + I(o + 20);
        if (s0 > t[0] || s1 > t[1] || s2 > t[2]) break;
      }
      if (s0 == t[0] && s1 == t[1] && s2 == t[2] && s3 == t[3] && s4 == t[4]) res.Add(i);
    }
    return res;
  }
}
"@

$PREF = 0x140000000L
function Hex($v) { '0x{0:X}' -f $v }
function Abs($off) { $PREF + [int64]$off }

$proc = Get-Process bm2dx -ErrorAction Stop | Select-Object -First 1
$base = [int64]$proc.MainModule.BaseAddress
$size = [int]$proc.MainModule.ModuleMemorySize
Write-Output ("bm2dx pid={0} base={1} size={2}" -f $proc.Id, (Hex $base), (Hex $size))
if ($base -ne $PREF) { Write-Warning "모듈 베이스가 선호 베이스와 다릅니다(ASLR). 출력 주소는 선호 베이스 기준으로 환산했습니다." }
$sc = New-Object OffScan
Write-Output '메모리 읽는 중...'
$sc.Load($proc.Id, $base, $size)

# 직전 빌드 offsets.txt
$prev = @{}
if (Test-Path $PrevOffsets) {
  foreach ($line in Get-Content $PrevOffsets) {
    if ($line -match '^\s*(\w+)\s*=\s*(0x[0-9A-Fa-f]+)') { $prev[$Matches[1]] = [Convert]::ToInt64($Matches[2], 16) }
  }
  Write-Output ("직전 offsets: {0} ({1}개 키)" -f $PrevOffsets, $prev.Count)
}
$found = [ordered]@{}   # offsets.txt 키 -> 절대주소
function Report($key, $addr, $note) {
  $found[$key] = $addr
  $d = ''
  if ($prev.ContainsKey($key)) { $dv = $addr - $prev[$key]; $d = '  (직전 대비 ' + $(if ($dv -ge 0) { '+' } else { '-' }) + ('0x{0:X}' -f [math]::Abs($dv)) + ')' }
  Write-Output ("  [{0}] {1}{2}  {3}" -f $key, (Hex $addr), $d, $note)
}
function IntsAt($off, $n) { ,@(0..($n - 1) | ForEach-Object { $sc.I($off + 4 * $_) }) }

# ---------------------------------------------------------------- Static
if ($Static) {
  Write-Output '== STATIC'
  # 빌드 datecode: 모듈 안에 옛 빌드 문자열이 여럿 있으므로 가장 큰 값을 고른다 (gameBuild.ts 와 같은 규칙)
  $best = ''
  foreach ($o in $sc.Bytes([Text.Encoding]::ASCII.GetBytes('P2D:J:B:A:'))) {
    $s = [Text.Encoding]::ASCII.GetString($sc.Mem, $o, 20)
    if ($s -match '^P2D:J:B:A:\d{10}$' -and $s -gt $best) { $best = $s }
  }
  Write-Output "  build datecode: $best"

  # songList: "5.1.1." UTF-16 제목이 곡 엔트리 시작. +0x5b0 의 곡 ID 가 1000 이어야 한다.
  #   (Reflux OffsetSearcher 의 ASCII "5.1.1." 매치는 title2 라서 엔트리 시작보다 0x100 뒤다.)
  $song = @($sc.Bytes([Text.Encoding]::Unicode.GetBytes('5.1.1.')) | Where-Object { $sc.I($_ + 0x5b0) -eq 1000 })
  if ($song.Count -ge 1) { Report 'songList' (Abs $song[0]) ("(곡 ID 1000 확인, 후보 $($song.Count)개)") } else { Write-Warning 'songList 못 찾음' }

  # unlockdata: [1000, 1, 462] (Reflux OffsetSearcher)
  $unl = @($sc.Ints(@(1000, 1, 462)))
  if ($unl.Count -ge 1) { Report 'unlockdata' (Abs $unl[0]) ("(후보 $($unl.Count)개)") } else { Write-Warning 'unlockdata 못 찾음' }

  # datamap: [0x7FFF, 0] 의 24바이트 앞. 매치가 매우 많아서 직전 offset - 2MB 이후 첫 매치를 쓴다 (Reflux 검색 창 규칙).
  $dm = @($sc.Ints(@(0x7FFF, 0)))
  if ($prev.ContainsKey('datamap')) {
    $lo = $prev['datamap'] - 2000000
    $pick = @($dm | Where-Object { (Abs $_) -ge $lo } | Select-Object -First 1)
    if ($pick.Count -eq 1) { Report 'datamap' ((Abs $pick[0]) - 24) '(직전 offset-2MB 이후 첫 매치 -24)' } else { Write-Warning 'datamap 못 찾음' }
  } else {
    Write-Warning ("datamap: 직전 offsets.txt 가 없어 창을 못 정함. 매치 {0}개 (앞 5개: {1})" -f $dm.Count, (($dm | Select-Object -First 5 | ForEach-Object { Hex ((Abs $_) - 24) }) -join ' '))
  }

  # playSettings: 레인 배열(P1 +0x37CC, P2 +0x37EC)이 정배 0..7 x2 로 이어진 곳. 한 번도 랜덤으로 안 친 상태(게임 막 켠 직후)에서만 유일하다.
  $lane = @($sc.Ints(@(0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7)))
  if ($lane.Count -eq 1) { Report 'playSettings' ((Abs $lane[0]) - 0x37CC) '(레인 배열 0..7,0..7 유일 매치 - 0x37CC)' }
  elseif ($lane.Count -eq 0) { Write-Warning 'playSettings: 레인 배열 정배 패턴 없음 - 랜덤 옵션으로 친 뒤라면 게임을 껐다 켜고 다시, 또는 Reflux 방식(옵션 패턴)으로 찾으세요' }
  else { Write-Warning ("playSettings: 매치 {0}개 - 유일하지 않음: {1}" -f $lane.Count, (($lane | ForEach-Object { Hex ((Abs $_) - 0x37CC) }) -join ' ')) }
}

# ---------------------------------------------------------------- Profile
if ($Profile) {
  Write-Output '== PROFILE'
  if ($DjName) {
    $m = @($sc.Bytes([Text.Encoding]::UTF8.GetBytes($DjName)))
    Write-Output ("  djName '{0}' 매치 {1}개: {2}" -f $DjName, $m.Count, (($m | Select-Object -First 8 | ForEach-Object { Hex $_ }) -join ' '))
  }
  if ($IidxId) {
    $id = ($IidxId -replace '-', '')
    $m = @($sc.Bytes([Text.Encoding]::ASCII.GetBytes($id)))
    Write-Output ("  iidxId '{0}' 매치 {1}개: {2}" -f $id, $m.Count, (($m | Select-Object -First 8 | ForEach-Object { Hex $_ }) -join ' '))
  }
  Write-Output '  (위 값은 모듈 상대 offset. djName 과 iidxId 는 14바이트 간격(iidxId+0xE=djName)으로 붙어 있는 쌍을 고른다)'
  if ($SpPoint -ge 0 -and $DpPoint -ge 0) {
    $m = @($sc.Ints(@($SpPoint, $DpPoint, $SpDan, $DpDan)))
    Write-Output ("  [DJ POINT sp,dp + dan sp,dp] 매치 {0}개: {1}" -f $m.Count, (($m | ForEach-Object { 'djpoint=' + (Hex $_) + ' dan=' + (Hex ($_ + 8)) }) -join ' | '))
  } elseif ($SpDan -ne -1 -or $DpDan -ne -1) {
    $m = @($sc.Ints(@($SpDan, $DpDan)))
    Write-Output ("  [dan sp,dp] 매치 {0}개 (너무 많으면 -SpPoint/-DpPoint 도 주세요): {1}" -f $m.Count, (($m | Select-Object -First 8 | ForEach-Object { Hex $_ }) -join ' '))
  }
  $radarInts = @(); if ($Radar) { $radarInts = @($Radar -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [int]$_ }) }
  if ($radarInts.Count -eq 12) {
    # 배치: [SP,DP] 쌍이 축마다 연속. 축 순서 notes, peak, scratch, soflan, charge, chord. 값은 x100 정수.
    $m = @($sc.Ints([int[]]$radarInts))
    Write-Output ("  [radar 12] 매치 {0}개: {1}" -f $m.Count, (($m | ForEach-Object { Hex $_ }) -join ' '))
  }
  Write-Output '  profile 은 offsets.txt 키가 아니라 gist/코드 상수의 profile 항목이다(모듈 상대 offset).'
}

# ---------------------------------------------------------------- Play
if ($Play) {
  Write-Output '== PLAY'
  foreach ($n in 'SongId', 'Notes', 'Pg', 'Gr', 'Gd', 'Bd', 'Poor', 'ComboBreak', 'Fast', 'Slow') {
    if (-not $PSBoundParameters.ContainsKey($n)) { throw "-Play 에는 -$n 이 필요합니다" }
  }
  $j = @($sc.Judge(@($Pg, $Gr, $Gd, $Bd, $Poor, $ComboBreak, $Fast, $Slow)))
  if ($j.Count -eq 0) { Write-Warning 'judgeData 못 찾음 - 결과 화면에서 나가지 않았는지, 수치 입력이 맞는지 확인'; }
  else {
    if ($j.Count -gt 1) { Write-Warning ("judgeData 후보 {0}개: {1} - 첫 번째 사용" -f $j.Count, (($j | ForEach-Object { Hex (Abs $_) }) -join ' ')) }
    $jo = $j[0]
    Report 'judgeData' (Abs $jo) ('judge16 = ' + ((IntsAt $jo 16) -join ' '))

    # currentsong: [곡ID, 스타일 안 난이도, ?, ?, 노트 수]. judgeData 가까이(±64KB)에서 가장 가까운 것.
    $cs = @($sc.Ints(@($SongId)) | Where-Object { $sc.I($_ + 16) -eq $Notes -and [math]::Abs($_ - $jo) -lt 0x10000 } | Sort-Object { [math]::Abs($_ - $jo) })
    if ($cs.Count -ge 1) { Report 'currentsong' (Abs $cs[0]) ("words=" + ((IntsAt $cs[0] 5) -join ' ') + " (judge+" + (Hex ($cs[0] - $jo)) + ")") }
    else { Write-Warning 'currentsong 못 찾음 (-SongId/-Notes 확인. 배틀은 노트 수가 차트의 2배)' }

    # playData: [곡ID, 난이도, EX, 미스, PG, GREAT, 램프, ...]. 배틀·속도 변경 판은 비어 있을 수 있다.
    if ($Ex -ge 0) {
      $pd = @($sc.Ints(@($SongId)) | Where-Object { $sc.I($_ + 8) -eq $Ex -and $sc.I($_ + 16) -eq $Pg -and $sc.I($_ + 20) -eq $Gr })
      if ($pd.Count -ge 1) { Report 'playData' (Abs $pd[0]) ("words=" + ((IntsAt $pd[0] 8) -join ' ')) }
      else { Write-Warning 'playData 못 찾음 - 배틀/속도 변경 판은 비어 있음. 일반 판(속도 1.00, 배틀 OFF)으로 다시, 또는 playSettings+0x2B0 으로 추정 후 검증' }
    } else { Write-Warning 'playData: -Ex 를 주면 찾습니다 (일반 판에서만 채워짐)' }

    # 레인별 판정 블록: 쪽별 열 합으로 찾는다. 8번째 레인은 0 이라 7레인 검색이 우선.
    $w = IntsAt $jo 10
    $sides = @(@('P1', @($w[0], $w[1], $w[2], $w[3], $w[4])), @('P2', @($w[5], $w[6], $w[7], $w[8], $w[9])))
    foreach ($s in $sides) {
      if (($s[1] | Measure-Object -Sum).Sum -eq 0) { Write-Output ("  lane {0}: 이 쪽 판정이 0 이라 건너뜀" -f $s[0]); continue }
      $hit = @($sc.Lane([int[]]$s[1], 7))
      if ($hit.Count -eq 0) { $hit = @($sc.Lane([int[]]$s[1], 8)) }
      if ($hit.Count -eq 0) { Write-Warning ("lane {0}: 못 찾음" -f $s[0]); continue }
      foreach ($h in $hit) {
        $words = ($h - $jo) / 4
        Write-Output ("  lane {0}: {1}  judgeData 기준 {2} words  (후보 {3}개)" -f $s[0], (Hex (Abs $h)), $words, $hit.Count)
      }
    }
    Write-Output '  -> src/main/playDetail.ts 의 laneWordsP1 / laneWordsP2 에 위 words 값을 넣는다 (7레인 검색 결과 우선).'
  }
}

# ---------------------------------------------------------------- 요약
if ($found.Count -gt 0) {
  Write-Output ''
  Write-Output '== offsets.txt 형식 (찾은 키만)'
  foreach ($k in $found.Keys) { Write-Output ("{0} = {1}" -f $k, ('0x{0:X}' -f $found[$k])) }
  Write-Output '(playData/currentsong/judgeData/playSettings 등 못 찾은 키는 위 경고를 보고 별도 방법으로 채운다)'
}
