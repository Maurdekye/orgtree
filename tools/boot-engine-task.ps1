# Installer-only. Dot-sourcing defines functions without machine operations.
# Tests substitute the explicit task/registry/process I/O boundaries below.
Set-StrictMode -Version Latest
$script:BootTaskName = 'Orgtree Background Engine'
$script:BootRecordKey = 'SOFTWARE\Orgtree\BootEngine'
# The sign-in credential broker (engine/rs/orgtree-engine/src/credential_broker.rs):
# a logon task for the operator only, interactive token, no window. It serves
# git/gh credentials to the boot engine while the desktop app is not running.
$script:HelperTaskName = 'Orgtree Credential Helper'
$script:HelperExe = 'orgtree-credential-broker.exe'
# The engine at sign-in (docket option-to-run-the-background-engine-in-the-user-s,
# user 2026-10-15): with "At sign-in, in my session" chosen, a logon task for the
# operator only starts the engine with their interactive token, in their own
# session, instead of the boot task in Session 0. It runs the windowless host
# (engine src/engine_host.rs): orgtree-engine.exe is a console program and would
# open a console window at every sign-in.
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
        # RunOnStartup: the operator's "Run on startup" (1 on, 0 off), written by
        # the desktop's switch through a permission prompt and by Prepare; absent
        # on installations from before it existed. StartupMode: 'signin' when the
        # engine starts at the operator's sign-in in their own session, written
        # by the same switch; absent (or anything else) is the boot task, the default.
        try { Assert-BootRegistryKey $key; return @{ InstallDir=$key.GetValue('InstallDir'); OperatorSid=$key.GetValue('OperatorSid'); Id=$key.GetValue('Id'); RunOnStartup=$key.GetValue('RunOnStartup'); StartupMode=$key.GetValue('StartupMode') } }
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
            if ($null -ne $Record['StartupMode']) { $key.SetValue('StartupMode', [string]$Record['StartupMode'], 'String') }
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
# "Run on startup" (docket start-at-login-off-means-nothing-of-orgtree-star):
# off, every task is registered disabled and nothing of Orgtree starts at boot
# or sign-in. Absent (an installation from before the choice was recorded)
# counts as on, the desktop's default.
function Test-RunOnStartup($Record) { return ($null -eq $Record['RunOnStartup'] -or [int]$Record['RunOnStartup'] -ne 0) }
# Where the engine starts while it is on (docket option-to-run-the-background-
# engine-in-the-user-s): the boot task (the default) or the sign-in engine task,
# never both. The credential helper runs in both modes (coordinator 2026-10-15
# 11:13Z): an engine a task's host started counts it as a member of its
# lifecycle (engine core_policy.rs), and an engine in the user's own session
# simply never asks it for credentials or a Codex launch.
function Test-SigninMode($Record) { return ([string]$Record['StartupMode'] -ceq 'signin') }
function Test-BootStart($Record) { return ((Test-RunOnStartup $Record) -and -not (Test-SigninMode $Record)) }
function Test-SigninStart($Record) { return ((Test-RunOnStartup $Record) -and (Test-SigninMode $Record)) }
function Get-EnabledText([bool]$Value) { if ($Value) { return 'true' } return 'false' }
# "Run Orgtree as administrator": exactly DWORD 1 under HKLM\SOFTWARE\Orgtree\Runtime,
# the rule the engine host applies (host.rs run_as_administrator). The sign-in
# engine then runs with the highest privileges, which its host keeps; otherwise
# with least privilege, the token the user's own programs get. An I/O boundary;
# the tests replace it.
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
    $runLevel=$xml.SelectNodes('/t:Task/t:Principals/t:Principal/t:RunLevel',$ns)
    if ($null -eq $Task.Definition.Principal.RunLevel -or $Task.Definition.Principal.RunLevel -ne 0 -or
        $runLevel.Count -gt 1 -or ($runLevel.Count -eq 1 -and $runLevel[0].InnerText -cne 'LeastPrivilege')) {
        throw 'Refusing foreign or changed boot task (principal run level).'
    }
    if ($xml.SelectNodes('/t:Task/t:Actions/*', $ns).Count -ne 1 -or $xml.SelectNodes('/t:Task/t:Principals/*', $ns).Count -ne 1) { throw 'Unexpected boot actions or principals.' }
}
function New-BootTaskXml($Record) {
    $paths = Get-BootPaths $Record.InstallDir
    # Serialize Unicode/XML escaping. Command is an unquoted path, not shell
    # text; the separate argument is the quoted service-host script path.
    $doc = Read-BootXml @'
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description /></RegistrationInfo><Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers><Principals><Principal id="Operator"><UserId /><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Operator"><Exec><Command /><Arguments /><WorkingDirectory /></Exec></Actions></Task>
'@
    $doc.Task.RegistrationInfo.Description = Get-BootMarker $Record
    $doc.Task.Settings.Enabled = Get-EnabledText (Test-BootStart $Record)
    $doc.Task.Principals.Principal.UserId = $Record.OperatorSid
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
function New-HelperTaskXml($Record) {
    $doc = Read-BootXml @'
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description /></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId /></LogonTrigger></Triggers><Principals><Principal id="Operator"><UserId /><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Operator"><Exec><Command /><WorkingDirectory /></Exec></Actions></Task>
'@
    $doc.Task.RegistrationInfo.Description = Get-HelperMarker $Record
    $doc.Task.Settings.Enabled = Get-EnabledText (Test-RunOnStartup $Record)
    $doc.Task.Triggers.LogonTrigger.UserId = $Record.OperatorSid
    $doc.Task.Principals.Principal.UserId = $Record.OperatorSid
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
    if ($xml.SelectNodes('/t:Task/t:Actions/*', $ns).Count -ne 1 -or $xml.SelectNodes('/t:Task/t:Principals/*', $ns).Count -ne 1) { throw 'Unexpected credential helper actions or principals.' }
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
# ---- the engine at sign-in (I/O boundaries first, for the tests)
function Find-SigninTask($Folder) {
    try { return $Folder.GetTask($script:SigninTaskName) }
    catch {
        if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return $null } # file not found only
        throw
    }
}
function Register-SigninTask($Folder, [string]$Xml, [int]$Flags, [string]$Sid, [string]$Sddl) {
    # 3 = TASK_LOGON_INTERACTIVE_TOKEN: runs only in the operator's signed-in session.
    return $Folder.RegisterTask($script:SigninTaskName, $Xml, $Flags, $Sid, $null, 3, $Sddl)
}
function Remove-SigninTask($Folder) { $Folder.DeleteTask($script:SigninTaskName, 0) }
function Get-SigninHostPath([string]$InstallDir) { return (Join-Path (Join-Path $InstallDir 'resources\engine') $script:SigninHostExe) }
function Get-SigninMarker($Record) { return "com.maurdekye.orgtree.signin-engine.v1:$($Record.Id)" }
# Like the boot task in everything but where and as whom it runs: the operator's
# logon, their interactive token, their session. $Highest is "Run Orgtree as
# administrator" (Get-RunAsAdministrator).
function New-SigninTaskXml($Record, [bool]$Highest) {
    $doc = Read-BootXml @'
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description /></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId /></LogonTrigger></Triggers><Principals><Principal id="Operator"><UserId /><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Operator"><Exec><Command /><WorkingDirectory /></Exec></Actions></Task>
'@
    $doc.Task.RegistrationInfo.Description = Get-SigninMarker $Record
    $doc.Task.Settings.Enabled = Get-EnabledText (Test-SigninStart $Record)
    $doc.Task.Triggers.LogonTrigger.UserId = $Record.OperatorSid
    $doc.Task.Principals.Principal.UserId = $Record.OperatorSid
    if ($Highest) { $doc.Task.Principals.Principal.RunLevel = 'HighestAvailable' }
    $doc.Task.Actions.Exec.Command = [string](Get-SigninHostPath $Record.InstallDir)
    $doc.Task.Actions.Exec.WorkingDirectory = [string](Join-Path $Record.InstallDir 'resources\engine')
    return $doc.OuterXml
}
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
    # The engine at sign-in runs from this installation too, under its own task.
    $signin = Find-SigninTask $Folder
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
    try {
        # Both tasks are verified before either is changed.
        if ($null -ne $task) { Assert-OwnedBootTask $task $Record $InstallDir }
        if ($null -ne $signin) { Assert-OwnedSigninTask $signin $Record $InstallDir }
        if ($null -ne $task -or $null -ne $signin) {
            # Stop only after ownership; disable first so restart-on-failure (or a
            # sign-in) cannot relaunch the engine while the installer replaces its files.
            if ($null -ne $task) { $wasEnabled = [bool]$task.Enabled; $disabledByUs = $true; $task.Enabled = $false }
            if ($null -ne $signin) { $signinWasEnabled = [bool]$signin.Enabled; $signinDisabledByUs = $true; $signin.Enabled = $false }
            # Graceful first (docket installer-can-t-replace-a-running-orgtree-an-ins):
            # the engine is asked to stop, so it ends its agents' CLIs itself.
            # Ending the task ends only the host; the engine then sees its host
            # exit and stops on its own (engine main.rs, watch_parent). That is
            # the way left when the engine cannot be asked. Whichever task's host
            # it is, the engine publishes the same descriptor.
            $asked = $false
            if ($running.Count -ne 0) { $asked = [bool](Request-BootEngineShutdown $Record $InstallDir) }
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
function Invoke-BootLifecycle {
    param([ValidateSet('Prepare','Register','Remove','Stop')][string]$Action,
          [string]$InstallDir, [string]$OperatorSid, [string]$InstallMode='all')
    # Per-user installs do not even query production task or ownership key.
    if ($InstallMode -ne 'all') { return }
    $InstallDir = Get-BootCanonicalPath $InstallDir
    $record = Get-BootRecord
    $folder = Get-BootFolder
    $task = Find-BootTask $folder
    $signin = Find-SigninTask $folder
    if ($null -eq $record) {
        if ($null -ne $task) { throw 'Task name exists without installer ownership. It will not be changed.' }
        if ($null -ne (Find-HelperTask $folder)) { throw 'Credential helper task exists without installer ownership. It will not be changed.' }
        if ($null -ne $signin) { throw 'Sign-in engine task exists without installer ownership. It will not be changed.' }
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
        # Existing operator remains authoritative during alternate-admin updates.
        # So does the start mode: an update keeps the recorded StartupMode.
    }
    # Run on startup (docket start-at-login-off-means-nothing-of-orgtree-star):
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
            Remove-BootRecord
        }
        'Register' {
            Stop-OwnedBootTask $folder $record $InstallDir
            $paths = Get-BootPaths $InstallDir
            foreach ($path in $paths.Files) { if (-not [IO.File]::Exists($path)) { throw "Missing installed engine file: $path" } }
            # The windowless host ships with the native engine; the sign-in mode
            # cannot start the engine without it.
            $signinHost = Get-SigninHostPath $InstallDir
            if ((Test-SigninMode $record) -and -not [IO.File]::Exists($signinHost)) { throw "Missing installed engine file: $signinHost" }
            $task = Find-BootTask $folder
            # DONT_ADD_PRINCIPAL_ACE preserves the explicit read/execute-only operator ACL.
            $flags = 18 # TASK_CREATE | TASK_DONT_ADD_PRINCIPAL_ACE: never overwrite a collision.
            if ($null -ne $task) { Assert-OwnedBootTask $task $record $InstallDir; $flags=20 } # verified TASK_UPDATE only
            # Ownership accepts older task priorities. Register
            # always writes explicit Normal priority (Task Scheduler value 5), including upgrades.
            $sddl = "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$($record.OperatorSid))"
            $registered = $folder.RegisterTask($script:BootTaskName,(New-BootTaskXml $record),$flags,$record.OperatorSid,$null,2,$sddl)
            Assert-OwnedBootTask $registered $record $InstallDir
            # Paired release requirement: desktop startup must retry authenticated
            # attachment after losing the data-root lock to this newly started host.
            # Fresh install and update both start the host; do not ship without
            # Fable's startup/attach race handling and its packaged acceptance.
            # With "Run on startup" off the task is registered disabled and not
            # started: nothing of Orgtree runs until the user opens it. So it is
            # when the engine starts at sign-in instead.
            $runs = Test-BootStart $record
            if ($runs) { $null = $registered.Run($null) }
            # The sign-in credential broker ships with the native engine only.
            # It follows Run on startup in both start modes. Started now as well
            # when the operator is signed in; otherwise at their next sign-in.
            # Its Run failing never fails the install.
            if ([IO.File]::Exists((Get-HelperPath $InstallDir))) {
                $helperFlags = 18
                $helper = Find-HelperTask $folder
                if ($null -ne $helper) { Assert-OwnedHelperTask $helper $record $InstallDir; $helperFlags = 20 }
                $helperTask = Register-HelperTask $folder (New-HelperTaskXml $record) $helperFlags $record.OperatorSid $sddl
                Assert-OwnedHelperTask $helperTask $record $InstallDir
                if (Test-RunOnStartup $record) { try { $null = $helperTask.Run($null) } catch { Write-Warning "The credential helper starts at the operator's next sign-in: $_" } }
            }
            # The engine at sign-in: registered beside the boot task wherever its
            # windowless host is installed, enabled only in the sign-in mode, its
            # run level following "Run Orgtree as administrator". Started now when
            # the operator is signed in; otherwise at their next sign-in, so a
            # failed Run never fails the install.
            if ([IO.File]::Exists($signinHost)) {
                $signinFlags = 18
                $signin = Find-SigninTask $folder
                if ($null -ne $signin) { Assert-OwnedSigninTask $signin $record $InstallDir; $signinFlags = 20 }
                $signinTask = Register-SigninTask $folder (New-SigninTaskXml $record (Get-RunAsAdministrator)) $signinFlags $record.OperatorSid $sddl
                Assert-OwnedSigninTask $signinTask $record $InstallDir
                if (Test-SigninStart $record) { try { $null = $signinTask.Run($null) } catch { Write-Warning "The engine starts at the operator's next sign-in: $_" } }
            }
        }
    }
}
