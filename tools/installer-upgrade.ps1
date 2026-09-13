[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $InstallDir,

  [Parameter(Mandatory = $true)]
  [string] $ExecutablePath,

  [ValidateRange(5, 120)]
  [int] $TimeoutSeconds = 45,

  # Where the lifecycle record is appended. The installer always passes one.
  # Logging is best-effort and never fails the upgrade.
  [string] $LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ⚠ READ THIS BEFORE CHANGING ANY EXPRESSION BELOW.
#
# The installer runs this under Windows PowerShell 5.1, launched by a 32-bit
# NSIS process. 2.1.3-RC1 failed there with the bare .NET message "Argument
# types do not match" and nothing else, on every invocation, before it inspected
# a single process.
#
# That is a REPRODUCED fact, not an inference, and the reproduction is narrower
# than "New-Object is unsafe" — it needs the whole sequence:
#
#     $list = New-Object 'System.Collections.Generic.List[object]'
#     $list.Add($anyObject)
#     return @($list)        # <-- ArgumentException here
#
# Constructing that list is fine. Adding to it is fine. ENUMERATING it back
# through `@()` as a function's return value is what throws, which is why
# testing the constructor alone says the code is healthy when it is not.
# `[System.Collections.Generic.List[object]]::new()` runs the identical
# sequence without error. Measured in the 32-bit and 64-bit 5.1 hosts, and
# pinned by a regression in tests/installer-upgrade.test.mjs so the hazard
# cannot come back. `$matches` is an automatic variable and is not used as a
# name either, though it was not the cause: the same failure occurs under any
# variable name.
#
# This helper avoids the hazard completely by using plain arrays rather than a
# generic list. Everything below that rule is HARDENING BEYOND that fix, added
# because a helper an installer depends on should not have been able to fail
# this silently in the first place. Three rules:
#   1. Every stage sets $script:Step first, and every message carries it. The
#      RC1 dialog cost two release candidates to interpret largely because it
#      named nothing: a failure now says which stage produced it, on screen and
#      in the log, instead of arriving as three anonymous words.
#   2. Where a cmdlet or an operator does the same job as an OVERLOADED .NET
#      static, the cmdlet or operator is used: `Join-Path`, `Split-Path` and
#      `ToUpperInvariant()` comparison replaced `[IO.Path]::Combine` and the
#      three-argument `[string]::Equals`. Two single-overload statics remain
#      here deliberately, because nothing else normalizes a path the same way:
#      `[IO.Path]::GetFullPath` and `[IO.Path]::GetFileNameWithoutExtension`.
#      They are not assumed safe — GetFullPath is measured directly by
#      tools/test-upgrade-close-boundary.mjs, in the 32-bit and 64-bit hosts,
#      across the path shapes this helper actually receives.
#      Measured separately, not in a test: under ConstrainedLanguage every
#      `[IO.Path]` call fails, but with "Method invocation is supported only on
#      core types in this language mode" — a different message, so that mode is
#      not an alternative explanation for the RC1 dialog.
#      Process detection also has a second, independent mechanism. If CIM is
#      what breaks under elevation, `Get-Process` still answers.
#   3. Success is only ever POSITIVE VERIFICATION that the exact processes
#      identified before the request have gone. It is never inferred from a
#      scan that came back empty, because an "everything matching is gone"
#      answer and a "nothing could be read" answer are indistinguishable, and
#      one of them replaces files underneath a running application. Anything
#      that cannot be verified is reported as a failure, which costs the user a
#      Retry and costs them nothing else.

$script:Step = 'start'
# Set only once the control process has actually started, and only then may a
# later error be reconsidered instead of reported.
$script:Requested = $false
# The exact path-verified process ids this run is responsible for, fixed before
# the request is sent. The wait watches THESE, by identity, and never re-derives
# the set from another path scan.
$script:Watch = @()

function Write-Log([string] $Message) {
  if (-not $LogPath) { return }
  try {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $directory = Split-Path -Path $LogPath -Parent
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    Add-Content -LiteralPath $LogPath -Value ("{0} pid={1} {2}" -f $stamp, $PID, $Message) -Encoding UTF8
  } catch {
    # A log that cannot be written must never be the reason an upgrade fails.
  }
}

function Set-Step([string] $Name) {
  $script:Step = $Name
  Write-Log "step $Name"
}

# Windows compares paths case-insensitively. `ToUpperInvariant` takes no
# arguments, so unlike a three-argument `[string]::Equals` it cannot be an
# overload-resolution failure.
function Test-SamePath([string] $Left, [string] $Right) {
  return ($Left.ToUpperInvariant() -ceq $Right.ToUpperInvariant())
}

function Test-Blank($Value) {
  if ($null -eq $Value) { return $true }
  return (([string]$Value).Trim().Length -eq 0)
}

function Get-CanonicalPath([string] $Value) {
  return [IO.Path]::GetFullPath($Value)
}

try {
  Set-Step 'canonicalize-paths'
  Write-Log "install-dir '$InstallDir' executable '$ExecutablePath' timeout ${TimeoutSeconds}s"
  $root = Get-CanonicalPath $InstallDir
  $executable = Get-CanonicalPath $ExecutablePath

  Set-Step 'resolve-executable-name'
  $leaf = Split-Path -Path $executable -Leaf
  if (Test-Blank $leaf) {
    throw 'The installed application executable path is incomplete.'
  }

  # The installer passes both values from the matching registry record. Keep
  # the executable inside that exact recorded directory; never search by a
  # guessed process name or by a caller-controlled alternate path.
  Set-Step 'verify-executable-location'
  $expectedExecutable = Get-CanonicalPath (Join-Path -Path $root -ChildPath $leaf)
  if (-not (Test-SamePath $expectedExecutable $executable)) {
    throw 'The application executable is outside the recorded installation directory.'
  }
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "The installed application executable was not found: $executable"
  }

  # Two independent readings of the same question. CIM is preferred because it
  # reports an image path for every process without opening a handle; the
  # process table is the fallback for any environment where CIM cannot answer.
  function Get-ProcessRecordsFromCim {
    $records = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $readings = @()
    foreach ($record in $records) {
      # An elevated enumeration reaches processes an ordinary one never sees,
      # and reading a property of one of those can fail on its own terms. A
      # record whose own name will not resolve cannot be identified as this
      # application, so it is skipped. Aborting the upgrade over an unrelated
      # system process is precisely the failure this helper has to stop doing.
      $name = $null
      try { $name = [string]$record.Name } catch { continue }
      if (Test-Blank $name) { continue }
      if (-not (Test-SamePath $name $leaf)) { continue }

      # From here the record IS a name match, so an unreadable image path is
      # load-bearing: it might be the running application, and proceeding
      # would replace files underneath it.
      $imagePath = $null
      try { $imagePath = [string]$record.ExecutablePath } catch {
        $readings += [pscustomobject]@{ Id = 0; Path = $null; Unverifiable = $true }
        continue
      }
      # The id is what the wait is built on, so a match whose id cannot be read
      # is as unusable as one whose path cannot be read.
      $identifier = 0
      try { $identifier = [int]$record.ProcessId } catch { $identifier = 0 }
      if ($identifier -le 0) {
        $readings += [pscustomobject]@{ Id = 0; Path = $null; Unverifiable = $true }
        continue
      }
      $readings += [pscustomobject]@{ Id = $identifier; Path = $imagePath; Unverifiable = $false }
    }
    return @($readings)
  }

  function Get-ProcessRecordsFromTable {
    $base = [IO.Path]::GetFileNameWithoutExtension($leaf)
    # FAIL CLOSED. `Get-Process -Name X -ErrorAction SilentlyContinue` cannot
    # tell "no process has that name" apart from "the process table could not be
    # read": both arrive as an empty collection. Empty here means "Orgtree is
    # already closed", which means an installer that proceeds to replace files.
    # So the whole table is read with -ErrorAction Stop, where a real read error
    # throws and is reported, and the name match is done per record afterwards —
    # making a genuine absence of matches the only way to reach an empty result.
    $records = @(Get-Process -ErrorAction Stop)
    $readings = @()
    foreach ($record in $records) {
      # Same rule as the CIM reading: a record that will not even name itself
      # cannot be identified as this application, so it is skipped rather than
      # aborting the upgrade over some unrelated process.
      $name = $null
      try { $name = [string]$record.Name } catch { continue }
      if (Test-Blank $name) { continue }
      # Process-table names carry no extension, so this matches the base name.
      if (-not (Test-SamePath $name $base)) { continue }

      # From here the record IS a name match, so an unreadable image path is
      # load-bearing: it might be the running application.
      $imagePath = $null
      try { $imagePath = [string]$record.Path } catch {
        $readings += [pscustomobject]@{ Id = 0; Path = $null; Unverifiable = $true }
        continue
      }
      $identifier = 0
      try { $identifier = [int]$record.Id } catch { $identifier = 0 }
      if ($identifier -le 0) {
        $readings += [pscustomobject]@{ Id = 0; Path = $null; Unverifiable = $true }
        continue
      }
      $readings += [pscustomobject]@{ Id = $identifier; Path = $imagePath; Unverifiable = $false }
    }
    return @($readings)
  }

  # Returns every process that is verifiably the recorded executable. This runs
  # ONCE, before the request, and its ids become the fixed set the wait watches.
  function Get-InstalledProcesses {
    $readings = $null
    try {
      $readings = Get-ProcessRecordsFromCim
    } catch {
      Write-Log "detection: CIM unavailable ($($_.Exception.GetType().Name): $($_.Exception.Message)); using the process table"
      $readings = Get-ProcessRecordsFromTable
    }

    $found = @()
    foreach ($reading in @($readings)) {
      if ($reading.Unverifiable -or (Test-Blank $reading.Path)) {
        throw 'A matching Orgtree process could not be path-verified; the upgrade is left untouched.'
      }
      $candidate = Get-CanonicalPath ([string]$reading.Path)
      if (Test-SamePath $candidate $executable) {
        $found += $reading
      }
    }
    return @($found)
  }

  # Has this exact process verifiably gone? Answered by identity alone — no
  # path is read, because the wait must not depend on the reading that may be
  # what fails. UNVERIFIABLE COUNTS AS ALIVE: an error here means the question
  # was not answered, and the only safe unanswered answer is "still running".
  function Test-TargetAlive([int] $Id) {
    if ($Id -le 0) { return $true }
    try {
      return ($null -ne (Get-Process -Id $Id -ErrorAction SilentlyContinue))
    } catch {
      return $true
    }
  }

  function Get-LiveTargets {
    $alive = @()
    foreach ($id in @($script:Watch)) {
      if (Test-TargetAlive ([int]$id)) { $alive += [int]$id }
    }
    return @($alive)
  }

  Set-Step 'detect-running-processes'
  $running = @(Get-InstalledProcesses)
  Write-Log "detection: $($running.Count) matching process(es)"
  if ($running.Count -eq 0) {
    Write-Log 'result: already closed'
    Write-Output 'Orgtree is already closed.'
    exit 0
  }

  # Fixed before anything is asked of the application, so the wait is bound to
  # the processes that were actually verified, not to whatever a later scan
  # happens to return.
  $targets = @()
  foreach ($reading in $running) { $targets += [int]$reading.Id }
  Write-Log "targets: $($targets -join ', ')"

  Set-Step 'request-graceful-shutdown'
  Write-Output 'Requesting a graceful Orgtree shutdown.'
  $control = Start-Process -FilePath $executable -ArgumentList @('--installer-upgrade') -WindowStyle Hidden -PassThru
  if ($null -eq $control) {
    # Without a control process there is no evidence the application was ever
    # asked. Report that rather than waiting on a request that may not exist.
    throw 'The graceful close could not be requested: the control process did not start.'
  }
  $controlId = 0
  try { $controlId = [int]$control.Id } catch { $controlId = 0 }
  try { $control.Dispose() } catch { }
  if ($controlId -le 0) {
    # A control process that cannot be tracked is not a harmless one. It carries
    # the same image path as the application, and if it won the single-instance
    # race it IS the application now — so waiting only on the original ids could
    # watch them all exit and call that a successful close while the thing
    # holding the installed files is the process nobody is watching.
    throw 'The graceful close was requested, but the control process could not be tracked, so its exit cannot be verified.'
  }

  # Only now has the application been asked AND can the answer be checked, so
  # only now may a later error be reconsidered instead of reported outright.
  $script:Requested = $true
  $script:Watch = @($targets) + @($controlId)
  Write-Log "request: control process id $controlId; watching $($script:Watch -join ', ')"

  Set-Step 'await-exit'
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $alive = @($script:Watch)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $alive = @(Get-LiveTargets)
    if ($alive.Count -eq 0) {
      Write-Log 'result: closed gracefully'
      Write-Output 'Orgtree closed gracefully.'
      exit 0
    }
  }

  Write-Log "result: timeout after ${TimeoutSeconds}s; still present or unverifiable: $($alive -join ', ')"
  throw "Orgtree did not close within $TimeoutSeconds seconds. It may still be closing; retry, or cancel to leave the existing installation untouched."
} catch {
  $failure = $_
  # An error raised after the close was requested may be reconsidered, but ONLY
  # against positive evidence: every process this run identified before it asked
  # must be verifiably gone, by id. It is never enough that a scan came back
  # empty — a scan that cannot read anything comes back empty too, and treating
  # that as success is how an installer overwrites a running application.
  # Anything unverifiable keeps its process in the live set, so this can only
  # ever turn a failure into success by observing the exits it names.
  if ($script:Requested -and @($script:Watch).Count -gt 0) {
    try {
      $alive = @(Get-LiveTargets)
      if ($alive.Count -eq 0) {
        Write-Log "result: closed gracefully (every target verifiably exited; recovered from an error in step $script:Step : $($failure.Exception.Message))"
        Write-Output 'Orgtree closed gracefully.'
        exit 0
      }
      Write-Log "recovery: still present or unverifiable: $($alive -join ', ')"
    } catch {
      # Fall through and report the original failure rather than this one.
    }
  }
  $detail = "[$script:Step] $($failure.Exception.Message)"
  Write-Log "failure: $detail"
  if ($LogPath) { Write-Log "log: $LogPath" }
  [Console]::Error.WriteLine($detail)
  if ($LogPath) { [Console]::Error.WriteLine("Details were written to $LogPath") }
  exit 2
}
