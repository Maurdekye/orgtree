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
        # on installations from before it existed.
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
function Assert-BootProcessPaths($Processes, [string]$InstallDir) {
    foreach ($p in $Processes) {
        if ($null -eq $p -or $p.ExecutablePath -or [int]$p.ProcessId -in @(0,4)) { continue }
        $name=$p.PSObject.Properties['Name']
        $command=$p.PSObject.Properties['CommandLine']
        # Bound ambiguity to possible installed host/desktop images or a command
        # naming this installation. Unreadable unrelated Windows images are not
        # ours. Known descendants remain tracked by PID/creation date separately.
        $candidate=($null -eq $name -or -not $name.Value -or $name.Value -in @('python.exe','pythonw.exe','Orgtree.exe','orgtree-engine.exe',$script:HelperExe))
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
# off, both tasks are registered disabled and nothing of Orgtree starts at boot
# or sign-in. Absent (an installation from before the choice was recorded)
# counts as on, the desktop's default.
function Test-RunOnStartup($Record) { return ($null -eq $Record['RunOnStartup'] -or [int]$Record['RunOnStartup'] -ne 0) }
function Get-StartupEnabledText($Record) { if (Test-RunOnStartup $Record) { return 'true' } return 'false' }
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
    $doc.Task.Settings.Enabled = Get-StartupEnabledText $Record
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
    $doc.Task.Settings.Enabled = Get-StartupEnabledText $Record
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
    $known = @{}
    $running = @(Get-BootTree (Get-BootProcesses) $InstallDir $known)
    Write-BootLog "stop: $($running.Count) process(es) in the boot tree$(if ($running.Count) { ': ' + ((@($running | Select-Object -First 10 | ForEach-Object { Get-BootProcessLabel $_ })) -join '; ') })"
    $disabledByUs = $false
    $wasEnabled = $false
    try {
        if ($null -ne $task) {
            Assert-OwnedBootTask $task $Record $InstallDir
            # Stop only after ownership; disable first so restart-on-failure cannot
            # relaunch the engine while the installer replaces its files.
            $wasEnabled = [bool]$task.Enabled
            $disabledByUs = $true
            $task.Enabled = $false
            # Graceful first (docket installer-can-t-replace-a-running-orgtree-an-ins):
            # the engine is asked to stop, so it ends its agents' CLIs itself.
            # Ending the task ends only the host; the engine then sees its host
            # exit and stops on its own (engine main.rs, watch_parent). That is
            # the way left when the engine cannot be asked.
            $asked = $false
            if ($running.Count -ne 0) { $asked = [bool](Request-BootEngineShutdown $Record $InstallDir) }
            if (-not $asked) { $task.Stop(0) }
            Write-BootLog $(if ($asked) { 'stop: the engine took the shutdown request' } else { 'stop: ended the boot task' })
        } elseif ($known.Count -ne 0) { throw 'Engine running without an owned boot task. Close Orgtree before continuing.' }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            $task = Find-BootTask $Folder
            $instances = 0
            if ($null -ne $task) {
                Assert-OwnedBootTask $task $Record $InstallDir
                if ($task.Enabled) { throw 'Boot task re-enabled during stop; installation aborted.' }
                $instances = $task.GetInstances(0).Count
                if ($task.State -in @(2,4)) { $instances++ } # QUEUED or RUNNING also prevents copy
            }
            $remaining = @(Get-BootTree (Get-BootProcesses) $InstallDir $known)
            if ($instances -eq 0 -and $remaining.Count -eq 0) { Write-BootLog "stop: the boot tree is quiet after $([int]$clock.Elapsed.TotalSeconds) s"; return }
            if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                # Name what is still running (docket installer-can-t-replace-a-running-
                # orgtree-an-ins, 2026-10-14: the dialog of two failed real upgrades
                # named nothing). The dialog shows the first few; the log has all.
                $held = @($remaining | ForEach-Object { Get-BootProcessLabel $_ })
                if ($instances -gt 0) { $held = @("the $script:BootTaskName task ($instances instance(s) running)") + $held }
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
    if ($null -eq $record) {
        if ($null -ne $task) { throw 'Task name exists without installer ownership. It will not be changed.' }
        if ($null -ne (Find-HelperTask $folder)) { throw 'Credential helper task exists without installer ownership. It will not be changed.' }
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
        # Existing operator remains authoritative during alternate-admin updates.
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
            Remove-BootRecord
        }
        'Register' {
            Stop-OwnedBootTask $folder $record $InstallDir
            $paths = Get-BootPaths $InstallDir
            foreach ($path in $paths.Files) { if (-not [IO.File]::Exists($path)) { throw "Missing installed engine file: $path" } }
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
            # started: nothing of Orgtree runs until the user opens it.
            $runs = Test-RunOnStartup $record
            if ($runs) { $null = $registered.Run($null) }
            # The sign-in credential broker ships with the native engine only.
            # Started now as well when the operator is signed in; otherwise at
            # their next sign-in. Its Run failing never fails the install.
            if ([IO.File]::Exists((Get-HelperPath $InstallDir))) {
                $helperFlags = 18
                $helper = Find-HelperTask $folder
                if ($null -ne $helper) { Assert-OwnedHelperTask $helper $record $InstallDir; $helperFlags = 20 }
                $helperTask = Register-HelperTask $folder (New-HelperTaskXml $record) $helperFlags $record.OperatorSid $sddl
                Assert-OwnedHelperTask $helperTask $record $InstallDir
                if ($runs) { try { $null = $helperTask.Run($null) } catch { Write-Warning "The credential helper starts at the operator's next sign-in: $_" } }
            }
        }
    }
}
