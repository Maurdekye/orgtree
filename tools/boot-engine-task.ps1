# Installer-only. Dot-sourcing defines functions without machine operations.
# Tests substitute the explicit task/registry/process I/O boundaries below.
Set-StrictMode -Version Latest
$script:BootTaskName = 'Orgtree Background Engine'
$script:BootRecordKey = 'SOFTWARE\Orgtree\BootEngine'
$script:BootSnapshotKey = 'SOFTWARE\Orgtree\BootInstallRollback'
# The sign-in credential broker (engine/rs/orgtree-engine/src/credential_broker.rs):
# a logon task for the operator only, interactive token, no window. It serves
# git/gh credentials to the boot engine while the desktop app is not running,
# and it is the launcher that starts the boot engine's agent turns in the
# operator's signed-in session (user 2026-10-16 09:37Z: "agents always start
# at boot, and then automatically get upgraded when signed in").
$script:HelperTaskName = 'Orgtree Credential Helper'
$script:InteractiveTaskName = 'Orgtree User Session Engine'
$script:HelperExe = 'orgtree-credential-broker.exe'
# The engine at sign-in from 4.3.x, a logon task running the windowless host,
# is gone (the same ruling): an update stops and deletes the task it finds.
# Its names stay so that the task and its running host are still recognized.
$script:SigninTaskName = 'Orgtree Sign-in Engine'
$script:SigninHostExe = 'orgtree-engine-host.exe'

function Assert-BootProtectedAcl([string]$Sddl, [long]$WriteMask) {
    $sd = [Security.AccessControl.CommonSecurityDescriptor]::new($false,$false,$Sddl)
    $trusted = @('S-1-5-18','S-1-5-32-544') # SYSTEM and Administrators only
    if ($null -eq $sd.Owner -or $sd.Owner.Value -notin $trusted -or $null -eq $sd.DiscretionaryAcl) { throw 'Boot ownership metadata is not administrator protected.' }
    foreach ($ace in $sd.DiscretionaryAcl) {
        if ($ace.AceQualifier -eq 'AccessAllowed' -and ([int]$ace.AceFlags -band 8) -eq 0 -and
            (([long]$ace.AccessMask -band $WriteMask) -ne 0) -and $ace.SecurityIdentifier.Value -notin $trusted) {
            throw 'Boot ownership metadata grants write access to another principal.'
        }
    }
}
function Assert-BootRegistryKey($Key) {
    Assert-BootProtectedAcl ($Key.GetAccessControl().GetSecurityDescriptorSddlForm('All')) 0x500D0006
}

function Get-BootCanonicalPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path.StartsWith('\\')) { throw 'A local absolute installation path is required.' }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}
function Assert-BootSid([string]$Sid) {
    $value = [Security.Principal.SecurityIdentifier]::new($Sid)
    if (-not $value.IsAccountSid()) { throw 'The boot operator must be a Windows account SID.' }
    return $value.Value
}
function Get-BootRecord {
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
    try {
        $key = $hive.OpenSubKey($script:BootRecordKey)
        if ($null -eq $key) { return $null }
        # RunOnStartup: the operator's "Run on boot" (1 on, 0 off; it was "Run on
        # startup"), written by the desktop's switch through a permission prompt
        # and by Prepare; absent on installations from before it existed. The
        # StartupMode that 4.3.x wrote next to it is no longer read, and Prepare
        # deletes it.
        try { Assert-BootRegistryKey $key; return @{ InstallDir=$key.GetValue('InstallDir'); OperatorSid=$key.GetValue('OperatorSid'); Id=$key.GetValue('Id'); RunOnStartup=$key.GetValue('RunOnStartup') } }
        finally { $key.Dispose() }
    } finally { $hive.Dispose() }
}
function Save-BootRecord($Record) {
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
    try {
        $acl = [Security.AccessControl.RegistrySecurity]::new()
        $acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;KR;;;BU)')
        # Supplying security on CREATE avoids an intermediate writable record.
        $key = $hive.CreateSubKey($script:BootRecordKey, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $acl)
        try {
            Assert-BootRegistryKey $key
            foreach ($name in @('InstallDir','OperatorSid','Id')) { $key.SetValue($name, [string]$Record[$name], 'String') }
            if ($null -ne $Record['RunOnStartup']) { $key.SetValue('RunOnStartup', [int]$Record['RunOnStartup'], 'DWord') }
            # 4.3.x's start mode: the engine always starts at boot now
            $key.DeleteValue('StartupMode', $false)
        }
        finally { $key.Dispose() }
    } finally { $hive.Dispose() }
}
function Remove-BootRecord {
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
    try { $hive.DeleteSubKey($script:BootRecordKey, $false) } finally { $hive.Dispose() }
}
function Get-BootFolder {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    return $service.GetFolder('\')
}
function Find-BootTask($Folder) {
    try { return $Folder.GetTask($script:BootTaskName) }
    catch {
        if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return $null } # file not found only
        throw
    }
}
function Get-BootProcesses { return @(Get-CimInstance Win32_Process -ErrorAction Stop) }
# The operator's engine data folder, chosen the way the boot host chooses it
# (engine host.rs data_root): their ORGTREE_V2_DATA when their registry hive is
# loaded and sets one, else <profile>\AppData\Roaming\Orgtree v2\data.
function Get-OperatorDataRoot([string]$Sid) {
    $value = $null
    try {
        $users = [Microsoft.Win32.RegistryKey]::OpenBaseKey('Users', 'Registry64')
        try {
            $environment = $users.OpenSubKey("$Sid\Environment")
            if ($null -ne $environment) { try { $value = $environment.GetValue('ORGTREE_V2_DATA') } finally { $environment.Dispose() } }
        } finally { $users.Dispose() }
    } catch { $value = $null }
    if ($value) { return [string]$value }
    $profilePath = Get-OperatorProfile $Sid
    if (-not $profilePath) { return $null }
    return (Join-Path $profilePath 'AppData\Roaming\Orgtree v2\data')
}
function Get-OperatorProfile([string]$Sid) {
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
    try {
        $key = $hive.OpenSubKey("SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$Sid")
        if ($null -eq $key) { return $null }
        try { return [string]$key.GetValue('ProfileImagePath') } finally { $key.Dispose() }
    } finally { $hive.Dispose() }
}
# The operator's own "Run on startup" from before it was recorded here: the
# desktop stores it as startAtLogin in desktop-settings.json. The file is the
# user's own, and agents can write it; that is acceptable for this one value,
# which only decides whether the user's own engine starts at boot and grants
# nothing. $null when it cannot be read.
function Get-OperatorStartupChoice([string]$Sid) {
    try {
        $profilePath = Get-OperatorProfile $Sid
        if (-not $profilePath) { return $null }
        return Read-StartupChoice (Join-Path $profilePath 'AppData\Roaming\Orgtree v2\desktop-settings.json')
    } catch { return $null }
}
# startAtLogin from a desktop-settings.json: $true, $false, or $null for a
# missing file, unreadable JSON or no boolean value.
function Read-StartupChoice([string]$File) {
    try {
        if (-not [IO.File]::Exists($File)) { return $null }
        $value = ([IO.File]::ReadAllText($File) | ConvertFrom-Json).startAtLogin
        if ($value -is [bool]) { return $value }
        return $null
    } catch { return $null }
}
# Ask the background engine to stop the way the window does: POST
# /api/desktop/shutdown with the token from the boot host's attach descriptor.
# It then closes its agents (and their CLIs) itself, then its mail hub and
# PostgreSQL. $true only when this installation's engine took the request. The
# descriptor is the operator's and readable by them alone, so an installer
# elevated as another account gets $false, and the caller ends the task instead.
function Request-BootEngineShutdown($Record, [string]$InstallDir) {
    try {
        $root = Get-OperatorDataRoot $Record.OperatorSid
        if (-not $root) { return $false }
        $file = Join-Path $root 'engine-attach.json'
        if (-not [IO.File]::Exists($file)) { return $false }
        $attach = [IO.File]::ReadAllText($file) | ConvertFrom-Json
        $enginePid = [int]$attach.enginePid
        $port = [int]$attach.port
        $token = [string]$attach.token
        if ([string]$attach.type -cne 'attach' -or [string]$attach.protocol -ne '1' -or $enginePid -le 0 -or $port -le 0 -or $port -gt 65535 -or -not $token) { return $false }
        # The engine it names must be this installation's, path-verified.
        $engine = Join-Path (Get-BootPaths $InstallDir).Engine 'orgtree-engine.exe'
        $process = @(Get-BootProcesses | Where-Object { $null -ne $_ -and [int]$_.ProcessId -eq $enginePid })
        if ($process.Count -ne 1 -or -not $process[0].ExecutablePath -or $process[0].ExecutablePath -ine $engine) { return $false }
        $headers = @{ 'X-Orgtree-Desktop-Token' = $token }
        $origin = "http://127.0.0.1:$port"
        $identity = Invoke-RestMethod -Uri "$origin/api/desktop/identity" -Headers $headers -TimeoutSec 5 -MaximumRedirection 0 -UseBasicParsing
        if ([string]$identity.protocol -ne '1' -or [int]$identity.pid -ne $enginePid) { return $false }
        $null = Invoke-RestMethod -Method Post -Uri "$origin/api/desktop/shutdown" -Headers $headers -TimeoutSec 5 -MaximumRedirection 0 -UseBasicParsing
        return $true
    } catch { return $false }
}
# The installer's own way to ask (docket installer-s-end-task-fallback-no-longer-
# stops-th, coordinator 2026-10-15): StopRequested, the request's time in Unix
# milliseconds, in its protected record, which only administrators can write. An
# engine a task's host started reads it every 2 s and stops the graceful way when
# the request is newer than its own start (engine src/install_stop.rs); an older
# value never stops anything and is never removed (the next request overwrites
# it). For an installer that cannot read the operator's descriptor. $true when
# the request was written. An I/O boundary; the tests replace it.
function Request-BootEngineStopByRecord {
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
    try {
        $key = $hive.OpenSubKey($script:BootRecordKey, $true)
        if ($null -eq $key) { return $false }
        try {
            Assert-BootRegistryKey $key
            $key.SetValue('StopRequested', [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), 'QWord')
            return $true
        } finally { $key.Dispose() }
    } catch { return $false }
    finally { $hive.Dispose() }
}
function Get-BootProcessKey($Process) { return "$($Process.ProcessId):$($Process.CreationDate)" }
# The installer's lifecycle log, the file the close helper (installer-upgrade.ps1)
# appends to, so one file tells a whole upgrade. Best effort: a log that cannot be
# written never fails a step. An I/O boundary; the tests replace it.
function Get-BootLogPath { return (Join-Path ([IO.Path]::GetTempPath()) 'orgtree-installer-upgrade.log') }
function Write-BootLog([string]$Message) {
    try { Add-Content -LiteralPath (Get-BootLogPath) -Value ('{0} pid={1} boot: {2}' -f [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'), $PID, $Message) -Encoding UTF8 }
    catch { }
}
# One process as a failure names it: image, pid, parent, path and, for the
# engine binary only, the mode it runs in (host, core-recovery watch, ...). No
# other command line is repeated: an agent's tool command may carry anything.
function Get-BootProcessLabel($Process) {
    $field = { param($Name) $value = $Process.PSObject.Properties[$Name]; if ($null -ne $value) { $value.Value } }
    $name = [string](& $field 'Name'); if (-not $name) { $name = '<unnamed>' }
    $path = [string](& $field 'ExecutablePath'); if (-not $path) { $path = '<path unreadable>' }
    $parent = & $field 'ParentProcessId'; if ($null -eq $parent) { $parent = '?' }
    $mode = ''
    if ($name -ieq 'orgtree-engine.exe' -and [string](& $field 'CommandLine') -cmatch '^\s*(?:"[^"]*"|\S+)\s+"?([a-z][a-z-]*)"?(?=\s|$)(?:\s+([a-z][a-z-]*)(?=\s|$))?') {
        $mode = ((@($Matches[1], $Matches[2]) | Where-Object { $_ }) -join ' ') + ', '
    }
    return "$name pid $(& $field 'ProcessId') (${mode}parent $parent) at $path"
}
# ---- the desktop's core-recovery observer
# `resources\engine\orgtree-engine.exe core-recovery watch <data root> <desktop
# pid> <desktop creation stamp>` (engine core_recovery.rs). The desktop starts it
# outside every job so that it outlives a crashed desktop and relaunches it.
# After an installer or the in-app updater has closed the desktop, the observer
# of 4.3.0-alpha.0 and alpha.1 instead waits out a 180-second installer
# allowance and then relaunches the old application. It runs from the engine
# folder, so all that time the files cannot be replaced and the boot tree is
# not quiet: two real upgrades to alpha.1 failed on exactly this (docket
# installer-can-t-replace-a-running-orgtree-an-ins, 2026-10-14). Later engines
# stand down by themselves when their desktop closes for an install and get a
# few seconds to do so; an older observer is then ended. Coordinator ruling
# 2026-10-14: only this installation's engine image, only the `core-recovery
# watch` command line, and only once the desktop it watches is verifiably gone.
# Every other process is still only asked to stop and waited for.
$script:RecoveryWatchGraceSeconds = 3
function Get-RecoveryWatchDesktopId($Process, [string]$InstallDir) {
    $path = $Process.PSObject.Properties['ExecutablePath']; $command = $Process.PSObject.Properties['CommandLine']
    if ($null -eq $path -or -not $path.Value -or $null -eq $command -or -not $command.Value) { return 0 }
    if ([string]$path.Value -ine (Join-Path $InstallDir 'resources\engine\orgtree-engine.exe')) { return 0 }
    $id = 0L
    if ([string]$command.Value -cmatch '^\s*(?:"[^"]*"|\S+)\s+core-recovery\s+watch\s+.+\s(\d{1,10})\s+\d{1,20}\s*$') { $id = [long]$Matches[1] }
    if ($id -le 0 -or $id -gt [int]::MaxValue) { return 0 }
    return [int]$id
}
# Gone: no process holds the id any more, or the one holding it is provably
# another: created after the observer (a desktop always predates its observer)
# or running an image from outside this installation. Unreadable counts as there.
function Test-WatchedDesktopGone($Processes, $Watcher, [int]$DesktopId, [string]$InstallDir) {
    foreach ($p in @($Processes | Where-Object { $null -ne $_ -and [int]$_.ProcessId -eq $DesktopId })) {
        $created = $p.PSObject.Properties['CreationDate']; $watched = $Watcher.PSObject.Properties['CreationDate']
        if ($null -ne $created -and $null -ne $watched -and $created.Value -is [datetime] -and $watched.Value -is [datetime] -and $created.Value -gt $watched.Value) { continue }
        $path = $p.PSObject.Properties['ExecutablePath']
        if ($null -ne $path -and $path.Value -and -not ([string]$path.Value).StartsWith($InstallDir+'\', [StringComparison]::OrdinalIgnoreCase)) { continue }
        return $false
    }
    return $true
}
# Ends one observer; an I/O boundary the tests replace. The handle taken first
# pins the process, so its id cannot pass to another process before the
# identity re-check, and the kill goes through that same handle.
function Stop-RecoveryWatchProcess($Watcher) {
    $id = [int]$Watcher.ProcessId
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -eq $process) { return }
    try {
        $null = $process.Handle
        $now = @(Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction Stop)
        if ($now.Count -ne 1 -or $now[0].CreationDate -ne $Watcher.CreationDate -or $now[0].ExecutablePath -ine $Watcher.ExecutablePath) { throw 'it is no longer the process that was checked' }
        $process.Kill()
        $null = $process.WaitForExit(5000)
    } finally { $process.Dispose() }
}
# $Processes is the caller's current reading; $true when an observer left or
# was ended, so the caller reads the table again.
function Stop-ClosedDesktopWatchers([string]$InstallDir, $Processes, [int]$GraceSeconds=$script:RecoveryWatchGraceSeconds) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $first = -1
    $processes = @($Processes | Where-Object { $null -ne $_ })
    do {
        $watchers = @(foreach ($p in $processes) {
            $desktop = Get-RecoveryWatchDesktopId $p $InstallDir
            if ($desktop -gt 0 -and (Test-WatchedDesktopGone $processes $p $desktop $InstallDir)) { [pscustomobject]@{Process=$p; Desktop=$desktop} }
        })
        if ($first -lt 0) { $first = $watchers.Count }
        if ($watchers.Count -eq 0) {
            if ($first -gt 0) { Write-BootLog "watcher: $first core-recovery observer(s) of a closed desktop stood down by themselves" }
            return ($first -gt 0)
        }
        if ($clock.Elapsed.TotalSeconds -ge $GraceSeconds) { break }
        Start-Sleep -Milliseconds 250
        $processes = @(Get-BootProcesses | Where-Object { $null -ne $_ })
    } while ($true)
    foreach ($w in $watchers) {
        $label = Get-BootProcessLabel $w.Process
        try { Stop-RecoveryWatchProcess $w.Process; Write-BootLog "watcher: ended $label; the desktop it watched (pid $($w.Desktop)) is gone" }
        catch { Write-BootLog "watcher: did not end $label : $($_.Exception.Message)" }
    }
    return $true
}
function Assert-BootProcessPaths($Processes, [string]$InstallDir) {
    foreach ($p in $Processes) {
        if ($null -eq $p -or $p.ExecutablePath -or [int]$p.ProcessId -in @(0,4)) { continue }
        $name=$p.PSObject.Properties['Name']
        $command=$p.PSObject.Properties['CommandLine']
        # Bound ambiguity to possible installed host/desktop images or a command
        # naming this installation. Unreadable unrelated Windows images are not
        # ours. Known descendants remain tracked by PID/creation date separately.
        $candidate=($null -eq $name -or -not $name.Value -or $name.Value -in @('python.exe','pythonw.exe','Orgtree.exe','orgtree-engine.exe',$script:HelperExe,$script:SigninHostExe))
        if ($null -ne $command -and $command.Value -and
            $command.Value.IndexOf($InstallDir+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0) { $candidate=$true }
        if ($candidate) {
            $label = '<unnamed>'; if ($null -ne $name -and $name.Value) { $label = $name.Value }
            $parent = $p.PSObject.Properties['ParentProcessId']; $parentText = '?'; if ($null -ne $parent -and $null -ne $parent.Value) { $parentText = $parent.Value }
            Write-BootLog "stop: cannot verify the executable path of process $($p.ProcessId) ($label, parent $parentText)"
            throw "Cannot verify executable path for process $($p.ProcessId) ($label, parent $parentText). Installation files must not be replaced."
        }
    }
}
# Orgtree 4: the Rust engine's own `host` mode is the boot supervisor when
# the build carries the binary; otherwise the Python service host. Python /
# Host name the task's Command and (quoted) Arguments either way.
function Get-BootPathForms([string]$InstallDir) {
    $engine = Join-Path $InstallDir 'resources\engine'
    $native = @{ Python=(Join-Path $engine 'orgtree-engine.exe'); Host='host'; Engine=$engine; Files=@((Join-Path $engine 'orgtree-engine.exe')) }
    $legacy = @{ Python=(Join-Path $engine 'runtime\python.exe'); Host=(Join-Path $engine 'service_host.py'); Engine=$engine
                 Files=@((Join-Path $engine 'runtime\python.exe'), (Join-Path $engine 'service_host.py')) }
    return @($native, $legacy)
}
function Get-BootPaths([string]$InstallDir) {
    $forms = Get-BootPathForms $InstallDir
    if ([IO.File]::Exists($forms[0].Python)) { return $forms[0] }
    return $forms[1]
}
function Assert-BootRecord($Record, [string]$InstallDir) {
    if ($null -eq $Record -or (Get-BootCanonicalPath $Record.InstallDir) -ine $InstallDir) { throw 'Boot ownership does not match this installation path.' }
    $null = Assert-BootSid $Record.OperatorSid
    $id = [guid]::Empty
    if (-not [guid]::TryParse($Record.Id, [ref]$id) -or $id -eq [guid]::Empty) { throw 'Invalid boot ownership record.' }
}
function Get-BootMarker($Record) { return "com.maurdekye.orgtree.boot.v1:$($Record.Id)" }
# "Run on boot" (it was "Run on startup"; docket
# start-at-login-off-means-nothing-of-orgtree-star): on, the boot task and the
# credential helper start; off, every task is registered disabled and nothing
# of Orgtree starts at boot or sign-in. Absent (an installation from before the
# choice was recorded) counts as on, the desktop's default.
function Test-RunOnStartup($Record) { return ($null -eq $Record['RunOnStartup'] -or [int]$Record['RunOnStartup'] -ne 0) }
function Get-EnabledText([bool]$Value) { if ($Value) { return 'true' } return 'false' }

# "Run Orgtree as administrator": exactly DWORD 1 under HKLM\SOFTWARE\Orgtree\Runtime,
# the rule the engine host applies (host.rs run_as_administrator). The
# credential helper then runs with the highest privileges, and so do the agent
# turns it starts in the operator's session, as the boot host keeps them for
# its own; otherwise with least privilege, the token the user's own programs
# get. An I/O boundary; the tests replace it.
function Get-RunAsAdministrator {
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
    try {
        $key = $hive.OpenSubKey('SOFTWARE\Orgtree\Runtime')
        if ($null -eq $key) { return $false }
        try { return ($key.GetValueKind('RunAsAdministrator') -eq [Microsoft.Win32.RegistryValueKind]::DWord -and [int]$key.GetValue('RunAsAdministrator') -eq 1) }
        catch { return $false }
        finally { $key.Dispose() }
    } finally { $hive.Dispose() }
}
function Read-BootXml([string]$Text) {
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($Text), $settings)
    try { $doc = [Xml.XmlDocument]::new(); $doc.XmlResolver = $null; $doc.Load($reader); return ,$doc }
    finally { $reader.Dispose() }
}
function Assert-OwnedBootTask($Task, $Record, [string]$InstallDir) {
    Assert-BootRecord $Record $InstallDir
    Assert-BootProtectedAcl ($Task.GetSecurityDescriptor(7)) 0x500D0116
    $xml = Read-BootXml $Task.Xml
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $matched = $false
    $lastKey = ''
    foreach ($paths in (Get-BootPathForms $InstallDir)) {
        $expected = @{
            '/t:Task/t:RegistrationInfo/t:Description'=(Get-BootMarker $Record)
            '/t:Task/t:Principals/t:Principal/t:UserId'=$Record.OperatorSid
            '/t:Task/t:Principals/t:Principal/t:LogonType'='S4U'
            '/t:Task/t:Actions/t:Exec/t:Command'=$paths.Python
            '/t:Task/t:Actions/t:Exec/t:Arguments'=('"'+$paths.Host+'"')
            '/t:Task/t:Actions/t:Exec/t:WorkingDirectory'=$paths.Engine
        }
        $ok = $true
        foreach ($pair in $expected.GetEnumerator()) {
            $nodes = $xml.SelectNodes($pair.Key, $ns)
            if ($nodes.Count -ne 1 -or $nodes[0].InnerText -cne $pair.Value) { $ok = $false; $lastKey = $pair.Key; break }
        }
        if ($ok) { $matched = $true; break }
    }
    if (-not $matched) { throw "Refusing foreign or changed boot task ($lastKey)." }
    # Task Scheduler omits the serialized LeastPrivilege default. Verify the
    # actual COM principal too, rather than accepting a missing security value.
    # Exactly two states (coordinator 2026-10-21 16:27Z, Q2): least privilege,
    # or the highest available while "Run as admin" is on.
    $runLevel=$xml.SelectNodes('/t:Task/t:Principals/t:Principal/t:RunLevel',$ns)
    $level='LeastPrivilege'; if ($runLevel.Count -eq 1) { $level=$runLevel[0].InnerText }
    $com=$Task.Definition.Principal.RunLevel
    if ($null -eq $com -or $runLevel.Count -gt 1 -or
        -not (($level -ceq 'LeastPrivilege' -and $com -eq 0) -or ($level -ceq 'HighestAvailable' -and $com -eq 1))) {
        throw 'Refusing foreign or changed boot task (principal run level).'
    }
    if ($xml.SelectNodes('/t:Task/t:Actions/*', $ns).Count -ne 1 -or $xml.SelectNodes('/t:Task/t:Principals/*', $ns).Count -ne 1) { throw 'Unexpected boot actions or principals.' }
}
# $Highest is "Run as admin" (Get-RunAsAdministrator): the Session 0 engine runs
# elevated while it is on (coordinator 2026-10-21 16:27Z, Q2), with no prompt.
function New-BootTaskXml($Record, [bool]$Highest = $false) {
    $paths = Get-BootPaths $Record.InstallDir
    # Serialize Unicode/XML escaping. Command is an unquoted path, not shell
    # text; the separate argument is the quoted service-host script path.
    $doc = Read-BootXml @'
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description /></RegistrationInfo><Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers><Principals><Principal id="Operator"><UserId /><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Operator"><Exec><Command /><Arguments /><WorkingDirectory /></Exec></Actions></Task>
'@
    $doc.Task.RegistrationInfo.Description = Get-BootMarker $Record
    $doc.Task.Settings.Enabled = 'true'
    $doc.Task.Triggers.BootTrigger.Enabled = Get-EnabledText (Test-RunOnStartup $Record)
    $doc.Task.Principals.Principal.UserId = $Record.OperatorSid
    if ($Highest) { $doc.Task.Principals.Principal.RunLevel = 'HighestAvailable' }
    $doc.Task.Actions.Exec.Command = [string]$paths.Python
    $doc.Task.Actions.Exec.Arguments = '"'+$paths.Host+'"'
    $doc.Task.Actions.Exec.WorkingDirectory = [string]$paths.Engine
    return $doc.OuterXml
}
# ---- the credential helper task (I/O boundaries first, for the tests)
function Find-HelperTask($Folder) {
    try { return $Folder.GetTask($script:HelperTaskName) }
    catch {
        if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return $null } # file not found only
        throw
    }
}
function Register-HelperTask($Folder, [string]$Xml, [int]$Flags, [string]$Sid, [string]$Sddl) {
    # 3 = TASK_LOGON_INTERACTIVE_TOKEN: runs only in the operator's signed-in session.
    return $Folder.RegisterTask($script:HelperTaskName, $Xml, $Flags, $Sid, $null, 3, $Sddl)
}
function Remove-HelperTask($Folder) { $Folder.DeleteTask($script:HelperTaskName, 0) }
function Stop-HelperProcess($Process) { Stop-Process -Id ([int]$Process.ProcessId) -Force -ErrorAction SilentlyContinue }
function Get-HelperPath([string]$InstallDir) { return (Join-Path (Join-Path $InstallDir 'resources\engine') $script:HelperExe) }
function Get-HelperMarker($Record) { return "com.maurdekye.orgtree.credential-helper.v1:$($Record.Id)" }
# $Highest is "Run Orgtree as administrator" (Get-RunAsAdministrator): the
# agent turns the helper starts in the operator's session run with its token.
function New-HelperTaskXml($Record, [bool]$Highest) {
    $doc = Read-BootXml @'
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description /></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId /></LogonTrigger></Triggers><Principals><Principal id="Operator"><UserId /><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Operator"><Exec><Command /><WorkingDirectory /></Exec></Actions></Task>
'@
    $doc.Task.RegistrationInfo.Description = Get-HelperMarker $Record
    $doc.Task.Settings.Enabled = 'true'
    $doc.Task.Triggers.LogonTrigger.Enabled = Get-EnabledText (Test-RunOnStartup $Record)
    $doc.Task.Triggers.LogonTrigger.UserId = $Record.OperatorSid
    $doc.Task.Principals.Principal.UserId = $Record.OperatorSid
    if ($Highest) { $doc.Task.Principals.Principal.RunLevel = 'HighestAvailable' }
    $doc.Task.Actions.Exec.Command = [string](Get-HelperPath $Record.InstallDir)
    $doc.Task.Actions.Exec.WorkingDirectory = [string](Join-Path $Record.InstallDir 'resources\engine')
    return $doc.OuterXml
}
function Assert-OwnedHelperTask($Task, $Record, [string]$InstallDir) {
    Assert-BootRecord $Record $InstallDir
    Assert-BootProtectedAcl ($Task.GetSecurityDescriptor(7)) 0x500D0116
    $xml = Read-BootXml $Task.Xml
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $expected = @{
        '/t:Task/t:RegistrationInfo/t:Description'=(Get-HelperMarker $Record)
        '/t:Task/t:Principals/t:Principal/t:UserId'=$Record.OperatorSid
        '/t:Task/t:Principals/t:Principal/t:LogonType'='InteractiveToken'
        '/t:Task/t:Actions/t:Exec/t:Command'=(Get-HelperPath $InstallDir)
    }
    foreach ($pair in $expected.GetEnumerator()) {
        $nodes = $xml.SelectNodes($pair.Key, $ns)
        if ($nodes.Count -ne 1 -or $nodes[0].InnerText -cne $pair.Value) { throw "Refusing foreign or changed credential helper task ($($pair.Key))." }
    }
    # Least privilege (which Task Scheduler omits from the XML) or, with "Run
    # Orgtree as administrator", the highest available; the COM principal must agree.
    $levels = $xml.SelectNodes('/t:Task/t:Principals/t:Principal/t:RunLevel', $ns)
    $level = 'LeastPrivilege'
    if ($levels.Count -eq 1) { $level = $levels[0].InnerText }
    $com = $Task.Definition.Principal.RunLevel
    if ($levels.Count -gt 1 -or $null -eq $com -or -not (($level -ceq 'LeastPrivilege' -and $com -eq 0) -or ($level -ceq 'HighestAvailable' -and $com -eq 1))) {
        throw 'Refusing foreign or changed credential helper task (principal run level).'
    }
    if ($xml.SelectNodes('/t:Task/t:Actions/*', $ns).Count -ne 1 -or $xml.SelectNodes('/t:Task/t:Principals/*', $ns).Count -ne 1) { throw 'Unexpected credential helper actions or principals.' }
}
# Separate from the retired 4.3.x sign-in host. Its immutable action is native;
# no script path or caller-supplied argument can become an elevated command.
function Find-InteractiveTask($Folder) {
    try { return $Folder.GetTask($script:InteractiveTaskName) }
    catch { if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return $null }; throw }
}
function Remove-InteractiveTask($Folder) { $Folder.DeleteTask($script:InteractiveTaskName,0) }
function Get-InteractiveMarker($Record) { return "com.maurdekye.orgtree.user-session.v1:$($Record.Id)" }
# The "Orgtree User Session Engine" task of 4.4.0 alphas 27 to 32 (decision
# 93: it moved the engine into the operator's session). Decision 94 retires it:
# the engine always runs in Session 0, so an update stops it with the boot tree
# and deletes it, only when it is the installer's own (below), and never
# registers it again; uninstall deletes a leftover.
function Assert-OwnedInteractiveTask($Task,$Record,[string]$InstallDir) {
    Assert-BootRecord $Record $InstallDir
    Assert-BootProtectedAcl ($Task.GetSecurityDescriptor(7)) 0x500D0116
    $doc=Read-BootXml $Task.Xml
    $ns=[Xml.XmlNamespaceManager]::new($doc.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $expected=@{
        '/t:Task/t:RegistrationInfo/t:Description'=(Get-InteractiveMarker $Record)
        '/t:Task/t:Principals/t:Principal/t:UserId'=$Record.OperatorSid
        '/t:Task/t:Principals/t:Principal/t:LogonType'='InteractiveToken'
        '/t:Task/t:Actions/t:Exec/t:Command'=(Get-HelperPath $InstallDir)
        '/t:Task/t:Actions/t:Exec/t:Arguments'='session-engine'
        '/t:Task/t:Actions/t:Exec/t:WorkingDirectory'=(Join-Path $InstallDir 'resources\engine')
    }
    foreach ($pair in $expected.GetEnumerator()) {
        $nodes=$doc.SelectNodes($pair.Key,$ns)
        if ($nodes.Count -ne 1 -or $nodes[0].InnerText -cne $pair.Value) { throw "Refusing foreign or changed interactive engine task ($($pair.Key))." }
    }
    $levels=$doc.SelectNodes('/t:Task/t:Principals/t:Principal/t:RunLevel',$ns)
    $level='LeastPrivilege'; if ($levels.Count -eq 1) { $level=$levels[0].InnerText }
    $com=$Task.Definition.Principal.RunLevel
    if ($levels.Count -gt 1 -or -not (($level -ceq 'LeastPrivilege' -and $com -eq 0) -or ($level -ceq 'HighestAvailable' -and $com -eq 1))) { throw 'Refusing changed interactive task run level.' }
    if ($doc.SelectNodes('/t:Task/t:Actions/*',$ns).Count -ne 1 -or $doc.SelectNodes('/t:Task/t:Principals/*',$ns).Count -ne 1) { throw 'Unexpected interactive task actions or principals.' }
}
# Before the boot tree is stopped: the broker runs from the engine folder, so
# a running one would hold the installation open. Disable its task (no
# restart while files are replaced), end it, and end any broker from this
# installation that the task did not start.
function Stop-OwnedHelperTask($Folder, $Record, [string]$InstallDir, [int]$TimeoutSeconds=10) {
    $task = Find-HelperTask $Folder
    if ($null -ne $task) {
        if ($null -eq $Record) { throw 'Credential helper task exists without installer ownership. It will not be changed.' }
        Assert-OwnedHelperTask $task $Record $InstallDir
        $task.Enabled = $false
        $task.Stop(0)
    }
    $exe = Get-HelperPath $InstallDir
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        $mine = @(Get-BootProcesses | Where-Object { $null -ne $_ -and $_.ExecutablePath -and $_.ExecutablePath -ieq $exe })
        if ($mine.Count -eq 0) { return }
        foreach ($p in $mine) { Stop-HelperProcess $p }
        if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'The credential helper did not stop. Installation files must not be replaced.' }
        Start-Sleep -Milliseconds 200
    } while ($true)
}
# ---- the engine at sign-in from 4.3.x, which an update stops and deletes
# (I/O boundaries first, for the tests)
function Find-SigninTask($Folder) {
    try { return $Folder.GetTask($script:SigninTaskName) }
    catch {
        if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return $null } # file not found only
        throw
    }
}
function Remove-SigninTask($Folder) { $Folder.DeleteTask($script:SigninTaskName, 0) }
function Get-SigninHostPath([string]$InstallDir) { return (Join-Path (Join-Path $InstallDir 'resources\engine') $script:SigninHostExe) }
function Get-SigninMarker($Record) { return "com.maurdekye.orgtree.signin-engine.v1:$($Record.Id)" }
# The task 4.3.x registered: the operator's logon, their interactive token, the
# windowless host, at either run level. Nothing else is deleted as ours.
function Assert-OwnedSigninTask($Task, $Record, [string]$InstallDir) {
    Assert-BootRecord $Record $InstallDir
    Assert-BootProtectedAcl ($Task.GetSecurityDescriptor(7)) 0x500D0116
    $xml = Read-BootXml $Task.Xml
    $ns = [Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $expected = @{
        '/t:Task/t:RegistrationInfo/t:Description'=(Get-SigninMarker $Record)
        '/t:Task/t:Principals/t:Principal/t:UserId'=$Record.OperatorSid
        '/t:Task/t:Principals/t:Principal/t:LogonType'='InteractiveToken'
        '/t:Task/t:Actions/t:Exec/t:Command'=(Get-SigninHostPath $InstallDir)
    }
    foreach ($pair in $expected.GetEnumerator()) {
        $nodes = $xml.SelectNodes($pair.Key, $ns)
        if ($nodes.Count -ne 1 -or $nodes[0].InnerText -cne $pair.Value) { throw "Refusing foreign or changed sign-in engine task ($($pair.Key))." }
    }
    # Least privilege (which Task Scheduler omits from the XML) or, with "Run
    # Orgtree as administrator", the highest available; the COM principal must agree.
    $levels = $xml.SelectNodes('/t:Task/t:Principals/t:Principal/t:RunLevel', $ns)
    $level = 'LeastPrivilege'
    if ($levels.Count -eq 1) { $level = $levels[0].InnerText }
    $com = $Task.Definition.Principal.RunLevel
    if ($levels.Count -gt 1 -or $null -eq $com -or -not (($level -ceq 'LeastPrivilege' -and $com -eq 0) -or ($level -ceq 'HighestAvailable' -and $com -eq 1))) {
        throw 'Refusing foreign or changed sign-in engine task (principal run level).'
    }
    if ($xml.SelectNodes('/t:Task/t:Actions/*', $ns).Count -ne 1 -or $xml.SelectNodes('/t:Task/t:Principals/*', $ns).Count -ne 1) { throw 'Unexpected sign-in engine actions or principals.' }
}
function Get-BootTree($Processes, [string]$InstallDir, $Known) {
    $Processes = @($Processes | Where-Object { $null -ne $_ })
    # CIM can lose an exiting process's path before the process disappears.
    # An exact previously captured PID + creation time stays LIVE below; only
    # its path re-validation is unnecessary. Unknown/reused identities refuse.
    $unidentified = @($Processes | Where-Object { -not $_.CreationDate -or -not $Known.ContainsKey((Get-BootProcessKey $_)) })
    Assert-BootProcessPaths $unidentified $InstallDir
    $paths = Get-BootPaths $InstallDir
    $parents = @{}
    foreach ($p in $Processes) {
        $key = Get-BootProcessKey $p
        if ($Known.ContainsKey($key) -or ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($paths.Engine+'\', [StringComparison]::OrdinalIgnoreCase))) {
            $Known[$key]=$true; $parents[[int]$p.ProcessId]=$true
        }
    }
    do {
        $added = $false
        foreach ($p in $Processes) {
            $key = Get-BootProcessKey $p
            if ($parents.ContainsKey([int]$p.ParentProcessId) -and -not $Known.ContainsKey($key)) {
                $Known[$key]=$true; $parents[[int]$p.ProcessId]=$true; $added=$true
            }
        }
    } while ($added)
    return @($Processes | Where-Object { $Known.ContainsKey((Get-BootProcessKey $_)) })
}
# The budget covers the engine's own stop: its agents (8 s), its mail hub (15 s)
# and PostgreSQL (up to 120 s on a busy disk) before it exits.
function Stop-OwnedBootTask($Folder, $Record, [string]$InstallDir, [int]$TimeoutSeconds=150) {
    $task = Find-BootTask $Folder
    # 4.3.x's engine at sign-in may still run from this installation, under its
    # own task, until the update that deletes that task (Register).
    $signin = Find-SigninTask $Folder
    $interactive = Find-InteractiveTask $Folder
    $processes = @(Get-BootProcesses)
    # Before the tree is captured: a closed desktop's observer is not the engine.
    if (Stop-ClosedDesktopWatchers $InstallDir $processes) { $processes = @(Get-BootProcesses) }
    $known = @{}
    $running = @(Get-BootTree $processes $InstallDir $known)
    Write-BootLog "stop: $($running.Count) process(es) in the boot tree$(if ($running.Count) { ': ' + ((@($running | Select-Object -First 10 | ForEach-Object { Get-BootProcessLabel $_ })) -join '; ') })"
    $disabledByUs = $false
    $wasEnabled = $false
    $signinDisabledByUs = $false
    $signinWasEnabled = $false
    $interactiveDisabledByUs = $false
    $interactiveWasEnabled = $false
    try {
        # Both tasks are verified before either is changed.
        if ($null -ne $task) { Assert-OwnedBootTask $task $Record $InstallDir }
        if ($null -ne $signin) { Assert-OwnedSigninTask $signin $Record $InstallDir }
        if ($null -ne $interactive) { Assert-OwnedInteractiveTask $interactive $Record $InstallDir }
        if ($null -ne $task -or $null -ne $signin -or $null -ne $interactive) {
            # Stop only after ownership; disable first so restart-on-failure (or a
            # sign-in) cannot relaunch the engine while the installer replaces its files.
            if ($null -ne $task) { $wasEnabled = [bool]$task.Enabled; $disabledByUs = $true; $task.Enabled = $false }
            if ($null -ne $signin) { $signinWasEnabled = [bool]$signin.Enabled; $signinDisabledByUs = $true; $signin.Enabled = $false }
            if ($null -ne $interactive) { $interactiveWasEnabled = [bool]$interactive.Enabled; $interactiveDisabledByUs = $true; $interactive.Enabled = $false }
            # Graceful first (docket installer-can-t-replace-a-running-orgtree-an-ins):
            # the engine is asked to stop, so it ends its agents' CLIs itself.
            # Whichever task's host it is, the engine publishes the same descriptor.
            # An installer that cannot read the descriptor (another administrator)
            # asks through its own record instead (docket installer-s-end-task-
            # fallback-no-longer-stops-th): ending a task ends only its host, and
            # since the core-lifecycle recovery (2026-10-12) an engine outlives its
            # host, so that alone left it running and this step timed out. A task
            # ended any other way (a manual End) still leaves its engine running.
            # The record first, always (docket after-an-update-or-engine-restart-
            # while-the-user, 2026-10-21): a boot host that waits beside an engine in
            # the operator's session holds this installation open and stops only by
            # it; engines read it too, so asking through the descriptor after it is
            # only faster.
            $asked = $false
            if ($running.Count -ne 0) {
                if (Request-BootEngineStopByRecord) { Write-BootLog "stop: recorded a stop request in the installer's record" }
                else { Write-BootLog "stop: could not record a stop request in the installer's record" }
                $asked = [bool](Request-BootEngineShutdown $Record $InstallDir)
            }
            if ($asked) { Write-BootLog 'stop: the engine took the shutdown request' }
            else {
                $ended = @()
                if ($null -ne $task) { $task.Stop(0); $ended += 'the boot task' }
                if ($null -ne $signin) { $signin.Stop(0); $ended += 'the sign-in engine task' }
                Write-BootLog "stop: ended $($ended -join ' and ')"
            }
        } elseif ($known.Count -ne 0) { throw 'Engine running without an owned boot task. Close Orgtree before continuing.' }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            $task = Find-BootTask $Folder
            $signin = Find-SigninTask $Folder
            $interactive = Find-InteractiveTask $Folder
            $instances = 0
            $busy = @()
            if ($null -ne $task) {
                Assert-OwnedBootTask $task $Record $InstallDir
                if ($task.Enabled) { throw 'Boot task re-enabled during stop; installation aborted.' }
                $count = $task.GetInstances(0).Count
                if ($task.State -in @(2,4)) { $count++ } # QUEUED or RUNNING also prevents copy
                if ($count -gt 0) { $busy += "the $script:BootTaskName task ($count instance(s) running)" }
                $instances += $count
            }
            if ($null -ne $signin) {
                Assert-OwnedSigninTask $signin $Record $InstallDir
                if ($signin.Enabled) { throw 'Sign-in engine task re-enabled during stop; installation aborted.' }
                $count = $signin.GetInstances(0).Count
                if ($signin.State -in @(2,4)) { $count++ }
                if ($count -gt 0) { $busy += "the $script:SigninTaskName task ($count instance(s) running)" }
                $instances += $count
            }
            $remaining = @(Get-BootTree (Get-BootProcesses) $InstallDir $known)
            if ($null -ne $interactive) {
                Assert-OwnedInteractiveTask $interactive $Record $InstallDir
                if ($interactive.Enabled) { throw 'Interactive engine task re-enabled during stop; installation aborted.' }
                $count = $interactive.GetInstances(0).Count
                if ($interactive.State -in @(2,4)) { $count++ }
                if ($count -gt 0) { $busy += "the $script:InteractiveTaskName task ($count instance(s) running)" }
                $instances += $count
            }
            if ($instances -eq 0 -and $remaining.Count -eq 0) { Write-BootLog "stop: the boot tree is quiet after $([int]$clock.Elapsed.TotalSeconds) s"; return }
            if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                # Name what is still running (docket installer-can-t-replace-a-running-
                # orgtree-an-ins, 2026-10-14: the dialog of two failed real upgrades
                # named nothing). The dialog shows the first few; the log has all.
                $held = @($busy) + @($remaining | ForEach-Object { Get-BootProcessLabel $_ })
                foreach ($line in $held) { Write-BootLog "stop: still running after $TimeoutSeconds s: $line" }
                $shown = @($held | Select-Object -First 5)
                $more = ''
                if ($held.Count -gt $shown.Count) { $more = " and $($held.Count - $shown.Count) more (all are listed in $(Get-BootLogPath))" }
                throw "The Orgtree background engine or a process it started did not stop within $TimeoutSeconds seconds, so its files were not replaced. Still running: $($shown -join '; ')$more. Open Orgtree, choose Quit Orgtree from its tray menu, then run Setup again."
            }
            Start-Sleep -Milliseconds 200
        } while ($true)
    } catch {
        $stopError = $_
        if ($disabledByUs) {
            try {
                $restoreTask = Find-BootTask $Folder
                if ($null -eq $restoreTask) { throw "Owned boot task disappeared during stop." }
                Assert-OwnedBootTask $restoreTask $Record $InstallDir
                $restoreTask.Enabled = $wasEnabled
            } catch { Write-Warning "Could not restore boot task state after failed stop: $_" }
        }
        if ($signinDisabledByUs) {
            try {
                $restoreTask = Find-SigninTask $Folder
                if ($null -eq $restoreTask) { throw "Owned sign-in engine task disappeared during stop." }
                Assert-OwnedSigninTask $restoreTask $Record $InstallDir
                $restoreTask.Enabled = $signinWasEnabled
            } catch { Write-Warning "Could not restore sign-in engine task state after failed stop: $_" }
        }
        if ($interactiveDisabledByUs) {
            try {
                $restoreTask = Find-InteractiveTask $Folder
                if ($null -eq $restoreTask) { throw 'Owned interactive engine task disappeared during stop.' }
                Assert-OwnedInteractiveTask $restoreTask $Record $InstallDir
                $restoreTask.Enabled = $interactiveWasEnabled
            } catch { Write-Warning "Could not restore interactive engine task state after failed stop: $_" }
        }
        throw $stopError
    }
}
function Assert-BootDesktopClosed([string]$InstallDir) {
    $processes=@(Get-BootProcesses)
    Assert-BootProcessPaths $processes $InstallDir
    $engine=(Get-BootPaths $InstallDir).Engine+'\'
    # Every executable in the install tree outside the separately stopped
    # engine tree must be closed, including renamed desktop/helper binaries.
    # Existing recorded InstallDir must equal this path before reaching here.
    if (@($processes | Where-Object { $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($InstallDir+'\',[StringComparison]::OrdinalIgnoreCase) -and
        -not $_.ExecutablePath.StartsWith($engine,[StringComparison]::OrdinalIgnoreCase) }).Count) {
        throw 'Close the Orgtree desktop before installing or uninstalling.'
    }
}
function Invoke-BootLifecycleCore {
    param([ValidateSet('Prepare','Register','Remove','Stop')][string]$Action,
          [string]$InstallDir, [string]$OperatorSid, [string]$InstallMode='all', [switch]$DeferStart)
    # Per-user installs do not even query production task or ownership key.
    if ($InstallMode -ne 'all') { return }
    $InstallDir = Get-BootCanonicalPath $InstallDir
    $record = Get-BootRecord
    $folder = Get-BootFolder
    $task = Find-BootTask $folder
    $signin = Find-SigninTask $folder
    $interactive = Find-InteractiveTask $folder
    if ($null -eq $record) {
        if ($null -ne $task) { throw 'Task name exists without installer ownership. It will not be changed.' }
        if ($null -ne (Find-HelperTask $folder)) { throw 'Credential helper task exists without installer ownership. It will not be changed.' }
        if ($null -ne $signin) { throw 'Sign-in engine task exists without installer ownership. It will not be changed.' }
        if ($null -ne $interactive) { throw 'Interactive engine task exists without installer ownership. It will not be changed.' }
        if ($Action -in @('Remove','Stop')) {
            Assert-BootDesktopClosed $InstallDir
            Stop-OwnedHelperTask $folder $null $InstallDir
            Stop-OwnedBootTask $folder $null $InstallDir
            return
        }
        if ($Action -ne 'Prepare') { throw 'Boot installation was not prepared.' }
        $record = @{InstallDir=$InstallDir; OperatorSid=(Assert-BootSid $OperatorSid); Id=([guid]::NewGuid().ToString())}
    } else {
        Assert-BootRecord $record $InstallDir
        if ($null -ne $task) { Assert-OwnedBootTask $task $record $InstallDir }
        $helper = Find-HelperTask $folder
        if ($null -ne $helper) { Assert-OwnedHelperTask $helper $record $InstallDir }
        if ($null -ne $signin) { Assert-OwnedSigninTask $signin $record $InstallDir }
        if ($null -ne $interactive) { Assert-OwnedInteractiveTask $interactive $record $InstallDir }
        # Existing operator remains authoritative during alternate-admin updates.
    }
    # 4.3.x's StartupMode is gone with its choice: the engine always starts at
    # boot, and an engine that started at sign-in runs on boot from now on
    # (Run on boot itself is unchanged, so off stays off). Save-BootRecord
    # deletes the value.
    $record.Remove('StartupMode')
    # Run on boot (docket start-at-login-off-means-nothing-of-orgtree-star):
    # an installation that has not recorded the operator's choice yet takes it
    # from their own setting, else on. Never from the task's state: an update
    # disables the task while it replaces files, so a disabled task may only be
    # an update that did not finish.
    if ($Action -eq 'Prepare' -and $null -eq $record['RunOnStartup']) {
        $choice = Get-OperatorStartupChoice $record.OperatorSid
        if ($null -eq $choice) { $choice = $true }
        $record['RunOnStartup'] = [int][bool]$choice
    }
    Assert-BootDesktopClosed $InstallDir
    Stop-OwnedHelperTask $folder $record $InstallDir
    switch ($Action) {
        'Prepare' { Stop-OwnedBootTask $folder $record $InstallDir; Save-BootRecord $record }
        'Stop' { Stop-OwnedBootTask $folder $record $InstallDir }
        'Remove' {
            Stop-OwnedBootTask $folder $record $InstallDir
            $task = Find-BootTask $folder
            if ($null -ne $task) { Assert-OwnedBootTask $task $record $InstallDir; $folder.DeleteTask($script:BootTaskName,0) }
            if ($null -ne (Find-BootTask $folder)) { throw 'Boot task removal not confirmed.' }
            if ($null -ne (Find-HelperTask $folder)) { Remove-HelperTask $folder }
            if ($null -ne (Find-HelperTask $folder)) { throw 'Credential helper task removal not confirmed.' }
            if ($null -ne (Find-SigninTask $folder)) { Remove-SigninTask $folder }
            if ($null -ne (Find-SigninTask $folder)) { throw 'Sign-in engine task removal not confirmed.' }
            if ($null -ne (Find-InteractiveTask $folder)) { Remove-InteractiveTask $folder }
            if ($null -ne (Find-InteractiveTask $folder)) { throw 'Interactive engine task removal not confirmed.' }
            Remove-BootRecord
        }
        'Register' {
            Stop-OwnedBootTask $folder $record $InstallDir
            # The engine at sign-in from 4.3.x, stopped above with the boot
            # tree, is deleted: agents now reach the signed-in session through
            # the credential helper (coordinator ruling E, 2026-10-16).
            $signin = Find-SigninTask $folder
            if ($null -ne $signin) {
                Assert-OwnedSigninTask $signin $record $InstallDir
                Remove-SigninTask $folder
                if ($null -ne (Find-SigninTask $folder)) { throw 'Sign-in engine task removal not confirmed.' }
            }
            # The user-session engine of 4.4.0 alphas, stopped above with the boot
            # tree, is deleted: the engine always runs in Session 0 (decision 94).
            $interactive = Find-InteractiveTask $folder
            if ($null -ne $interactive) {
                Assert-OwnedInteractiveTask $interactive $record $InstallDir
                Remove-InteractiveTask $folder
                if ($null -ne (Find-InteractiveTask $folder)) { throw 'Interactive engine task removal not confirmed.' }
            }
            $paths = Get-BootPaths $InstallDir
            foreach ($path in $paths.Files) { if (-not [IO.File]::Exists($path)) { throw "Missing installed engine file: $path" } }
            $task = Find-BootTask $folder
            # DONT_ADD_PRINCIPAL_ACE preserves the explicit read/execute-only operator ACL.
            $flags = 18 # TASK_CREATE | TASK_DONT_ADD_PRINCIPAL_ACE: never overwrite a collision.
            if ($null -ne $task) { Assert-OwnedBootTask $task $record $InstallDir; $flags=20 } # verified TASK_UPDATE only
            # Ownership accepts older task priorities. Register
            # always writes explicit Normal priority (Task Scheduler value 5), including upgrades.
            $sddl = "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$($record.OperatorSid))"
            $bootXml=New-BootTaskXml $record (Get-RunAsAdministrator)
            if ($DeferStart) { $doc=Read-BootXml $bootXml; $doc.Task.Settings.Enabled='false'; $bootXml=$doc.OuterXml }
            $registered = $folder.RegisterTask($script:BootTaskName,$bootXml,$flags,$record.OperatorSid,$null,2,$sddl)
            Assert-OwnedBootTask $registered $record $InstallDir
            # Paired release requirement: desktop startup must retry authenticated
            # attachment after losing the data-root lock to this newly started host.
            # Fresh install and update both start the host; do not ship without
            # Fable's startup/attach race handling and its packaged acceptance.
            # With "Run on boot" off the task is registered disabled and not
            # started: nothing of Orgtree runs until the user opens it.
            $runs = Test-RunOnStartup $record
            # The sign-in credential broker ships with the native engine only.
            # It follows Run on boot; its run level follows "Run Orgtree as
            # administrator", because the agent turns it starts in the
            # operator's session run with its token. Started now as well when
            # the operator is signed in; otherwise at their next sign-in. Its
            # Run failing never fails the install.
            if ([IO.File]::Exists((Get-HelperPath $InstallDir))) {
                $helperFlags = 18
                $helper = Find-HelperTask $folder
                if ($null -ne $helper) { Assert-OwnedHelperTask $helper $record $InstallDir; $helperFlags = 20 }
                $helperXml=New-HelperTaskXml $record (Get-RunAsAdministrator)
                if ($DeferStart) { $doc=Read-BootXml $helperXml; $doc.Task.Settings.Enabled='false'; $helperXml=$doc.OuterXml }
                $helperTask = Register-HelperTask $folder $helperXml $helperFlags $record.OperatorSid $sddl
                Assert-OwnedHelperTask $helperTask $record $InstallDir
                if ($runs -and -not $DeferStart) { try { $null = $helperTask.Run($null) } catch { Write-Warning "The credential helper starts at the operator's next sign-in: $_" } }
            }
            # Started last, after the helper: the engine starts in Session 0, where
            # it always runs (decision 94), and the helper, already waiting while
            # the operator is signed in, attaches to it within one poll.
            if ($runs -and -not $DeferStart) { $null = $registered.Run($null) }
        }
    }
}

# A protected registry value, not a caller-writable temporary XML file. Prepare,
# old uninstaller, copy and Register run in different processes; the snapshot
# therefore outlives each helper. Failed restoration retains it for diagnosis.
function Get-BootInstallSnapshot {
    $hive=[Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine','Registry64')
    try {
        $key=$hive.OpenSubKey($script:BootSnapshotKey)
        if ($null -eq $key) { return $null }
        try {
            Assert-BootRegistryKey $key
            $text=[string]$key.GetValue('Snapshot')
            if (-not $text -or $text.Length -gt 262144) { throw 'Invalid installer rollback snapshot.' }
            return (ConvertFrom-Json $text)
        } finally { $key.Dispose() }
    } finally { $hive.Dispose() }
}
function Save-BootInstallSnapshot($Snapshot) {
    $text=ConvertTo-Json -InputObject $Snapshot -Depth 8 -Compress
    if ($text.Length -gt 262144) { throw 'Installer rollback snapshot is too large; no tasks were suspended.' }
    $hive=[Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine','Registry64')
    try {
        $acl=[Security.AccessControl.RegistrySecurity]::new()
        $acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;KR;;;BU)')
        $key=$hive.CreateSubKey($script:BootSnapshotKey,[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,$acl)
        try { Assert-BootRegistryKey $key; $key.SetValue('Snapshot',$text,'String') }
        finally { $key.Dispose() }
    } finally { $hive.Dispose() }
}
function Remove-BootInstallSnapshot {
    $hive=[Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine','Registry64')
    try {
        $key=$hive.OpenSubKey($script:BootSnapshotKey)
        if ($null -eq $key) { return }
        try { Assert-BootRegistryKey $key } finally { $key.Dispose() }
        $hive.DeleteSubKey($script:BootSnapshotKey,$false)
    } finally { $hive.Dispose() }
}
function Get-BootInstallTasks($Folder,$Record,[string]$InstallDir) {
    $items=@(
        @{Kind='boot';Name=$script:BootTaskName;Task=(Find-BootTask $Folder);Logon=2},
        @{Kind='helper';Name=$script:HelperTaskName;Task=(Find-HelperTask $Folder);Logon=3},
        @{Kind='signin';Name=$script:SigninTaskName;Task=(Find-SigninTask $Folder);Logon=3},
        @{Kind='interactive';Name=$script:InteractiveTaskName;Task=(Find-InteractiveTask $Folder);Logon=3}
    )
    # Verify ALL existing tasks before any snapshot/restore writes.
    foreach ($item in $items) {
        if ($null -eq $item.Task) { continue }
        if ($null -eq $Record) { throw 'Task exists without installer ownership. It will not be changed.' }
        switch ($item.Kind) {
            boot { Assert-OwnedBootTask $item.Task $Record $InstallDir }
            helper { Assert-OwnedHelperTask $item.Task $Record $InstallDir }
            signin { Assert-OwnedSigninTask $item.Task $Record $InstallDir }
            interactive { Assert-OwnedInteractiveTask $item.Task $Record $InstallDir }
        }
    }
    return $items
}
function Assert-BootInstallSnapshot($Snapshot,[string]$InstallDir,$Record) {
    if ($Snapshot.Version -ne 1 -or (Get-BootCanonicalPath $Snapshot.InstallDir) -ine $InstallDir) { throw 'Installer rollback snapshot belongs to another installation.' }
    if ($null -ne $Snapshot.Record) {
        Assert-BootRecord $Snapshot.Record $InstallDir
        if ($null -ne $Record -and $Record.Id -cne $Snapshot.Record.Id) { throw 'Installer ownership changed since Prepare.' }
    }
    if (@($Snapshot.Tasks).Count -ne 4) { throw 'Incomplete installer rollback snapshot.' }
}
function Get-BootTriggerStates([string]$Xml) {
    $doc=Read-BootXml $Xml
    foreach ($trigger in $doc.SelectNodes('/*[local-name()="Task"]/*[local-name()="Triggers"]/*')) {
        $enabled=$trigger.SelectSingleNode('*[local-name()="Enabled"]')
        # Task Scheduler omits default true values when normalizing XML.
        $on=($null -eq $enabled -or $enabled.InnerText -cne 'false')
        "$($trigger.LocalName):$on"
    }
}
function Restore-BootInstallTasks([string]$InstallDir) {
    $snapshot=Get-BootInstallSnapshot
    if ($null -eq $snapshot) { return }
    $record=Get-BootRecord
    Assert-BootInstallSnapshot $snapshot $InstallDir $record
    if ($null -ne $record) { Assert-BootRecord $record $InstallDir }
    $owner=$record
    if ($null -eq $owner) { $owner=$snapshot.Record }
    $folder=Get-BootFolder
    $current=@(Get-BootInstallTasks $folder $owner $InstallDir)
    for ($i=0;$i -lt $current.Count;$i++) {
        $item=$current[$i];$saved=$snapshot.Tasks[$i]
        if ($saved.Kind -cne $item.Kind) { throw 'Installer rollback task identity changed.' }
    }
    $failures=@()
    for ($i=0;$i -lt $current.Count;$i++) {
        $item=$current[$i];$saved=$snapshot.Tasks[$i]
        try {
            if ($null -eq $saved.Xml) {
                if ($null -ne $item.Task) { $folder.DeleteTask($item.Name,0) }
                continue
            }
            # Full original XML retains every trigger (including mixed states),
            # with its original principal/ACL. Suppress registration triggers and
            # never call Run: restoring configuration is not a recovery launch.
            $flags=50 # CREATE | DONT_ADD_PRINCIPAL_ACE | IGNORE_REGISTRATION_TRIGGERS
            if ($null -ne $item.Task) { $flags=52 } # UPDATE, never overwrite a foreign task
            if ($item.Kind -eq 'helper') {
                $task=Register-HelperTask $folder $saved.Xml $flags $owner.OperatorSid $saved.Sddl
            } else {
                $task=$folder.RegisterTask($item.Name,$saved.Xml,$flags,$owner.OperatorSid,$null,$item.Logon,$saved.Sddl)
            }
            $task.Enabled=[bool]$saved.Enabled
            if ([bool]$task.Enabled -ne [bool]$saved.Enabled) { throw 'Restored task enablement did not read back.' }
            $expected=@(Get-BootTriggerStates $saved.Xml);$actual=@(Get-BootTriggerStates $task.Xml)
            if ($expected.Count -ne $actual.Count -or ($expected.Count -gt 0 -and (Compare-Object $expected $actual -SyncWindow 0))) { throw 'Restored trigger states did not read back.' }
        } catch {
            $failures+="$($item.Name): $($_.Exception.Message)"
        }
    }
    if ($failures.Count) { throw "Task rollback incomplete: $($failures -join '; ')" }
    if ($null -eq $snapshot.Record -and $null -ne $record) { Remove-BootRecord }
    Remove-BootInstallSnapshot
    Write-BootLog 'rollback: restored original owned task enablement and all trigger states; no tasks started'
}
function Invoke-BootLifecycle {
    param([ValidateSet('Prepare','Register','Remove','Stop','Rollback','Commit')][string]$Action,
          [string]$InstallDir,[string]$OperatorSid,[string]$InstallMode='all',[switch]$DeferStart)
    if ($InstallMode -ne 'all') { return }
    $InstallDir=Get-BootCanonicalPath $InstallDir
    if ($Action -eq 'Rollback') { Restore-BootInstallTasks $InstallDir; return }
    if ($Action -in @('Stop','Remove')) {
        Invoke-BootLifecycleCore $Action $InstallDir $OperatorSid $InstallMode
        if ($Action -eq 'Remove') { Remove-BootInstallSnapshot }
        return
    }
    try {
    if ($Action -eq 'Commit') {
        $snapshot=Get-BootInstallSnapshot
        if ($null -eq $snapshot) { return } # idempotent; never launch twice
        $record=Get-BootRecord
        Assert-BootInstallSnapshot $snapshot $InstallDir $record
        Assert-BootRecord $record $InstallDir
        $folder=Get-BootFolder
        $null=Get-BootInstallTasks $folder $record $InstallDir
        # Register's XML holds the pair disabled, so no automatic trigger can
        # race copy/registration. Enable only after all commit checks pass.
        foreach ($task in @((Find-HelperTask $folder),(Find-BootTask $folder))) {
            if ($null -ne $task) { $task.Enabled=$true; if (-not $task.Enabled) { throw 'Committed task enablement did not read back.' } }
        }
        # Commit succeeds before any optional startup. A launch refusal is
        # logged and remains repairable through the desktop's visible Retry.
        Remove-BootInstallSnapshot
        Write-BootLog 'commit: installation complete; task rollback snapshot cleared'
        if (Test-RunOnStartup $record) {
            foreach ($task in @((Find-HelperTask $folder),(Find-BootTask $folder))) {
                if ($null -ne $task) {
                    try { $null=$task.Run($null) }
                    catch { Write-BootLog "commit: task launch failed: $($_.Exception.Message)"; Write-Warning $_ }
                }
            }
        }
        return
    }
        if ($Action -eq 'Prepare') {
            $record=Get-BootRecord
            if ($null -ne $record) { Assert-BootRecord $record $InstallDir }
            $folder=Get-BootFolder
            $items=@(Get-BootInstallTasks $folder $record $InstallDir)
            $snapshot=Get-BootInstallSnapshot
            if ($null -ne $snapshot) { Assert-BootInstallSnapshot $snapshot $InstallDir $record }
            else {
                $saved=@(foreach ($item in $items) {
                    $xml=$null;$enabled=$false;$sddl=$null
                    if ($null -ne $item.Task) { $xml=[string]$item.Task.Xml;$enabled=[bool]$item.Task.Enabled;$sddl=$item.Task.GetSecurityDescriptor(7) }
                    @{Kind=$item.Kind;Xml=$xml;Enabled=$enabled;Sddl=$sddl}
                })
                Save-BootInstallSnapshot @{Version=1;InstallDir=$InstallDir;Record=$record;Tasks=$saved}
                Write-BootLog 'prepare: saved original owned task enablement and all trigger states'
            }
        }
        Invoke-BootLifecycleCore $Action $InstallDir $OperatorSid $InstallMode -DeferStart:$DeferStart
        if ($Action -eq 'Register' -and -not $DeferStart) { Remove-BootInstallSnapshot }
    } catch {
        $failure=$_
        Write-BootLog "$Action failed: $($failure.Exception.Message)"
        try { Restore-BootInstallTasks $InstallDir }
        catch { throw "$($failure.Exception.Message) Rollback failed: $($_.Exception.Message)" }
        throw $failure
    }
}
