<#
Tracked P03 machine-wide test wrapper. See docs/machine-traps.md.
FIFO -Wait; JSON -Status; -Run argument arrays or -RunArgs for native launch.
Legacy one-string commands are supported. Failed launches keep their queue place.
Windows kill-on-close job and shared file locks cover the whole child tree.
#>
[CmdletBinding()]
param(
  [string]$Agent,
  [string]$Candidate,
  [double]$MinFreeCommitGB = 15.0,
  [switch]$Status,
  [string[]]$Run,
  [string[]]$RunArgs = @(),
  [switch]$Wait,
  [string]$LockDirectory = 'S:\orgtree\orgtree\artifacts\machine-test-run',
  [switch]$Enqueue,
  [switch]$Dequeue,
  [string]$Purpose,
  [int]$TtlMinutes = 60,
  [switch]$Small,
  [double]$SecondSlotMinGB = 12.0
)

$ErrorActionPreference = 'Stop'
$LockDir  = $LockDirectory
$LockPath = Join-Path $LockDir 'run.lock'
$Holder   = Join-Path $LockDir 'holder.json'
$Runs     = Join-Path $LockDir 'runs.jsonl'
New-Item -ItemType Directory -Force -Path $LockDir | Out-Null

function Get-BaselineRuns {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*test-baseline*' } |
    Select-Object -ExpandProperty ProcessId)
}
function Get-FreeCommitGB {
  [math]::Round((Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory / 1MB, 2)
}
function Enter-KillOnCloseJob {
  if (-not ('P03Run.Job' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace P03Run {
  public static class Forward {
    public static void Start(System.Diagnostics.Process process) {
      process.OutputDataReceived += (sender, e) => { if (e.Data != null) Console.Out.WriteLine(e.Data); };
      process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
      process.BeginOutputReadLine();
      process.BeginErrorReadLine();
    }
  }
  public static class Job {
    [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IO Io; public UIntPtr p1, p2, p3, p4; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    public static IntPtr Handle;
    public static void Enter() {
      Handle = CreateJobObject(IntPtr.Zero, null);
      if (Handle == IntPtr.Zero) throw new Exception("CreateJobObject failed " + Marshal.GetLastWin32Error());
      EXT info = new EXT(); info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(Handle, 9, ref info, (uint)Marshal.SizeOf(typeof(EXT)))) throw new Exception("SetInformationJobObject failed " + Marshal.GetLastWin32Error());
      if (!AssignProcessToJobObject(Handle, GetCurrentProcess())) throw new Exception("AssignProcessToJobObject failed " + Marshal.GetLastWin32Error());
    }
  }
}
'@
  }
  [P03Run.Job]::Enter()
}
function Test-LockFree {
  try { $h = [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None'); $h.Dispose(); return $true }
  catch [System.IO.IOException] { return $false }
}

# ---- priority queue (queue.json, guarded by queue.lock) ----
$QueuePath = Join-Path $LockDir 'queue.json'
$QueueLock = Join-Path $LockDir 'queue.lock'
function Invoke-WithQueueLock([scriptblock]$Body) {
  $deadline = (Get-Date).AddSeconds(15)
  while ($true) {
    try { $qh = [System.IO.File]::Open($QueueLock, 'OpenOrCreate', 'ReadWrite', 'None'); break }
    catch [System.IO.IOException] {
      if ((Get-Date) -gt $deadline) { throw 'p03-run: could not take queue.lock within 15 s' }
      Start-Sleep -Milliseconds 200
    }
  }
  try { & $Body } finally { $qh.Dispose() }
}
function Read-Queue {
  if (-not (Test-Path $QueuePath)) { return @() }
  $raw = (Get-Content $QueuePath -Raw)
  if (-not $raw -or -not $raw.Trim()) { return @() }
  $now = (Get-Date).ToUniversalTime()
  # PowerShell 5.1 ConvertFrom-Json emits a JSON array as ONE pipeline object;
  # foreach enumerates it into entries (a piped @() would nest it instead).
  $items = @()
  foreach ($x in (ConvertFrom-Json $raw)) {
    if ($x -and $x.agent -and ([datetime]::Parse($x.expires).ToUniversalTime() -gt $now)) { $items += $x }
  }
  $items   # unrolled; every caller wraps the call in @()
}
function Write-Queue($q) {
  $q = @($q | Where-Object { $_ })
  $json = if ($q.Count) { ConvertTo-Json -InputObject $q -Depth 4 } else { '[]' }
  Set-Content -Path $QueuePath -Value $json -Encoding utf8
}
function Format-Queue($q) {
  $q = @($q | Where-Object { $_ })
  if (-not $q.Count) { return '(empty)' }
  $i = 0
  ($q | ForEach-Object { $i++; "$i. $($_.agent) $($_.candidate) - $($_.purpose) (expires $($_.expires))" }) -join "`n                 "
}

if ($Enqueue) {
  if (-not $Agent -or -not $Purpose) { Write-Error 'p03-run: -Enqueue needs -Agent and -Purpose'; exit 64 }
  Invoke-WithQueueLock {
    $q = @(Read-Queue)
    $q += [pscustomobject]@{ id = [guid]::NewGuid().ToString(); agent = $Agent; candidate = $Candidate; purpose = $Purpose;
                             added = (Get-Date).ToUniversalTime().ToString('o');
                             expires = (Get-Date).ToUniversalTime().AddMinutes($TtlMinutes).ToString('o') }
    Write-Queue $q
    "queue:           " + (Format-Queue $q)
  }
  exit 0
}
if ($Dequeue) {
  if (-not $Agent) { Write-Error 'p03-run: -Dequeue needs -Agent'; exit 64 }
  Invoke-WithQueueLock {
    $q = @(Read-Queue | Where-Object { $_.agent -ne $Agent })
    Write-Queue $q
    "queue:           " + (Format-Queue $q)
  }
  exit 0
}


# ---- two slots (coordinator ruling L1, 2026-09-25 15:37Z) ----
# Slot 1 = run.lock (holder.json), slot 2 = run2.lock (holder2.json).
# A HEAVY run (the default) must hold BOTH slots, so it is exclusive exactly as
# before. A -Small run takes slot 1 if free; otherwise slot 2, but only when the
# slot-1 holder itself declared small:true AND free commit is at least
# -SecondSlotMinGB (checked by this wrapper at admission). A holder written by an
# older wrapper has no small field and therefore counts as heavy.
$LockPath2 = Join-Path $LockDir 'run2.lock'
$Holder2   = Join-Path $LockDir 'holder2.json'
function Test-SlotFree([string]$p) {
  try { $h = [System.IO.File]::Open($p, 'OpenOrCreate', 'ReadWrite', 'None'); $h.Dispose(); return $true }
  catch [System.IO.IOException] { return $false }
}
function Open-Slot([string]$p) {
  try { return [System.IO.File]::Open($p, 'OpenOrCreate', 'ReadWrite', 'None') }
  catch [System.IO.IOException] { return $null }
}
function Read-HolderText([string]$p) { if (Test-Path $p) { (Get-Content $p -Raw).Trim() } else { '(none)' } }
# HOLDER FILES ARE HISTORY, THE LOCK FILE IS THE TRUTH (coordinator 2026-09-26
# 14:20Z: holder2.json kept naming a 12:23Z run for 2 h while run2.lock was
# free). A clean release stamps "released" into the holder file; a killed
# wrapper cannot, so the reader also checks whether the holder pid is alive.
# Describe-Slot is the only way a holder is shown, in -Status and in refusals.
function Describe-Slot([string]$lock, [string]$holder) {
  $free = Test-SlotFree $lock
  $o = $null
  if (Test-Path $holder) { try { $o = Get-Content $holder -Raw | ConvertFrom-Json } catch { $o = $null } }
  if (-not $o) { return $(if ($free) { 'FREE (no holder record)' } else { 'HELD (no readable holder record)' }) }
  $who = "$($o.agent) $($o.candidate) pid $($o.pid) since $($o.started)"
  $alive = [bool]($o.pid -and (Get-Process -Id $o.pid -ErrorAction SilentlyContinue))
  if ($free) {
    if ($o.released) { return "FREE (last holder $who, released $($o.released))" }
    return "FREE (last holder $who ended without a clean release; its record is stale)"
  }
  if ($o.released) { return "HELD (by a run whose record is not written yet; last record: $who, released $($o.released))" }
  if ($alive) { return "HELD by $who (small=$($o.small))" }
  return "HELD, but the recorded holder pid $($o.pid) is gone ($who): an orphan process still has the lock file open; tell the lead"
}
function Mark-Released([string]$p, $code) {
  try {
    $o = Get-Content $p -Raw | ConvertFrom-Json
    if ($o.pid -ne $PID) { return }   # someone else's record: never touch it
    $o | Add-Member -NotePropertyName released -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
    $o | Add-Member -NotePropertyName exit_code -NotePropertyValue $code -Force
    ($o | ConvertTo-Json -Compress) | Set-Content -Path $p -Encoding utf8
  } catch { Write-Host "p03-run: WARNING - could not mark $p released: $_" }
}
function Test-HolderSmall([string]$p) {
  if (-not (Test-Path $p)) { return $false }
  try { $o = Get-Content $p -Raw | ConvertFrom-Json; return [bool]($o.small -eq $true) } catch { return $false }
}

function Get-SlotStatus([string]$lock, [string]$holder) {
  $free = Test-SlotFree $lock
  $record = $null
  if (Test-Path $holder) { try { $record = Get-Content $holder -Raw | ConvertFrom-Json } catch {} }
  [pscustomobject]@{ free = $free; holder = $(if (-not $free) { $record } else { $null }); last_holder = $record }
}
if ($Status) {
  $q = @(Invoke-WithQueueLock { Read-Queue })
  [ordered]@{
    slots = @((Get-SlotStatus $LockPath $Holder), (Get-SlotStatus $LockPath2 $Holder2))
    baseline_pids = @(Get-BaselineRuns)
    free_commit_gb = Get-FreeCommitGB
    min_free_commit_gb = $MinFreeCommitGB
    second_slot_min_gb = $SecondSlotMinGB
    queue = $q
  } | ConvertTo-Json -Depth 8
  exit 0
}
if (-not $Agent -or -not $Run.Count) { Write-Host 'p03-run: -Agent and -Run are required'; exit 64 }

function Entry-Id($entry) {
  if ($entry.id) { return $entry.id }
  # Existing queue records from the old wrapper have no GUID.
  return "$($entry.agent)|$($entry.candidate)|$($entry.added)"
}
function Quote-NativeArgument([string]$arg) {
  # Windows CommandLineToArgvW rules, including quotes and trailing backslashes.
  '"' + ([regex]::Replace([regex]::Replace($arg, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}
function New-RunProcess {
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
  $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
  $info.WorkingDirectory = (Get-Location).Path
  $command = $Run[0]
  $arguments = @($Run | Select-Object -Skip 1) + @($RunArgs)
  # Keep old one-string callers working; list callers never go through cmd.
  if ($Run.Count -eq 1 -and -not $RunArgs.Count -and -not (Get-Command $command -ErrorAction SilentlyContinue)) {
    $info.FileName = 'cmd.exe'
    $info.Arguments = '/d /s /c "' + $command + '"'
  } else {
    $info.FileName = $command
    $info.Arguments = ($arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
  }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $info
  return $process
}

$queueId = $null
if ($Wait) {
  $queueId = Invoke-WithQueueLock {
    $q = @(Read-Queue)
    # A failed launch keeps its place; the same agent/candidate can retry it.
    $existing = $q | Where-Object { $_.agent -eq $Agent -and $_.candidate -eq $Candidate } | Select-Object -First 1
    if ($existing) { Entry-Id $existing }
    else {
      $id = [guid]::NewGuid().ToString()
      $q += [pscustomobject]@{ id = $id; agent = $Agent; candidate = $Candidate; purpose = $Purpose;
        added = (Get-Date).ToUniversalTime().ToString('o'); expires = (Get-Date).ToUniversalTime().AddMinutes($TtlMinutes).ToString('o') }
      Write-Queue $q
      $id
    }
  }
}

# Queue eligibility and slot acquisition are one critical section. A newcomer
# cannot take the slot between the head's eligibility check and its acquisition.
$handles = @()
$myHolder = $Holder
$slotName = 'slot 1'
while (-not $handles.Count) {
  $admission = Invoke-WithQueueLock {
    $q = @(Read-Queue)
    if ($queueId) {
      $entry = $q | Where-Object { (Entry-Id $_) -eq $queueId } | Select-Object -First 1
      if (-not $entry) { throw 'p03-run: wait entry was removed or expired; retry to enqueue again' }
      $entry.expires = (Get-Date).ToUniversalTime().AddMinutes($TtlMinutes).ToString('o')
      Write-Queue $q
    }
    $head = $q | Select-Object -First 1
    if ($head -and (($queueId -and (Entry-Id $head) -ne $queueId) -or (-not $queueId -and $head.agent -ne $Agent))) {
      return @{ reason = "FIFO queue head is $($head.agent)" }
    }
    if (@(Get-BaselineRuns).Count) { return @{ reason = 'test-baseline is running' } }
    $freeGB = Get-FreeCommitGB
    if ($freeGB -lt $MinFreeCommitGB) { return @{ reason = "free commit $freeGB GB below $MinFreeCommitGB GB" } }
    $h1 = Open-Slot $LockPath
    if (-not $Small) {
      if (-not $h1) { return @{ reason = 'slot 1 held; heavy run needs both slots' } }
      $h2 = Open-Slot $LockPath2
      if (-not $h2) { $h1.Dispose(); return @{ reason = 'slot 2 held; heavy run needs both slots' } }
      return @{ handles = @($h1, $h2); holder = $Holder; slot = 'both slots (heavy)'; free = $freeGB; head = $head }
    }
    if ($h1) {
      # If slot 2 is occupied, this too is a second concurrent run.
      if (-not (Test-SlotFree $LockPath2) -and $freeGB -lt $SecondSlotMinGB) {
        $h1.Dispose(); return @{ reason = 'second small run memory floor' }
      }
      return @{ handles = @($h1); holder = $Holder; slot = 'slot 1'; free = $freeGB; head = $head }
    }
    if (-not (Test-HolderSmall $Holder) -or $freeGB -lt $SecondSlotMinGB) { return @{ reason = 'heavy holder or second small run memory floor' } }
    $h2 = Open-Slot $LockPath2
    if (-not $h2) { return @{ reason = 'both slots held' } }
    return @{ handles = @($h2); holder = $Holder2; slot = 'slot 2'; free = $freeGB; head = $head }
  }
  if ($admission.handles) {
    $handles = @($admission.handles)
    $myHolder = $admission.holder
    $slotName = $admission.slot
    break
  }
  if (-not $Wait) { Write-Host "p03-run: REFUSED - $($admission.reason)"; exit 75 }
  # Waiting happens inside the caller; no agent/watchdog retry loop is needed.
  Start-Sleep -Seconds 1
}

$wroteHolder = $false
$code = 70
$child = $null
try {
  $started = (Get-Date).ToUniversalTime().ToString('o')
  $rec = [ordered]@{ agent = $Agent; candidate = $Candidate; pid = $PID; cwd = (Get-Location).Path;
    command = @($Run) + @($RunArgs); started = $started; free_commit_gb_before = $admission.free;
    small = [bool]$Small; slot = $slotName }
  $recJson = $rec | ConvertTo-Json -Compress
  $recJson | Set-Content -Path $myHolder -Encoding utf8
  $wroteHolder = $true
  if (-not $Small) { $recJson | Set-Content -Path $Holder2 -Encoding utf8 }
  Enter-KillOnCloseJob
  $child = New-RunProcess
  if (-not $child.Start()) { throw 'p03-run: child process did not start' }
  [P03Run.Forward]::Start($child)
  # Only successful process creation spends the queue place. A nonzero child
  # exit is a real run; job setup or process creation failure leaves it intact.
  if ($admission.head) {
    $spentId = Entry-Id $admission.head
    Invoke-WithQueueLock {
      $q = @(Read-Queue | Where-Object { (Entry-Id $_) -ne $spentId })
      Write-Queue $q
    }
  }
  Write-Host "p03-run: lock ACQUIRED ($slotName) by $Agent at $started"
  while (-not $child.WaitForExit(1000)) {
    if ((Get-FreeCommitGB) -lt 10) { throw 'p03-run: stopped because free commit dropped below 10 GB' }
  }
  $child.WaitForExit() # drain asynchronous stdout/stderr before returning
  $code = $child.ExitCode
  $rec['ended'] = (Get-Date).ToUniversalTime().ToString('o')
  $rec['exit_code'] = $code
  $rec['free_commit_gb_after'] = Get-FreeCommitGB
  # Serialise concurrent small-run log appends too.
  Invoke-WithQueueLock { Add-Content -Path $Runs -Value ($rec | ConvertTo-Json -Compress) -Encoding utf8 }
} catch {
  Write-Host "p03-run: FAILED - $_"
  # Exit BEFORE closing the slot handles if a child is still running: the job
  # kills the whole tree on wrapper exit, not merely the direct child.
  if ($child -and -not $child.HasExited) { [Environment]::Exit(70) }
} finally {
  if ($wroteHolder) {
    Mark-Released $myHolder $code
    if (-not $Small) { Mark-Released $Holder2 $code }
  }
  foreach ($h in $handles) { $h.Dispose() }
  if ($child) { $child.Dispose() }
}
exit $code
