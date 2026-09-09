# Installer-only. Dot-sourcing defines functions without machine operations.
# Tests substitute the explicit task/registry/process I/O boundaries below.
Set-StrictMode -Version Latest
$script:BootTaskName = 'Orgtree Background Engine'
$script:BootRecordKey = 'SOFTWARE\Orgtree\BootEngine'

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
        try { Assert-BootRegistryKey $key; return @{ InstallDir=$key.GetValue('InstallDir'); OperatorSid=$key.GetValue('OperatorSid'); Id=$key.GetValue('Id') } }
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
        try { Assert-BootRegistryKey $key; foreach ($name in @('InstallDir','OperatorSid','Id')) { $key.SetValue($name, [string]$Record[$name], 'String') } }
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
function Get-BootProcessKey($Process) { return "$($Process.ProcessId):$($Process.CreationDate)" }
function Assert-BootProcessPaths($Processes, [string]$InstallDir) {
    foreach ($p in $Processes) {
        if ($null -eq $p -or $p.ExecutablePath -or [int]$p.ProcessId -in @(0,4)) { continue }
        $name=$p.PSObject.Properties['Name']
        $command=$p.PSObject.Properties['CommandLine']
        # Bound ambiguity to possible installed host/desktop images or a command
        # naming this installation. Unreadable unrelated Windows images are not
        # ours. Known descendants remain tracked by PID/creation date separately.
        $candidate=($null -eq $name -or -not $name.Value -or $name.Value -in @('python.exe','pythonw.exe','Orgtree.exe'))
        if ($null -ne $command -and $command.Value -and
            $command.Value.IndexOf($InstallDir+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0) { $candidate=$true }
        if ($candidate) {
            throw "Cannot verify executable path for process $($p.ProcessId). Installation files must not be replaced."
        }
    }
}
function Get-BootPaths([string]$InstallDir) {
    return @{ Python=(Join-Path $InstallDir 'resources\engine\runtime\python.exe'); Host=(Join-Path $InstallDir 'resources\engine\service_host.py'); Engine=(Join-Path $InstallDir 'resources\engine') }
}
function Assert-BootRecord($Record, [string]$InstallDir) {
    if ($null -eq $Record -or (Get-BootCanonicalPath $Record.InstallDir) -ine $InstallDir) { throw 'Boot ownership does not match this installation path.' }
    $null = Assert-BootSid $Record.OperatorSid
    $id = [guid]::Empty
    if (-not [guid]::TryParse($Record.Id, [ref]$id) -or $id -eq [guid]::Empty) { throw 'Invalid boot ownership record.' }
}
function Get-BootMarker($Record) { return "com.maurdekye.orgtree.boot.v1:$($Record.Id)" }
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
    $paths = Get-BootPaths $InstallDir
    $expected = @{
        '/t:Task/t:RegistrationInfo/t:Description'=(Get-BootMarker $Record)
        '/t:Task/t:Principals/t:Principal/t:UserId'=$Record.OperatorSid
        '/t:Task/t:Principals/t:Principal/t:LogonType'='S4U'
        '/t:Task/t:Actions/t:Exec/t:Command'=$paths.Python
        '/t:Task/t:Actions/t:Exec/t:Arguments'=('"'+$paths.Host+'"')
        '/t:Task/t:Actions/t:Exec/t:WorkingDirectory'=$paths.Engine
    }
    foreach ($pair in $expected.GetEnumerator()) {
        $nodes = $xml.SelectNodes($pair.Key, $ns)
        if ($nodes.Count -ne 1 -or $nodes[0].InnerText -cne $pair.Value) { throw "Refusing foreign or changed boot task ($($pair.Key))." }
    }
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
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description /></RegistrationInfo><Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers><Principals><Principal id="Operator"><UserId /><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Operator"><Exec><Command /><Arguments /><WorkingDirectory /></Exec></Actions></Task>
'@
    $doc.Task.RegistrationInfo.Description = Get-BootMarker $Record
    $doc.Task.Principals.Principal.UserId = $Record.OperatorSid
    $doc.Task.Actions.Exec.Command = [string]$paths.Python
    $doc.Task.Actions.Exec.Arguments = '"'+$paths.Host+'"'
    $doc.Task.Actions.Exec.WorkingDirectory = [string]$paths.Engine
    return $doc.OuterXml
}
function Get-BootTree($Processes, [string]$InstallDir, $Known) {
    $Processes = @($Processes | Where-Object { $null -ne $_ })
    Assert-BootProcessPaths $Processes $InstallDir
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
function Stop-OwnedBootTask($Folder, $Record, [string]$InstallDir, [int]$TimeoutSeconds=30) {
    $task = Find-BootTask $Folder
    $known = @{}
    $null = Get-BootTree (Get-BootProcesses) $InstallDir $known
    if ($null -ne $task) {
        Assert-OwnedBootTask $task $Record $InstallDir
        # Stop only after ownership; disable first so restart-on-failure cannot
        # relaunch the engine while the installer replaces its files.
        $task.Enabled = $false
        $task.Stop(0)
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
        if ($instances -eq 0 -and $remaining.Count -eq 0) { return }
        if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'Boot engine or descendants did not stop. Installation files must not be replaced.' }
        Start-Sleep -Milliseconds 200
    } while ($true)
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
        if ($Action -in @('Remove','Stop')) {
            Assert-BootDesktopClosed $InstallDir
            Stop-OwnedBootTask $folder $null $InstallDir
            return
        }
        if ($Action -ne 'Prepare') { throw 'Boot installation was not prepared.' }
        $record = @{InstallDir=$InstallDir; OperatorSid=(Assert-BootSid $OperatorSid); Id=([guid]::NewGuid().ToString())}
    } else {
        Assert-BootRecord $record $InstallDir
        if ($null -ne $task) { Assert-OwnedBootTask $task $record $InstallDir }
        # Existing operator remains authoritative during alternate-admin updates.
    }
    Assert-BootDesktopClosed $InstallDir
    switch ($Action) {
        'Prepare' { Stop-OwnedBootTask $folder $record $InstallDir; Save-BootRecord $record }
        'Stop' { Stop-OwnedBootTask $folder $record $InstallDir }
        'Remove' {
            Stop-OwnedBootTask $folder $record $InstallDir
            $task = Find-BootTask $folder
            if ($null -ne $task) { Assert-OwnedBootTask $task $record $InstallDir; $folder.DeleteTask($script:BootTaskName,0) }
            if ($null -ne (Find-BootTask $folder)) { throw 'Boot task removal not confirmed.' }
            Remove-BootRecord
        }
        'Register' {
            Stop-OwnedBootTask $folder $record $InstallDir
            $paths = Get-BootPaths $InstallDir
            foreach ($path in @($paths.Python,$paths.Host)) { if (-not [IO.File]::Exists($path)) { throw "Missing installed engine file: $path" } }
            $task = Find-BootTask $folder
            # DONT_ADD_PRINCIPAL_ACE preserves the explicit read/execute-only operator ACL.
            $flags = 18 # TASK_CREATE | TASK_DONT_ADD_PRINCIPAL_ACE: never overwrite a collision.
            if ($null -ne $task) { Assert-OwnedBootTask $task $record $InstallDir; $flags=20 } # verified TASK_UPDATE only
            $sddl = "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$($record.OperatorSid))"
            $registered = $folder.RegisterTask($script:BootTaskName,(New-BootTaskXml $record),$flags,$record.OperatorSid,$null,2,$sddl)
            Assert-OwnedBootTask $registered $record $InstallDir
            # Paired release requirement: desktop startup must retry authenticated
            # attachment after losing the data-root lock to this newly started host.
            # Fresh install and update both start the host; do not ship without
            # Fable's startup/attach race handling and its packaged acceptance.
            $null = $registered.Run($null)
        }
    }
}
