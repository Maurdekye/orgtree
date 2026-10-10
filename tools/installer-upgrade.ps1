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
  [string] $LogPath,

  # How long the background engine's tree may take to exit once it has been
  # asked to stop. The engine stops its agents (8 s), its mail hub (15 s) and
  # PostgreSQL (up to 120 s on a busy disk) before it exits, so this is longer
  # than the window's own budget above.
  [ValidateRange(10, 600)]
  [int] $EngineStopSeconds = 150,

  # An all-users installation, whose elevated boot step (boot-engine-task.ps1
  # Prepare) can still stop a background engine this run could not ask. Set by
  # the installer; without it, an engine left running is a refusal.
  [switch] $BootManaged,

  # The data folder whose engine-attach.json names the background engine.
  # Defaults to the engine's own choice for this user (ORGTREE_V2_DATA, else
  # %APPDATA%\Orgtree v2\data).
  [string] $DataRoot
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
# Every process that was running from the installation directory, or descended
# from one that was, at the moment this run started — captured BEFORE anything
# is asked to close. A process that exits and leaves an external-image child
# behind cannot be recognised by a later scan, because the closure that would
# have reached that child is rooted in a parent that is no longer in the table.
# This is the record of what that closure saw while it could still see it.
$script:TreeSnapshot = @()

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

  # ---------------------------------------------------------------------------
  # INSTALL-TREE VERIFICATION
  #
  # Everything above this point is about ONE image: the recorded
  # `<InstallDir>\Orgtree.exe`. That is not the whole of what runs out of the
  # installation. The desktop starts an engine from
  # `<InstallDir>\resources\engine\runtime\python.exe`, and that engine starts
  # its own agent and MCP subprocesses. None of them is named `Orgtree.exe`, so
  # none of them was ever detected, asked to close, or verified as gone — and
  # `result: closed gracefully` was therefore only ever a statement about the
  # Electron processes.
  #
  # A running image cannot be replaced on Windows, so an engine that is still
  # up is exactly the thing that stops the file copy. This stage closes that
  # gap: after the desktop has verifiably exited, no process may still be
  # running FROM the installation directory, and no descendant of such a
  # process may still be running either.
  #
  # It follows the same rule as everything above it — quiet is a POSITIVE
  # observation, never an empty scan — and it still never kills anything. If
  # the tree does not go quiet within the budget, this reports which processes
  # are holding it, and the installer offers Retry or Cancel exactly as before.
  # Reporting it HERE, at the upgrade page, turns what would otherwise be a
  # hard abort later in the boot preflight into a retryable, named failure.
  # ---------------------------------------------------------------------------

  # An unreadable image path is only load-bearing when the record could
  # plausibly BE an installation process. Bounded the same way the boot
  # lifecycle bounds it, so an unrelated protected system process whose path
  # this session may not read does not block every upgrade on this machine.
  $script:TreeAmbiguousNames = @('ORGTREE.EXE', 'PYTHON.EXE', 'PYTHONW.EXE')
  $script:TreePrefix = $root.TrimEnd('\') + '\'
  # The background engine's folder. Everything running from it, and everything
  # descended from that, is the engine's tree: what the installer's elevated
  # boot step waits for (boot-engine-task.ps1 Get-BootTree).
  $script:EnginePrefix = $script:TreePrefix + 'resources\engine\'

  function Test-PathUnderPrefix($Value, [string] $Prefix) {
    if (Test-Blank $Value) { return $false }
    $candidate = $null
    try { $candidate = Get-CanonicalPath ([string]$Value) } catch { return $false }
    if (Test-Blank $candidate) { return $false }
    return $candidate.ToUpperInvariant().StartsWith($Prefix.ToUpperInvariant())
  }

  function Test-PathUnderRoot($Value) {
    if (Test-Blank $Value) { return $false }
    $candidate = $null
    try { $candidate = Get-CanonicalPath ([string]$Value) } catch { return $false }
    if (Test-Blank $candidate) { return $false }
    return $candidate.ToUpperInvariant().StartsWith($script:TreePrefix.ToUpperInvariant())
  }

  # Only ever consulted when the image path could NOT be read. The order
  # matters: a readable command line that does not name this installation is
  # POSITIVE evidence the process is something else, whatever it happens to be
  # called. Without that step, `python.exe` alone would be the test — and an
  # unrelated Python on the machine would be enough to stall every upgrade.
  function Test-TreeAmbiguous($Name, $Command, $CommandReadable) {
    if ($CommandReadable -and -not (Test-Blank $Command)) {
      return ([string]$Command).ToUpperInvariant().Contains($script:TreePrefix.ToUpperInvariant())
    }
    # Nothing readable to go on at all. Fall back to the names an installation
    # process could plausibly carry, which is the last bound available.
    if (Test-Blank $Name) { return $true }
    return (@($script:TreeAmbiguousNames) -contains ([string]$Name).ToUpperInvariant())
  }

  # BOTH readings here report a parent id, and that is not a preference: the
  # question this stage answers is "the installation directory AND everything
  # descended from it", and an enumeration that cannot report parentage cannot
  # answer the second half of it. `Get-Process` — the fallback used for the
  # single-image detection above — is therefore NOT a fallback here. It would
  # return an answer about images only, and an answer to a narrower question
  # reported as success is exactly the shape of failure this helper exists to
  # stop. If neither reading can answer, this stage fails closed.
  function Get-TreeReadingsFromCim {
    $records = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $readings = @()
    foreach ($record in $records) {
      $identifier = 0
      try { $identifier = [int]$record.ProcessId } catch { $identifier = 0 }
      # 0 and 4 are the idle and system processes; they are never ours and
      # never have a readable image path.
      if ($identifier -le 0 -or $identifier -eq 4) { continue }
      $parent = 0
      try { $parent = [int]$record.ParentProcessId } catch { $parent = 0 }
      $name = ''
      try { $name = [string]$record.Name } catch { $name = '' }
      $command = ''
      $commandReadable = $true
      try { $command = [string]$record.CommandLine } catch { $commandReadable = $false }
      if ($commandReadable -and (Test-Blank $command)) { $commandReadable = $false }
      $imagePath = $null
      $readable = $true
      try { $imagePath = [string]$record.ExecutablePath } catch { $readable = $false }
      if ($readable -and (Test-Blank $imagePath)) { $readable = $false }
      # CIM hands this back as a real DateTime. It is what tells a genuine
      # parent apart from a reused process id; see Test-RealParent.
      $created = $null
      try { if ($null -ne $record.CreationDate) { $created = [datetime]$record.CreationDate } } catch { $created = $null }
      $readings += [pscustomobject]@{
        Id = $identifier; Parent = $parent; Name = $name
        Path = $imagePath; Readable = $readable
        Command = $command; CommandReadable = $commandReadable
        Created = $created
      }
    }
    return @($readings)
  }

  # The second parent-capable reading. Windows PowerShell 5.1 — the host the
  # installer actually launches — always carries `Get-WmiObject`, and it reaches
  # the same Win32_Process data over the older DCOM path rather than over
  # WinRM/WSMan. So the two readings fail for different reasons, which is the
  # only thing that makes a fallback worth having. It is absent from PowerShell
  # 7, so its presence is checked rather than assumed.
  function Get-TreeReadingsFromWmi {
    if (-not (Get-Command -Name 'Get-WmiObject' -ErrorAction SilentlyContinue)) {
      throw 'Get-WmiObject is not available in this PowerShell host.'
    }
    $records = @(Get-WmiObject -Class Win32_Process -ErrorAction Stop)
    $readings = @()
    foreach ($record in $records) {
      $identifier = 0
      try { $identifier = [int]$record.ProcessId } catch { $identifier = 0 }
      if ($identifier -le 0 -or $identifier -eq 4) { continue }
      $parent = 0
      try { $parent = [int]$record.ParentProcessId } catch { $parent = 0 }
      $name = ''
      try { $name = [string]$record.Name } catch { $name = '' }
      $command = ''
      $commandReadable = $true
      try { $command = [string]$record.CommandLine } catch { $commandReadable = $false }
      if ($commandReadable -and (Test-Blank $command)) { $commandReadable = $false }
      $imagePath = $null
      $readable = $true
      try { $imagePath = [string]$record.ExecutablePath } catch { $readable = $false }
      if ($readable -and (Test-Blank $imagePath)) { $readable = $false }
      # WMI reports this as a CIM_DATETIME string rather than a DateTime, so it
      # goes through the ConvertToDateTime method PowerShell attaches to every
      # ManagementObject for exactly this. Unreadable stays $null, which
      # Test-RealParent treats as "cannot rule the parentage out".
      $created = $null
      try {
        $rawCreated = [string]$record.CreationDate
        if (-not (Test-Blank $rawCreated)) { $created = [datetime]$record.ConvertToDateTime($rawCreated) }
      } catch { $created = $null }
      $readings += [pscustomobject]@{
        Id = $identifier; Parent = $parent; Name = $name
        Path = $imagePath; Readable = $readable
        Command = $command; CommandReadable = $commandReadable
        Created = $created
      }
    }
    return @($readings)
  }

  # ---------------------------------------------------------------------------
  # PARENTAGE IS A CLAIM, NOT A FACT.
  #
  # Windows records a process's parent id ONCE, when the process is created, and
  # never revises it. When that parent exits, its number goes back into the pool
  # and Windows hands it to something else — and the orphan is left naming an id
  # that now belongs to a stranger. Nothing in the process table marks the
  # difference. So a closure over parent ids alone walks out of the installation
  # and into whatever unrelated orphans happen to be naming an installation
  # process's number, which is exactly what this helper did on 2026-09-16: two
  # long-lived orphans from the day before named ids 12264 and 27340, the engine
  # was holding both by then, and eight Windows processes with no connection to
  # Orgtree were reported as holding the installation.
  #
  # Creation time settles it, and it is not a judgement call: a process cannot be
  # the child of something that did not exist yet. The candidate parent for an id
  # is whoever holds it NOW, or — when the pre-close snapshot recorded that id and
  # the process is gone — whoever held it THEN. Either one being old enough is
  # enough, because either one could be the real parent.
  #
  # UNREADABLE STAYS IN THE TREE. A missing creation time on either side means the
  # question was not answered, and the only safe unanswered answer is the one this
  # helper gives everywhere else: assume it is ours. This narrows the tree only
  # where an exit can be positively established, never where it is merely absent.
  # ---------------------------------------------------------------------------
  function Test-ParentPlausible($ParentCreated, $ChildCreated) {
    if ($null -eq $ParentCreated) { return $true }
    if ($null -eq $ChildCreated) { return $true }
    return ($ParentCreated -le $ChildCreated)
  }

  function Test-RealParent([int] $ParentId, $ChildCreated, $Current, $SeedCreated) {
    $known = $false
    if ($Current.ContainsKey($ParentId)) {
      $known = $true
      if (Test-ParentPlausible $Current[$ParentId].Created $ChildCreated) { return $true }
    }
    if ($SeedCreated.ContainsKey($ParentId)) {
      $known = $true
      if (Test-ParentPlausible $SeedCreated[$ParentId] $ChildCreated) { return $true }
    }
    # Nothing on record about that id at all, so there are no grounds to rule the
    # parentage out and it stands.
    return (-not $known)
  }

  # Has the id a snapshot member recorded been handed to a DIFFERENT process
  # since? Only a positive reading may answer yes: the id is in the current
  # enumeration, both creation times are readable, and whatever holds it now was
  # created after the snapshot recorded the one that used to. Anything short of
  # that — the id not visible, either time unreadable, the same creation time —
  # leaves the member exactly where it was.
  function Test-IdReused($Member, $Current) {
    $id = [int]$Member.Id
    if (-not $Current.ContainsKey($id)) { return $false }
    $now = $Current[$id]
    if ($null -eq $now.Created) { return $false }
    if ($null -eq $Member.Created) { return $false }
    return ($now.Created -gt $Member.Created)
  }

  # One parent-capable enumeration of every process on the machine, or a refusal.
  # Separated from the membership rules below because BOTH halves of
  # Get-InstallTreeHolders have to reason about the same reading: which processes
  # are in the tree, and which recorded ids have since changed hands.
  function Get-InstallTreeReadings {
    $readings = $null
    try {
      $readings = @(Get-TreeReadingsFromCim)
    } catch {
      $cimFailure = "$($_.Exception.GetType().Name): $($_.Exception.Message)"
      Write-Log "install-tree: CIM unavailable ($cimFailure); trying WMI"
      try {
        $readings = @(Get-TreeReadingsFromWmi)
        Write-Log 'install-tree: WMI answered; descendants remain answerable'
      } catch {
        # FAIL CLOSED. Neither reading can report parentage, so nothing this
        # run could say about descendants would be an observation. Reporting
        # quiet from here would mean "we could not look", and the installer
        # would replace files underneath whatever it could not see.
        $wmiFailure = "$($_.Exception.GetType().Name): $($_.Exception.Message)"
        Write-Log "install-tree: WMI unavailable too ($wmiFailure); failing closed"
        throw "The processes running from the installation folder could not be enumerated, so it cannot be confirmed that nothing is using its files. CIM said: $cimFailure. WMI said: $wmiFailure. Retry, or cancel to leave the existing installation untouched."
      }
    }
    return @($readings)
  }

  # Every process that is either running from the installation directory or
  # descended from one that is, as { Id, Label, Created, Engine } records. The
  # label is carried because a failure here has to name what is holding the
  # upgrade, the id because the snapshot has to be re-checked by identity later,
  # and the creation time because an id on its own cannot tell that re-check
  # whether it is still looking at the same process. Engine marks the background
  # engine's tree: an image in resources\engine\, or a descendant of one.
  function Get-InstallTreeMembers($Readings) {
    $readings = @($Readings)

    # The reading indexed by id, so a recorded parent id can be resolved to the
    # process that actually holds it.
    $byId = @{}
    foreach ($reading in $readings) { $byId[[int]$reading.Id] = $reading }
    # Creation times for ids the pre-close snapshot recorded, used when such an
    # id no longer appears in this reading.
    $seedCreated = @{}

    $inTree = @{}
    $engineTree = @{}
    $held = @()
    foreach ($reading in @($readings)) {
      $isOurs = $false
      $why = 'image'
      if ($reading.Readable) {
        # The sign-in credential broker is not the app: it runs for the whole
        # Windows session, outside any desktop shutdown. The boot lifecycle's
        # Prepare (boot-engine-task.ps1 Stop-OwnedHelperTask) disables its task
        # and ends it before a single file is copied.
        if ((Test-PathUnderRoot $reading.Path) -and -not ([string]$reading.Path).ToUpperInvariant().EndsWith('\RESOURCES\ENGINE\ORGTREE-CREDENTIAL-BROKER.EXE')) { $isOurs = $true }
      } elseif (Test-TreeAmbiguous $reading.Name $reading.Command $reading.CommandReadable) {
        # Could be an installation process and cannot be ruled out. The only
        # safe unanswered answer is that it is still there.
        $isOurs = $true
        $why = 'unverifiable'
      }
      if ($isOurs) {
        $inTree[[int]$reading.Id] = $true
        $engine = (($why -eq 'image') -and (Test-PathUnderPrefix $reading.Path $script:EnginePrefix))
        if ($engine) { $engineTree[[int]$reading.Id] = $true }
        $label = $reading.Name
        if (Test-Blank $label) { $label = '<unnamed>' }
        $held += [pscustomobject]@{
          Id = [int]$reading.Id
          Label = ("{0}({1},{2})" -f $label, $reading.Id, $why)
          Created = $reading.Created
          Engine = $engine
        }
      }
    }

    # SEEDS FROM THE PRE-CLOSE SNAPSHOT, present or not.
    #
    # Seeding only from what the CURRENT reading can see leaves one race open.
    # An in-tree process that was running at snapshot time may start a child
    # whose own image lives elsewhere AFTER the snapshot and then exit. That
    # child is not an installation image, so it is not seeded above, and the
    # parent it points at is no longer in the table, so the closure has nothing
    # to walk from — it would be missed by the fresh reading and missed by the
    # snapshot's own liveness check, which only knows ids it recorded.
    #
    # So every id the snapshot recorded is an ancestry seed in every later
    # reading, whether or not that process still exists. A seed is ONLY a seed:
    # it is not reported as holding the installation unless this reading
    # actually observed it, which is what keeps "quiet" a positive observation.
    # A seed also carries the time it was recorded at, so the closure can tell an
    # id that is still the process the snapshot saw from one Windows has since
    # handed to somebody else.
    foreach ($member in @($script:TreeSnapshot)) {
      $inTree[[int]$member.Id] = $true
      $seedCreated[[int]$member.Id] = $member.Created
      if ($member.Engine) { $engineTree[[int]$member.Id] = $true }
    }

    # Transitive closure over parent ids, from the images observed now and from
    # those snapshot seeds — but only across parent ids that could REALLY be the
    # parent. A recorded parent id outlives the process that earned it, and
    # Test-RealParent is what stops the walk at an id that has changed hands.
    $added = $true
    while ($added) {
      $added = $false
      foreach ($reading in @($readings)) {
        if ($inTree.ContainsKey([int]$reading.Id)) { continue }
        if (-not $inTree.ContainsKey([int]$reading.Parent)) { continue }
        if (-not (Test-RealParent ([int]$reading.Parent) $reading.Created $byId $seedCreated)) { continue }
        $inTree[[int]$reading.Id] = $true
        $engine = $engineTree.ContainsKey([int]$reading.Parent)
        if ($engine) { $engineTree[[int]$reading.Id] = $true }
        $label = $reading.Name
        if (Test-Blank $label) { $label = '<unnamed>' }
        $held += [pscustomobject]@{
          Id = [int]$reading.Id
          Label = ("{0}({1},descendant)" -f $label, $reading.Id)
          Created = $reading.Created
          Engine = $engine
        }
        $added = $true
      }
    }

    return @($held)
  }

  # The printable form of the same reading.
  function Get-InstallTreeProcesses {
    $descriptions = @()
    foreach ($member in @(Get-InstallTreeMembers (@(Get-InstallTreeReadings)))) { $descriptions += [string]$member.Label }
    return @($descriptions)
  }

  # What is holding the installation, from BOTH directions.
  #
  #   1. A fresh reading, so a process that started after the snapshot — the
  #      engine restarting itself, a new agent — cannot slip through.
  #   2. The pre-close snapshot, re-checked by identity, so a process that was
  #      part of the tree when this run started still has to be observed gone.
  #      This is the half a fresh scan CANNOT do: once an in-tree parent exits,
  #      its external-image child has a dead parent id and no root to be reached
  #      from, so the closure walks straight past it.
  #
  # Identity answers (2), exactly as Test-TargetAlive answers it for the desktop
  # ids: liveness is read with no path lookup, because the reading that might
  # fail must not be what the wait depends on. Identity alone, though, cannot
  # tell a process that is still there from a process id Windows has already
  # given to somebody else — so a live id is cleared only when this reading
  # POSITIVELY shows a different process holding it now (Test-IdReused). An id
  # that is alive and unaccounted for still reads as holding the installation: a
  # false refusal costs a Retry, a false success costs the installation.
  function Get-InstallTreeHolders {
    $readings = @(Get-InstallTreeReadings)
    $current = @(Get-InstallTreeMembers $readings)
    $byId = @{}
    foreach ($reading in $readings) { $byId[[int]$reading.Id] = $reading }
    $seen = @{}
    $held = @()
    foreach ($member in $current) {
      $seen[[int]$member.Id] = $true
      $held += [pscustomobject]@{ Label = [string]$member.Label; Engine = [bool]$member.Engine }
    }
    foreach ($member in @($script:TreeSnapshot)) {
      if ($seen.ContainsKey([int]$member.Id)) { continue }
      if (-not (Test-TargetAlive ([int]$member.Id))) { continue }
      if (Test-IdReused $member $byId) { continue }
      $held += [pscustomobject]@{ Label = ("{0}(pre-close)" -f $member.Label); Engine = [bool]$member.Engine }
    }
    return @($held)
  }

  function Join-HolderLabels($Held) {
    $labels = @()
    foreach ($holder in @($Held)) { $labels += [string]$holder.Label }
    return ($labels -join ', ')
  }

  # ---------------------------------------------------------------------------
  # THE BACKGROUND ENGINE (docket installer-can-t-replace-a-running-orgtree-an-ins)
  #
  # An all-users installation registers the "Orgtree Background Engine" task,
  # which starts `resources\engine\orgtree-engine.exe host` at boot whether or
  # not anyone opens a window. A running window stops that engine on its way out
  # (the desktop's stopGracefullyForInstaller). With no window, nothing asked it
  # to: on 2026-10-10 the user's own log showed this helper waiting its whole
  # budget, twice, on the engine (pid 10904) and 478 processes it had started,
  # and the installer refusing both times. The elevated step that does stop the
  # engine (boot-engine-task.ps1 Prepare) only runs after this check.
  #
  # So this run asks the engine itself, the way the window does. The boot
  # host's attach descriptor names the engine's port and token. It is trusted
  # only under the window's own rule (verifyDescriptorTrust in
  # apps/desktop/main/policy.ts), the engine it names must be THIS
  # installation's, path-verified, and the engine's identity must answer for
  # that process and that data folder. Then the same authenticated shutdown
  # request the window sends. Nothing is ever killed: the engine stops its
  # agents first (their CLIs end as on a normal quit), then its mail hub and
  # PostgreSQL, and its host then exits 0, so the task's restart-on-failure does
  # not start it again.
  # ---------------------------------------------------------------------------
  $script:EngineImage = $script:EnginePrefix + 'orgtree-engine.exe'
  # The one request this run makes, kept for the message the user reads.
  $script:EngineRequest = $null
  $script:EngineLeftLogged = $false

  # The folder the engine uses for this user, chosen the way the boot host
  # chooses it (engine host.rs data_root).
  function Get-EngineDataRoot {
    if (-not (Test-Blank $DataRoot)) { return [string]$DataRoot }
    if (-not (Test-Blank $env:ORGTREE_V2_DATA)) { return [string]$env:ORGTREE_V2_DATA }
    if (-not (Test-Blank $env:APPDATA)) { return (Join-Path -Path $env:APPDATA -ChildPath 'Orgtree v2\data') }
    return $null
  }

  # The principals of $Target's ACL outside $Allowed whose allow entries carry
  # any of $Mask. Inherit-only entries apply to future children, not to the
  # object itself, so they are skipped (the stock C:\ Authenticated Users entry
  # is exactly that shape).
  function Get-ForeignWriters([string] $Target, [int] $Mask, $Allowed) {
    $acl = Get-Acl -LiteralPath $Target -ErrorAction Stop
    $found = @()
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ([string]$rule.AccessControlType -ne 'Allow') { continue }
      if (([string]$rule.PropagationFlags) -match 'InheritOnly') { continue }
      $sid = [string]$rule.IdentityReference.Value
      if (@($Allowed) -contains $sid) { continue }
      if (([int]$rule.FileSystemRights -band $Mask) -ne 0) { $found += $sid }
    }
    return @($found | Select-Object -Unique)
  }

  # The window's rule, unchanged: the descriptor is owned by this user (or by
  # SYSTEM or Administrators), nobody else may write it or its folder, and
  # nobody else may replace a folder above it. Returns what is wrong, or an
  # empty string.
  function Get-DescriptorDistrust([string] $File) {
    $me = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $owners = @($me, 'S-1-5-18', 'S-1-5-32-544')
    $allowed = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
    $writeMask = 0x116 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
    $replaceMask = 0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000
    $owner = [string](Get-Acl -LiteralPath $File -ErrorAction Stop).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owners -notcontains $owner) { return "it is owned by $owner, not by this user" }
    $bad = @(Get-ForeignWriters $File $writeMask $allowed)
    if ($bad.Count -gt 0) { return "it can be written by $($bad -join ', ')" }
    $directory = Split-Path -Path $File -Parent
    $bad = @(Get-ForeignWriters $directory $writeMask $allowed)
    if ($bad.Count -gt 0) { return "its folder can be written by $($bad -join ', ')" }
    $ancestor = Split-Path -Path $directory -Parent
    while (-not (Test-Blank $ancestor)) {
      $bad = @(Get-ForeignWriters $ancestor $replaceMask $allowed)
      if ($bad.Count -gt 0) { return "a folder above it ($ancestor) can be replaced by $($bad -join ', ')" }
      $next = Split-Path -Path $ancestor -Parent
      if ((Test-Blank $next) -or (Test-SamePath $next $ancestor)) { break }
      $ancestor = $next
    }
    return ''
  }

  # Asks the background engine to stop. Returns { Asked, Reason, EnginePid }:
  # whether the engine accepted the request and, when not, why it was not asked.
  # Never fails the run: an engine that cannot be asked is reported as such.
  function Request-BackgroundEngineStop {
    Set-Step 'ask-background-engine'
    $result = [pscustomobject]@{ Asked = $false; Reason = ''; EnginePid = 0 }
    try {
      $dataFolder = Get-EngineDataRoot
      if (Test-Blank $dataFolder) {
        $result.Reason = 'its data folder could not be determined'
      } else {
        $file = Join-Path -Path $dataFolder -ChildPath 'engine-attach.json'
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
          $result.Reason = "no engine has published $file"
        } else {
          $distrust = Get-DescriptorDistrust $file
          if (-not (Test-Blank $distrust)) {
            $result.Reason = "its attach file is not trusted: $distrust"
          } else {
            $raw = Get-Content -LiteralPath $file -Raw -ErrorAction Stop
            $attach = $raw | ConvertFrom-Json
            $enginePid = 0
            $port = 0
            try { $enginePid = [int]$attach.enginePid; $port = [int]$attach.port } catch { $enginePid = 0 }
            $token = [string]$attach.token
            if ([string]$attach.type -ne 'attach' -or [string]$attach.protocol -ne '1' -or $enginePid -le 0 -or $port -le 0 -or $port -gt 65535 -or (Test-Blank $token)) {
              $result.Reason = 'its attach file is not one this installer can use'
            } else {
              $result.EnginePid = $enginePid
              # The engine it names must be this installation's, path-verified:
              # an engine of some other installation is not this run's to stop.
              $process = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $enginePid" -ErrorAction Stop)
              $image = $null
              if ($process.Count -eq 1) { $image = [string]$process[0].ExecutablePath }
              if ($process.Count -ne 1) {
                $result.Reason = "the engine its attach file names (pid $enginePid) is not running"
              } elseif ((Test-Blank $image) -or -not (Test-SamePath (Get-CanonicalPath $image) (Get-CanonicalPath $script:EngineImage))) {
                $result.Reason = "pid $enginePid is not this installation's engine"
              } else {
                $headers = @{ 'X-Orgtree-Desktop-Token' = $token }
                $origin = "http://127.0.0.1:$port"
                $identity = Invoke-RestMethod -Uri "$origin/api/desktop/identity" -Headers $headers -TimeoutSec 5 -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
                $named = ''
                try { $named = [string]$identity.dataRootId } catch { $named = '' }
                $echo = ''
                if (-not (Test-Blank $named)) {
                  $echoFile = Join-Path -Path $named -ChildPath 'engine-attach.json'
                  if (Test-Path -LiteralPath $echoFile -PathType Leaf) { $echo = Get-Content -LiteralPath $echoFile -Raw -ErrorAction Stop }
                }
                if ([string]$identity.protocol -ne '1' -or [int]$identity.pid -ne $enginePid) {
                  $result.Reason = 'its identity does not match its attach file'
                } elseif ($echo -cne $raw) {
                  # The engine's own data folder must hold this very descriptor;
                  # comparing the bytes sidesteps short names and junctions.
                  $result.Reason = 'it reports a different data folder than its attach file'
                } else {
                  $null = Invoke-RestMethod -Method Post -Uri "$origin/api/desktop/shutdown" -Headers $headers -TimeoutSec 5 -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
                  $result.Asked = $true
                }
              }
            }
          }
        }
      }
    } catch {
      $result.Reason = "asking it failed: $($_.Exception.Message)"
    }
    if ($result.Asked) {
      Write-Log "background engine: asked pid $($result.EnginePid) to stop"
    } else {
      Write-Log "background engine: not asked ($($result.Reason))"
    }
    Set-Step 'verify-install-tree-quiet'
    return $result
  }

  # On an all-users installation the background engine's tree is the boot
  # step's to wait for: boot-engine-task.ps1 Prepare disables its task, asks it
  # to stop, ends the task only when it cannot be asked, and confirms the whole
  # tree has gone before a single file is copied. Everything else must be gone
  # here. Without -BootManaged nothing would stop it later, so it is waited for.
  function Select-HoldersHere($Held) {
    if (-not $BootManaged) { return @($Held) }
    $here = @()
    $left = 0
    foreach ($holder in @($Held)) { if ($holder.Engine) { $left++ } else { $here += $holder } }
    if ($left -gt 0 -and -not $script:EngineLeftLogged) {
      $script:EngineLeftLogged = $true
      Write-Log "install-tree: $left process(es) of the background engine are left to the installer's boot step"
    }
    return @($here)
  }

  # What the user reads in Setup's Retry/Cancel box: short, naming the
  # background engine when that is what holds the folder, and saying what to
  # do. The full list is in the log.
  function Get-HeldMessage($Held) {
    $labels = @()
    foreach ($holder in @($Held)) { $labels += [string]$holder.Label }
    $shown = @($labels | Select-Object -First 5)
    $list = $shown -join ', '
    if ($labels.Count -gt $shown.Count) { $list += " and $($labels.Count - $shown.Count) more (the full list is in the log)" }
    $engineHeld = @(@($Held) | Where-Object { $_.Engine })
    if ($engineHeld.Count -eq 0) {
      return "$($labels.Count) process(es) are still running from the installation folder, or were started by it and have not exited, and its files cannot be replaced while they are there: $list. Retry, or cancel to leave the existing installation untouched."
    }
    $text = "The Orgtree background engine is still running from the installation folder ($($labels.Count) process(es): $list)."
    if ($null -ne $script:EngineRequest -and $script:EngineRequest.Asked) {
      $text += " It was asked to stop and had not finished after $EngineStopSeconds seconds. It may still be stopping: wait a moment, then Retry."
    } else {
      $why = ''
      if ($null -ne $script:EngineRequest -and -not (Test-Blank $script:EngineRequest.Reason)) { $why = " ($($script:EngineRequest.Reason))" }
      $text += " It could not be asked to stop$why. Open Orgtree, choose Quit Orgtree from its tray menu, then Retry."
    }
    return $text + ' Cancel leaves the existing installation untouched.'
  }

  # One line for the log and the installer's output when the background engine
  # took part: stopped here, or left to the boot step.
  function Write-EngineOutcome {
    if ($script:EngineLeftLogged) {
      Write-Log 'background engine: left to the installer boot step, which stops it before any file is copied'
      Write-Output 'The Orgtree background engine is stopped by the next installer step.'
    } elseif ($null -ne $script:EngineRequest -and $script:EngineRequest.Asked) {
      Write-Log 'background engine: stopped gracefully'
      Write-Output 'The Orgtree background engine stopped gracefully.'
    }
  }

  # Waits for the installation tree to be verifiably quiet, or throws naming
  # what is still in it. Never kills, signals or stops anything: when the tree
  # is not quiet it asks the background engine to stop, once, the way the
  # window does, and then gives the engine's tree the engine's own budget.
  # -ObserveOnly is the recovery path's single look: it asks nothing.
  function Assert-InstallTreeQuiet([datetime] $Deadline, [switch] $ObserveOnly) {
    Set-Step 'verify-install-tree-quiet'
    $held = @(Get-InstallTreeHolders)
    if ($held.Count -gt 0 -and -not $ObserveOnly -and $null -eq $script:EngineRequest) {
      $script:EngineRequest = Request-BackgroundEngineStop
      if ($script:EngineRequest.Asked -and -not $BootManaged) {
        $engineDeadline = (Get-Date).AddSeconds($EngineStopSeconds)
        if ($engineDeadline -gt $Deadline) { $Deadline = $engineDeadline }
      }
    }
    $held = @(Select-HoldersHere $held)
    while ($held.Count -gt 0 -and (Get-Date) -lt $Deadline) {
      Write-Log "install-tree: $($held.Count) still present: $(Join-HolderLabels $held)"
      Start-Sleep -Milliseconds 250
      $held = @(Select-HoldersHere @(Get-InstallTreeHolders))
    }
    if ($held.Count -gt 0) {
      Write-Log "install-tree: timeout; still present: $(Join-HolderLabels $held)"
      throw (Get-HeldMessage $held)
    }
    if ($script:EngineLeftLogged) {
      Write-Log 'install-tree: verified quiet apart from the background engine, which the boot step stops'
    } else {
      Write-Log 'install-tree: verified quiet'
    }
  }

  # One budget for the whole operation. The tree wait shares it with the close
  # rather than doubling it, so the installer's Retry/Cancel prompt still
  # appears within the time the caller asked for.
  $overallDeadline = (Get-Date).AddSeconds($TimeoutSeconds)

  # BEFORE anything is asked to close, and before the desktop is even looked
  # for. Once an in-tree process exits, any child of it whose own image lives
  # outside the installation is unreachable: the child keeps a parent id that
  # no longer appears in the table, so no later closure can walk to it. This is
  # the only moment at which that relationship is observable, so it is recorded
  # here and every success path below is held to it as well as to a fresh scan.
  #
  # A failure here is reported outright rather than recovered from, because
  # nothing has been asked of the application yet: the user gets a named,
  # retryable refusal and an installation nobody has touched.
  Set-Step 'snapshot-install-tree'
  $script:TreeSnapshot = @(Get-InstallTreeMembers (@(Get-InstallTreeReadings)))
  if (@($script:TreeSnapshot).Count -eq 0) {
    Write-Log 'install-tree: nothing was running from the installation folder when this run started'
  } else {
    $snapshotLabels = @()
    foreach ($member in @($script:TreeSnapshot)) { $snapshotLabels += [string]$member.Label }
    Write-Log "install-tree: snapshot of $(@($script:TreeSnapshot).Count): $($snapshotLabels -join ', ')"
  }

  Set-Step 'detect-running-processes'
  $running = @(Get-InstalledProcesses)
  Write-Log "detection: $($running.Count) matching process(es)"
  if ($running.Count -eq 0) {
    # The desktop is not running, which says nothing about the engine that
    # outlives it: the background engine runs with no window at all. Verify the
    # rest of the installation, asking that engine to stop when it is what holds
    # it, before reporting that its files are safe to replace.
    Assert-InstallTreeQuiet $overallDeadline
    Write-EngineOutcome
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
  $alive = @($script:Watch)
  while ((Get-Date) -lt $overallDeadline) {
    Start-Sleep -Milliseconds 250
    $alive = @(Get-LiveTargets)
    if ($alive.Count -eq 0) {
      Write-Log 'desktop: every watched process verifiably exited'
      # The desktop is gone. The engine it started is not necessarily gone with
      # it, and it is the one running out of the installation folder.
      Assert-InstallTreeQuiet $overallDeadline
      Write-EngineOutcome
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
    $failedStep = $script:Step
    try {
      $alive = @(Get-LiveTargets)
      if ($alive.Count -eq 0) {
        # The desktop exiting is necessary but not sufficient. Recovery has to
        # clear the same bar the ordinary path clears, or an error in the
        # middle of the run would become the one way to skip the tree check.
        # The deadline has usually passed by now, which makes this a single
        # immediate observation rather than another wait, and it asks nothing
        # of the background engine (a Retry does).
        Assert-InstallTreeQuiet $overallDeadline -ObserveOnly
        Write-Log "result: closed gracefully (every target verifiably exited and the installation tree is quiet; recovered from an error in step $failedStep : $($failure.Exception.Message))"
        Write-Output 'Orgtree closed gracefully.'
        exit 0
      }
      Write-Log "recovery: still present or unverifiable: $($alive -join ', ')"
    } catch {
      # Fall through and report the original failure rather than this one.
      Write-Log "recovery: declined ($($_.Exception.Message))"
    }
    # Report the step the ORIGINAL failure came from, not whatever stage the
    # recovery attempt happened to leave behind.
    $script:Step = $failedStep
  }
  $detail = "[$script:Step] $($failure.Exception.Message)"
  Write-Log "failure: $detail"
  if ($LogPath) { Write-Log "log: $LogPath" }
  [Console]::Error.WriteLine($detail)
  if ($LogPath) { [Console]::Error.WriteLine("Details were written to $LogPath") }
  exit 2
}
