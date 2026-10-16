# Isolated lifecycle tests: all registry/task/process I/O is replaced before use.
# Never registers/stops/deletes a Windows task or touches an installation.
$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\tools\boot-engine-task.ps1"
$script:checks=0
function Assert($Value,[string]$Message) { if (-not $Value) { throw $Message }; $script:checks++ }
function Refuses([scriptblock]$Probe,[string]$Pattern) {
    try { & $Probe } catch { Assert ($_.Exception.Message -match $Pattern) "Wrong refusal: $_"; return }
    throw "Expected refusal: $Pattern"
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('orgtree-boot-fixture-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$dir=Join-Path $root ('Orgtree & '+[char]0x00e9+' '+[char]0x05d0)
$sid='S-1-5-21-111-222-333-1001'
$script:record=@{InstallDir=$dir; OperatorSid=$sid; Id='ff371d24-7f4b-463e-aede-29a18ef84693'}
$original=$script:record.Clone()
$script:task=$null
$script:events=[Collections.Generic.List[string]]::new()
$script:processes=@()
function Get-BootRecord { $script:events.Add('read-record'); return $script:record }
function Save-BootRecord($Record) { $script:events.Add('save'); $script:record=$Record }
function Remove-BootRecord { $script:events.Add('remove-record'); $script:record=$null }
function Find-BootTask($Folder) { $script:events.Add('find'); return $script:task }
function Get-BootProcesses { return $script:processes }
function New-FakeTask([string]$Xml) {
    $value=[pscustomobject]@{Xml=$Xml; Enabled=$true; Instances=0; State=3; KeepProcesses=$false; Sddl='O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)'; Definition=[pscustomobject]@{Principal=[pscustomobject]@{RunLevel=0}}}
    $value | Add-Member ScriptMethod GetSecurityDescriptor { param($flags) return $this.Sddl }
    $value | Add-Member ScriptMethod Stop { param($flags) $script:events.Add('stop'); if (-not $this.KeepProcesses) { $script:processes=@() } }
    $value | Add-Member ScriptMethod GetInstances { param($flags) return [pscustomobject]@{Count=$this.Instances} }
    $value | Add-Member ScriptMethod Run { param($args) $script:events.Add('run') }
    return $value
}
$script:folder=[pscustomobject]@{}
$script:folder | Add-Member ScriptMethod DeleteTask { param($name,$flags) $script:events.Add('delete'); $script:task=$null }
$script:folder | Add-Member ScriptMethod RegisterTask {
    param($name,$xml,$flags,$user,$password,$logon,$sddl)
    $script:events.Add("register:$flags")
    Assert ($user -eq $sid -and $null -eq $password -and $logon -eq 2) 'Wrong principal/password/logon'
    $script:task=New-FakeTask $xml
    return $script:task
}
function Get-BootFolder { $script:events.Add('folder'); return $script:folder }
# The credential helper task has its own boundaries; absent unless a test adds it.
$script:helper=$null
function Find-HelperTask($Folder) { return $script:helper }
# Its fake reads its run level from the XML, as Task Scheduler's principal would.
function New-HelperFake([string]$Xml) {
    $value=New-FakeTask $Xml
    $level=(Read-BootXml $Xml).SelectSingleNode('//*[local-name()="Principal"]/*[local-name()="RunLevel"]')
    $value.Definition.Principal.RunLevel=[int]($null -ne $level -and $level.InnerText -eq 'HighestAvailable')
    $value | Add-Member -Force ScriptMethod Stop { param($flags) $script:events.Add('helper-stop') }
    $value | Add-Member -Force ScriptMethod Run { param($args) $script:events.Add('helper-run') }
    return $value
}
function Register-HelperTask($Folder,[string]$Xml,[int]$Flags,[string]$Sid,[string]$Sddl) {
    $script:events.Add("helper-register:$Flags")
    Assert ($Sid -eq $script:record.OperatorSid -and $Sddl -match '^O:BAG:BAD:P') 'Wrong helper principal or ACL'
    $script:helper=New-HelperFake $Xml
    return $script:helper
}
function Remove-HelperTask($Folder) { $script:events.Add('helper-delete'); $script:helper=$null }
function Stop-HelperProcess($Process) { $script:events.Add('helper-kill'); $script:processes=@($script:processes | Where-Object { $_.ProcessId -ne $Process.ProcessId }) }
# The engine at sign-in (docket option-to-run-the-background-engine-in-the-user-s)
# has its own boundaries too; absent unless a test adds it. Its fake reads its
# run level from the XML, as Task Scheduler's principal would.
$script:signin=$null
$script:runAsAdmin=$false
function New-SigninFake([string]$Xml) {
    $value=New-FakeTask $Xml
    $level=(Read-BootXml $Xml).SelectSingleNode('//*[local-name()="Principal"]/*[local-name()="RunLevel"]')
    $value.Definition.Principal.RunLevel=[int]($null -ne $level -and $level.InnerText -eq 'HighestAvailable')
    $value | Add-Member -Force ScriptMethod Stop { param($flags) $script:events.Add('signin-stop'); if (-not $this.KeepProcesses) { $script:processes=@() } }
    $value | Add-Member -Force ScriptMethod Run { param($args) $script:events.Add('signin-run') }
    return $value
}
function Find-SigninTask($Folder) { return $script:signin }
function Register-SigninTask($Folder,[string]$Xml,[int]$Flags,[string]$Sid,[string]$Sddl) {
    $script:events.Add("signin-register:$Flags")
    Assert ($Sid -eq $script:record.OperatorSid -and $Sddl -match '^O:BAG:BAD:P') 'Wrong sign-in engine principal or ACL'
    $script:signin=New-SigninFake $Xml
    return $script:signin
}
function Remove-SigninTask($Folder) { $script:events.Add('signin-delete'); $script:signin=$null }
function Get-RunAsAdministrator { return $script:runAsAdmin }
# Asking the engine to stop is an I/O boundary too. By default it cannot be
# asked (no descriptor), so the task is ended, as before; an engine that takes
# the request stops by itself.
$script:engineAnswers=$false
function Request-BootEngineShutdown($Record,[string]$InstallDir) {
    $script:events.Add('engine-request')
    if ($script:engineAnswers) { $script:processes=@() }
    return $script:engineAnswers
}
function Get-OperatorDataRoot([string]$Sid) { throw 'The operator data folder must not be read by these tests' }
# The installer's record is its own way to ask (docket installer-s-end-task-fallback-
# no-longer-stops-th), never the real HKLM key here. By default writing it changes
# nothing, as for an engine from before it; an engine that honours it stops by itself.
$script:recordStops=$false
function Request-BootEngineStopByRecord {
    $script:events.Add('record-stop')
    if ($script:recordStops) { $script:processes=@() }
    return $true
}
# The operator's own "Run on startup" from desktop-settings.json: none unless a test sets one.
$script:operatorChoice=$null
function Get-OperatorStartupChoice([string]$Sid) { return $script:operatorChoice }
# The installer log is an I/O boundary too: these tests never append to the
# real %TEMP%\orgtree-installer-upgrade.log.
$script:bootLog=[Collections.Generic.List[string]]::new()
function Write-BootLog([string]$Message) { $script:bootLog.Add($Message) }

# Per-user positive path: no machine lookup at all, even with a foreign task.
Invoke-BootLifecycle Prepare -InstallMode CurrentUser
Invoke-BootLifecycle Remove -InstallMode CurrentUser
Assert ($script:events.Count -eq 0) 'Per-user operation touched machine state'

$xml=New-BootTaskXml $original
$doc=Read-BootXml $xml
$paths=Get-BootPaths $dir
Assert ($doc.Task.Actions.Exec.Command -ceq $paths.Python) 'Command path changed/quoted'
Assert ($doc.Task.Actions.Exec.Arguments -ceq ('"'+$paths.Host+'"')) 'Argument escaping changed'
Assert ($xml.Contains('&amp;') -and $xml.Contains([string][char]0x05d0)) 'Unicode/XML serialization control missing'
Assert ($doc.Task.Settings.ExecutionTimeLimit -eq 'PT0S') 'Runtime limit'
$priorityNode=$doc.SelectSingleNode('//*[local-name()="Settings"]/*[local-name()="Priority"]')
Assert ($null -ne $priorityNode -and $priorityNode.InnerText -eq '5') 'Boot engine task must explicitly request Normal priority (d38a3bd)'
Assert ($doc.Task.Settings.RestartOnFailure.Count -eq '3') 'Restart policy'
Assert ($doc.Task.Settings.DisallowStartIfOnBatteries -eq 'false' -and $doc.Task.Settings.StopIfGoingOnBatteries -eq 'false') 'Battery policy'
Assert ($doc.Task.Settings.MultipleInstancesPolicy -eq 'IgnoreNew') 'Multiple instances'
$task=New-FakeTask $xml
Assert-OwnedBootTask $task $original $dir
$normalized=New-FakeTask ($xml.Replace('<RunLevel>LeastPrivilege</RunLevel>',''))
Assert ($normalized.Xml -ne $xml) 'Windows default-omission fixture is inert'
Assert-OwnedBootTask $normalized $original $dir
$normalized.Definition.Principal.RunLevel=1
Refuses { Assert-OwnedBootTask $normalized $original $dir } 'principal run level'
$normalized.Definition.Principal.RunLevel=0
$normalized.Xml=$xml.Replace('LeastPrivilege','HighestAvailable')
Refuses { Assert-OwnedBootTask $normalized $original $dir } 'principal run level'
Assert-BootProtectedAcl 'O:BAG:BAD:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;KR;;;BU)' 0x500D0006
Refuses { Assert-BootProtectedAcl 'O:BAG:BAD:P(A;;KA;;;WD)' 0x500D0006 } 'write access'
Refuses { Assert-BootProtectedAcl ('O:'+$sid+'G:BAD:P(A;;KA;;;BA)') 0x500D0006 } 'administrator protected'
$task.Sddl='O:BAG:BAD:P(A;;GA;;;WD)'
Refuses { Assert-OwnedBootTask $task $original $dir } 'write access'

# Every ownership refusal must leave Stop/Create/Delete untouched.
foreach ($bad in @($xml.Replace($sid,'S-1-5-21-111-222-333-9999'),$xml.Replace($original.Id,[guid]::NewGuid().ToString()),$xml.Replace('python.exe','other.exe'),$xml.Replace('service_host.py','foreign.py'))) {
    $script:task=New-FakeTask $bad; $script:events.Clear()
    foreach ($action in @('Prepare','Register','Stop','Remove')) { Refuses { Invoke-BootLifecycle $action $dir $sid } 'foreign|changed' }
    Assert (-not ($script:events -match '^(stop|delete|register|save|remove-record)')) 'Foreign task was mutated'
}
$script:task=New-FakeTask $xml
$script:record=$null; $script:events.Clear()
Refuses { Invoke-BootLifecycle Prepare $dir $sid } 'without installer ownership'
Assert (-not ($script:events -contains 'stop')) 'Unowned task stopped'
$script:record=$original.Clone()
Refuses { Invoke-BootLifecycle Remove ($dir+'-other') $sid } 'installation path'

# Unreadable seed paths must fail before Stop or copy, even without a task.
$script:processes=@([pscustomobject]@{ProcessId=101; ParentProcessId=1; CreationDate='A'; Name='python.exe'; ExecutablePath=$null})
$script:events.Clear()
Refuses { Invoke-BootLifecycle Prepare $dir $sid } 'Cannot verify executable path for process 101 \(python\.exe, parent 1\)\.'
Assert (-not ($script:events -contains 'stop')) 'Unknown process was ignored before stop'
$script:task=$null
Refuses { Stop-OwnedBootTask $script:folder $original $dir 0 } 'Cannot verify executable path'
$script:processes=@([pscustomobject]@{ProcessId=0; ExecutablePath=$null},[pscustomobject]@{ProcessId=4; ExecutablePath=$null},[pscustomobject]@{ProcessId=88; Name='unrelated-system.exe'; ExecutablePath=$null})
Assert-BootDesktopClosed $dir
Assert $true 'Unrelated unreadable system images are not candidate engine roots'
$script:processes=@([pscustomobject]@{ProcessId=106; Name='Orgtree.exe'; ExecutablePath=$null})
Refuses { Assert-BootDesktopClosed $dir } 'Cannot verify executable path'
$script:processes=@([pscustomobject]@{ProcessId=106; Name='renamed.exe'; CommandLine=('"'+$dir+'\renamed.exe"'); ExecutablePath=$null})
Refuses { Assert-BootDesktopClosed $dir } 'Cannot verify executable path'
$script:processes=@([pscustomobject]@{ProcessId=105; ExecutablePath=(Join-Path $dir 'renamed-desktop.exe')})
Refuses { Assert-BootDesktopClosed $dir } 'Close the Orgtree desktop'
$script:processes=@([pscustomobject]@{ProcessId=105; ExecutablePath=(Join-Path ($dir+'-external') 'Orgtree.exe')})
Assert-BootDesktopClosed $dir
Assert $true 'Unrelated installation prefix should not match'
$script:processes=@()
$script:task=New-FakeTask $xml

# Alternate admin never substitutes its SID. Stop is confirmed before copying.
$script:events.Clear()
Invoke-BootLifecycle Prepare $dir 'S-1-5-21-111-222-333-9999'
Assert ($script:record.OperatorSid -eq $sid) 'Update replaced operator'
Assert ($script:events.IndexOf('stop') -lt $script:events.IndexOf('save')) 'Prepare order'
Assert (-not $script:task.Enabled) 'Task can restart during replacement'

# A returned task Stop alone is insufficient; any surviving descendant aborts.
$script:task=New-FakeTask $xml
$script:task.KeepProcesses=$true
$script:processes=@([pscustomobject]@{ProcessId=101; ParentProcessId=1; CreationDate='A'; ExecutablePath=$paths.Python},[pscustomobject]@{ProcessId=102; ParentProcessId=101; CreationDate='B'; ExecutablePath='C:\provider\cli.exe'})
Refuses { Stop-OwnedBootTask $script:folder $original $dir 0 } 'did not stop'
Assert ($script:task.Enabled) 'Failed stop must restore the previously enabled boot task'
$script:task.Enabled=$false
Refuses { Stop-OwnedBootTask $script:folder $original $dir 0 } 'did not stop'
Assert (-not $script:task.Enabled) 'Failed stop must preserve an intentionally disabled task'
$script:task.Enabled=$true

# Graceful first: a running engine is asked to stop before anything ends its
# task, and when it takes the request the task is never ended at all (ending it
# would only end the host; the engine stops its agents' CLIs itself).
$engineTree=@([pscustomobject]@{ProcessId=101; ParentProcessId=1; CreationDate='A'; ExecutablePath=$paths.Python},[pscustomobject]@{ProcessId=102; ParentProcessId=101; CreationDate='B'; ExecutablePath='C:\provider\cli.exe'})
$script:task=New-FakeTask $xml
$script:processes=$engineTree; $script:engineAnswers=$true; $script:events.Clear()
Stop-OwnedBootTask $script:folder $original $dir 2
Assert ($script:events -contains 'engine-request') 'A running engine was not asked to stop'
Assert (-not ($script:events -contains 'stop')) 'The task was ended although the engine took the request'
Assert (-not ($script:events -contains 'record-stop')) 'An engine that took the request must not be asked again through the record'
Assert (-not $script:task.Enabled) 'The task must stay disabled while files are replaced'
# An engine that cannot be asked is stopped by ending its task, after asking.
$script:task=New-FakeTask $xml
$script:processes=$engineTree; $script:engineAnswers=$false; $script:events.Clear()
Stop-OwnedBootTask $script:folder $original $dir 2
Assert ($script:events.IndexOf('engine-request') -ge 0 -and $script:events.IndexOf('engine-request') -lt $script:events.IndexOf('stop')) 'The engine must be asked before its task is ended'
# ...and through the installer's record first (docket installer-s-end-task-fallback-no-
# longer-stops-th): ending a task ends only its host, and since the 2026-10-12 recovery
# the engine outlives its host.
Assert ($script:events.IndexOf('record-stop') -gt $script:events.IndexOf('engine-request') -and $script:events.IndexOf('record-stop') -lt $script:events.IndexOf('stop')) "An engine that cannot be asked through its descriptor must be asked through the installer's record before its task is ended: $($script:events -join ',')"
# The record alone stops an engine that outlives its ended host.
$script:task=New-FakeTask $xml; $script:task.KeepProcesses=$true
$script:processes=$engineTree; $script:engineAnswers=$false; $script:recordStops=$true; $script:events.Clear()
Stop-OwnedBootTask $script:folder $original $dir 2
Assert ($script:processes.Count -eq 0 -and $script:events -contains 'record-stop') 'The record request did not stop an engine that outlived its host'
$script:recordStops=$false
# Nothing running: there is nobody to ask, and the task is ended as before.
$script:task=New-FakeTask $xml
$script:processes=@(); $script:events.Clear()
Stop-OwnedBootTask $script:folder $original $dir 2
Assert (-not ($script:events -contains 'engine-request') -and $script:events -contains 'stop') 'An idle engine needs no request'
Assert (-not ($script:events -contains 'record-stop')) 'An idle engine needs no record request'
$script:task=New-FakeTask $xml
$script:processes=@([pscustomobject]@{ProcessId=101; ParentProcessId=1; CreationDate='A'; ExecutablePath=$paths.Python},[pscustomobject]@{ProcessId=102; ParentProcessId=101; CreationDate='B'; ExecutablePath='C:\provider\cli.exe'})

$known=@{}
$null=Get-BootTree $script:processes $dir $known
$orphan=@($script:processes[1])
Assert (@(Get-BootTree $orphan $dir $known).Count -eq 1) 'Orphan descendant escaped identity tracking'
$reused=@([pscustomobject]@{ProcessId=102; ParentProcessId=1; CreationDate='NEW'; ExecutablePath='C:\unrelated.exe'})
Assert (@(Get-BootTree $reused $dir $known).Count -eq 0) 'Reused PID mistaken for owned descendant'
# A disappearing CIM path is not proof of exit: exact known identities stay
# counted until absent; a recycled PID or missing timestamp gets no exemption.
$pathless=@([pscustomobject]@{ProcessId=101; ParentProcessId=1; CreationDate='A'; Name='python.exe'; ExecutablePath=$null},[pscustomobject]@{ProcessId=102; ParentProcessId=101; CreationDate='B'; Name='cli.exe'; ExecutablePath=$null})
Assert (@(Get-BootTree $pathless $dir $known).Count -eq 2) 'Known pathless processes stopped counting as live'
Assert (@(Get-BootTree @() $dir $known).Count -eq 0) 'Absent known processes still count as live'
$unknown=@([pscustomobject]@{ProcessId=109; ParentProcessId=1; CreationDate='A'; Name='python.exe'; ExecutablePath=$null})
Refuses { Get-BootTree $unknown $dir $known } 'Cannot verify executable path'
$reuseHidden=@([pscustomobject]@{ProcessId=101; ParentProcessId=1; CreationDate='NEW'; Name='python.exe'; ExecutablePath=$null})
Refuses { Get-BootTree $reuseHidden $dir $known } 'Cannot verify executable path'
$noTimestamp=@([pscustomobject]@{ProcessId=101; ParentProcessId=1; CreationDate=$null; Name='python.exe'; ExecutablePath=$null})
Refuses { Get-BootTree $noTimestamp $dir $known } 'Cannot verify executable path'

# Actual stop loop: readable -> pathless (still waiting) -> absent (complete).
$savedProcesses=${function:Get-BootProcesses}
$script:lossReads=0; $script:pathlessFixture=$pathless; $script:seedFixture=$script:processes
$script:keepPathless=$false
function Get-BootProcesses {
    $script:lossReads++
    if ($script:lossReads -eq 1) { return $script:seedFixture }
    if ($script:lossReads -eq 2 -or $script:keepPathless) { return $script:pathlessFixture }
    return @()
}
$script:task=New-FakeTask $xml; $script:task.KeepProcesses=$true
Stop-OwnedBootTask $script:folder $original $dir 2
Assert ($script:lossReads -eq 3) 'Stop did not wait for the known pathless processes to disappear'
Assert (-not $script:task.Enabled) 'Path-loss handling must not re-enable the task'
$script:lossReads=0; $script:keepPathless=$true
Refuses { Stop-OwnedBootTask $script:folder $original $dir 0 } 'did not stop'
Set-Item Function:Get-BootProcesses $savedProcesses
$script:processes=@()
$script:task.Instances=1
Refuses { Stop-OwnedBootTask $script:folder $original $dir 0 } 'did not stop'
$script:task.Instances=0

# A successful Prepare keeps the task disabled for file replacement.
# A failed stop above restores its prior state, even if the engine exits later.
Assert (-not $script:task.Enabled) 'Task must still read disabled once the engine finally went quiet'
Invoke-BootLifecycle Prepare $dir $sid
Assert (-not $script:task.Enabled) 'A bare Prepare retry stops again but must not silently re-enable boot-start'

# Actual files here are empty synthetic resources, never executed.
[IO.Directory]::CreateDirectory((Split-Path $paths.Python)) | Out-Null
[IO.File]::WriteAllText($paths.Python,'fixture')
[IO.File]::WriteAllText($paths.Host,'fixture')
$script:events.Clear()
Invoke-BootLifecycle Register $dir
Assert ($script:events -contains 'register:20') 'Owned update must preserve the explicit principal ACL'
# The SUPPORTED recovery: completing the same installer through Register (not
# just Prepare) re-creates the task from the approved XML — which the real
# task definition always sets Enabled=true in (New-BootTaskXml's own
# template) — restoring boot-start. This is what re-running the ordinary
# installer after a "did not stop" failure actually does; no special
# recovery script is needed or should be reused.
Assert ($script:task.Enabled) 'Completing Register must restore boot-start after an earlier disabled state'
Assert ($script:events -contains 'run') 'Registered task not started'

# The credential helper: registered only beside the native engine binary.
Assert ($null -eq $script:helper -and -not ($script:events -match 'helper-register')) 'Helper registered without its binary'
$brokerPath=Get-HelperPath $dir
[IO.File]::WriteAllText($brokerPath,'fixture')
$script:events.Clear()
Invoke-BootLifecycle Register $dir
Assert ($script:events -contains 'helper-register:18' -and $script:events -contains 'helper-run') "Helper task not created and started: $($script:events -join ',')"
$helperXml=Read-BootXml $script:helper.Xml
Assert ($helperXml.Task.Principals.Principal.LogonType -eq 'InteractiveToken' -and $helperXml.Task.Principals.Principal.UserId -eq $sid) 'Helper must run as the operator with an interactive token'
Assert ($helperXml.Task.Triggers.LogonTrigger.UserId -eq $sid -and $null -eq $helperXml.Task.Triggers.SelectSingleNode('*[local-name()="BootTrigger"]')) 'Helper must start at the operator logon only'
Assert ($helperXml.Task.Actions.Exec.Command -eq $brokerPath) 'Helper runs the installed broker'
# An update stops the helper (task disabled, its process ended) before the boot tree.
$script:processes=@([pscustomobject]@{ProcessId=4242; ParentProcessId=1; CreationDate='20261010'; ExecutablePath=$brokerPath; Name='orgtree-credential-broker.exe'})
$script:events.Clear()
Invoke-BootLifecycle Stop $dir
Assert (-not $script:helper.Enabled -and $script:events -contains 'helper-stop' -and $script:events -contains 'helper-kill') 'Update did not stop the helper'
Assert ($script:events.IndexOf('helper-kill') -lt $script:events.IndexOf('stop')) 'Helper must stop before the boot tree'
Assert ($script:processes.Count -eq 0) 'Helper process survived the stop'
$script:events.Clear()
Invoke-BootLifecycle Register $dir
Assert ($script:events -contains 'helper-register:20' -and $script:helper.Enabled) 'Helper update must re-enable the verified task'
# A changed helper task is refused before anything stops.
$script:helper.Xml=$script:helper.Xml.Replace('InteractiveToken','S4U')
$script:events.Clear()
Refuses { Invoke-BootLifecycle Stop $dir } 'credential helper'
Assert (-not ($script:events -contains 'stop')) 'A foreign helper task must refuse before any stop'
$script:helper.Xml=$script:helper.Xml.Replace('S4U','InteractiveToken')
foreach ($legacyXml in @($xml.Replace('<Priority>5</Priority>',''),$xml.Replace('<Priority>5</Priority>','<Priority>1</Priority>'))) {
    $script:task=New-FakeTask $legacyXml
    $script:events.Clear()
    Invoke-BootLifecycle Register $dir
    $updatedXml=Read-BootXml $script:task.Xml
    Assert ($updatedXml.Task.Settings.Priority -eq '5') 'Upgrade retained the legacy task priority'
    Assert ($script:events -contains 'register:20' -and $script:events -contains 'run') 'Legacy task was not updated and launched'
}

# Run on startup (docket start-at-login-off-means-nothing-of-orgtree-star). An
# update records the operator's own choice when none is recorded yet; off
# registers both tasks disabled and starts neither.
$script:record.Remove('RunOnStartup'); $script:operatorChoice=$false; $script:events.Clear()
Invoke-BootLifecycle Prepare $dir $sid
Assert ($script:record['RunOnStartup'] -eq 0) 'Prepare did not record the operator''s Run on startup off'
Invoke-BootLifecycle Register $dir
Assert ((Read-BootXml $script:task.Xml).Task.Settings.Enabled -eq 'false') 'The boot task was registered enabled with Run on startup off'
Assert ((Read-BootXml $script:helper.Xml).Task.Settings.Enabled -eq 'false') 'The helper task was registered enabled with Run on startup off'
Assert (-not ($script:events -contains 'run') -and -not ($script:events -contains 'helper-run')) 'A task was started with Run on startup off'
# A recorded choice (the switch writes it) wins over the settings file.
$script:operatorChoice=$true; $script:events.Clear()
Invoke-BootLifecycle Prepare $dir $sid
Assert ($script:record['RunOnStartup'] -eq 0) 'A recorded Run on startup off was overridden'
$script:record['RunOnStartup']=1; $script:events.Clear()
Invoke-BootLifecycle Prepare $dir $sid
Invoke-BootLifecycle Register $dir
Assert ((Read-BootXml $script:task.Xml).Task.Settings.Enabled -eq 'true' -and $script:events -contains 'run' -and $script:events -contains 'helper-run') 'Run on startup on did not register and start both tasks'
# Never taken from the task itself: an update that stopped half way leaves it disabled.
$script:record.Remove('RunOnStartup'); $script:operatorChoice=$null; $script:task.Enabled=$false; $script:events.Clear()
Invoke-BootLifecycle Prepare $dir $sid
Assert ($script:record['RunOnStartup'] -eq 1) 'A task left disabled by an unfinished update was read as Run on startup off'
Invoke-BootLifecycle Register $dir
# The settings file itself: only a boolean startAtLogin counts.
$settings=Join-Path $root 'desktop-settings.json'
foreach ($case in @(@('{"startAtLogin":false,"exitOnClose":true}',$false),@('{"startAtLogin":true}',$true),@('{"exitOnClose":true}',$null),@('{"startAtLogin":"false"}',$null),@('not json',$null))) {
    [IO.File]::WriteAllText($settings,$case[0])
    $read=Read-StartupChoice $settings
    Assert ($(if ($null -eq $case[1]) { $null -eq $read } else { $read -is [bool] -and $read -eq $case[1] })) "Settings file $($case[0]) read as $read"
}
[IO.File]::Delete($settings)
Assert ($null -eq (Read-StartupChoice $settings)) 'A missing settings file must read as no choice'

$script:events.Clear()
Invoke-BootLifecycle Remove $dir
Assert ($null -eq $script:record -and $null -eq $script:task) 'Uninstall did not remove own task/record'
Assert ($null -eq $script:helper -and $script:events -contains 'helper-delete') 'Uninstall did not remove the helper task'
[IO.File]::Delete($brokerPath)
Assert ($script:events.IndexOf('stop') -lt $script:events.IndexOf('delete')) 'Deleted before confirmed stop'
$script:events.Clear()
Invoke-BootLifecycle Prepare $dir $sid
Invoke-BootLifecycle Register $dir
Assert ($script:events -contains 'register:18') 'Fresh create must refuse collisions and preserve the explicit principal ACL'

# Registration/deletion errors remain errors; there is no logon-only success.
$registerMethod=$script:folder.PSObject.Methods['RegisterTask'].Script
$script:folder | Add-Member -Force ScriptMethod RegisterTask { throw 'registration refused by scheduler' }
Refuses { Invoke-BootLifecycle Register $dir } 'registration refused'
$script:folder | Add-Member -Force ScriptMethod RegisterTask $registerMethod
$script:folder | Add-Member -Force ScriptMethod DeleteTask { throw 'deletion refused by scheduler' }
Refuses { Invoke-BootLifecycle Remove $dir } 'deletion refused'
Assert ($null -ne $script:record) 'Failed delete erased ownership record'

# A timeout names what is still running (docket installer-can-t-replace-a-
# running-orgtree-an-ins, 2026-10-14: two failed real upgrades named nothing):
# image, pid, parent, path and the engine binary's mode, the first five in the
# dialog and every one in the log; never another process's command line.
$engineExe=Join-Path $paths.Engine 'orgtree-engine.exe'
$desktopExe=Join-Path $dir 'Orgtree.exe'
$watchLine='"'+$engineExe+'" core-recovery watch "C:\Users\op\AppData\Roaming\Orgtree v2\data" 4321 133999999999999999'
$script:task=New-FakeTask $xml; $script:task.KeepProcesses=$true
$script:processes=@([pscustomobject]@{ProcessId=4321; ParentProcessId=1; CreationDate='D'; Name='Orgtree.exe'; ExecutablePath=$desktopExe; CommandLine=('"'+$desktopExe+'"')},
    [pscustomobject]@{ProcessId=501; ParentProcessId=4321; CreationDate='W'; Name='orgtree-engine.exe'; ExecutablePath=$engineExe; CommandLine=$watchLine},
    [pscustomobject]@{ProcessId=502; ParentProcessId=501; CreationDate='C'; Name='conhost.exe'; ExecutablePath='C:\Windows\System32\conhost.exe'; CommandLine='\??\C:\Windows\system32\conhost.exe 0xffffffff -ForceV1'})
$script:bootLog.Clear()
Refuses { Stop-OwnedBootTask $script:folder $original $dir 0 } ([regex]::Escape("did not stop within 0 seconds, so its files were not replaced. Still running: orgtree-engine.exe pid 501 (core-recovery watch, parent 4321) at $engineExe; conhost.exe pid 502 (parent 501) at C:\Windows\System32\conhost.exe. Open Orgtree"))
Assert (@($script:bootLog | Where-Object { $_ -like 'stop: still running after 0 s: *' }).Count -eq 2) "The log must name every process still running: $($script:bootLog -join ' | ')"
Assert (-not (@($script:bootLog) -match 'ForceV1|Roaming|133999999999999999')) 'A command line beyond the engine''s mode was repeated'
$script:processes=@(1..7 | ForEach-Object { [pscustomobject]@{ProcessId=600+$_; ParentProcessId=1; CreationDate="P$_"; Name='orgtree-engine.exe'; ExecutablePath=$engineExe; CommandLine=('"'+$engineExe+'" "host"')} })
$script:bootLog.Clear()
Refuses { Stop-OwnedBootTask $script:folder $original $dir 0 } ('Still running: (orgtree-engine\.exe pid 60[1-4] \(host, parent 1\) at [^;]+; ){4}orgtree-engine\.exe pid 605 \(host, parent 1\) at [^;]+ and 2 more \(all are listed in [^)]*orgtree-installer-upgrade\.log\)\. Open Orgtree')
Assert (@($script:bootLog | Where-Object { $_ -like 'stop: still running after 0 s: *' }).Count -eq 7) 'The log must list all seven, not only the five shown'
$script:processes=@(); $script:task.Instances=1
Refuses { Stop-OwnedBootTask $script:folder $original $dir 0 } 'Still running: the Orgtree Background Engine task \(1 instance\(s\) running\)\. Open Orgtree'
$script:task.Instances=0

# The closed desktop's core-recovery observer (docket installer-can-t-replace-a-
# running-orgtree-an-ins, 2026-10-14). Alpha.0/alpha.1 observers wait out a
# 180-second installer allowance from the engine folder and the boot step timed
# out on them. Coordinator ruling: end it only with this installation's image,
# the `core-recovery watch` command line and its desktop verifiably gone.
$script:RecoveryWatchGraceSeconds=0
$script:watchKills=[Collections.Generic.List[int]]::new()
function Stop-RecoveryWatchProcess($Watcher) {
    $script:watchKills.Add([int]$Watcher.ProcessId); $script:events.Add('watch-kill')
    $script:processes=@($script:processes | Where-Object { $_.ProcessId -ne $Watcher.ProcessId -and $_.ParentProcessId -ne $Watcher.ProcessId })
}
$t0=[datetime]'2026-10-14T09:49:00'
function New-Watcher([int]$Id=501,[string]$Exe=$engineExe,[string]$Mode='core-recovery watch') {
    return [pscustomobject]@{ProcessId=$Id; ParentProcessId=4321; CreationDate=$t0; Name='orgtree-engine.exe'; ExecutablePath=$Exe
        CommandLine=('"'+$Exe+'" '+$Mode+' "C:\Users\op\AppData\Roaming\Orgtree v2\data" 4321 133999999999999999')}
}
$conhost=[pscustomobject]@{ProcessId=502; ParentProcessId=501; CreationDate=$t0.AddMilliseconds(5); Name='conhost.exe'; ExecutablePath='C:\Windows\System32\conhost.exe'}
# Desktop gone: the observer (and its console host with it) is ended before the
# tree is captured, so the stop completes instead of waiting it out.
$script:task=New-FakeTask $xml; $script:task.KeepProcesses=$true
$script:processes=@((New-Watcher),$conhost); $script:events.Clear(); $script:bootLog.Clear(); $script:watchKills.Clear()
Stop-OwnedBootTask $script:folder $original $dir 2
Assert ($script:watchKills.Count -eq 1 -and $script:watchKills[0] -eq 501) 'The closed desktop''s observer was not ended'
Assert ($script:events.IndexOf('watch-kill') -lt $script:events.IndexOf('stop')) 'The observer must be ended before the boot tree is stopped'
Assert (@($script:bootLog -like 'watcher: ended orgtree-engine.exe pid 501 (core-recovery watch, parent 4321) at *; the desktop it watched (pid 4321) is gone').Count -eq 1) "The ended observer was not logged: $($script:bootLog -join ' | ')"
# The same through the lifecycle Setup runs (Prepare), with the task kept running.
$script:task=New-FakeTask (New-BootTaskXml $script:record); $script:task.KeepProcesses=$true
$script:processes=@((New-Watcher),$conhost); $script:watchKills.Clear()
Invoke-BootLifecycle Prepare $dir $sid
Assert ($script:watchKills.Count -eq 1) 'Prepare did not end the closed desktop''s observer'
# The desktop's id now held by a process created after the observer, or by an
# image outside the installation: that is not the desktop, which is gone.
foreach ($holder in @([pscustomobject]@{ProcessId=4321; ParentProcessId=8; CreationDate=$t0.AddMinutes(1); Name='Orgtree.exe'; ExecutablePath=$desktopExe},
                      [pscustomobject]@{ProcessId=4321; ParentProcessId=8; CreationDate=$t0.AddMinutes(-5); Name='notepad.exe'; ExecutablePath='C:\Windows\notepad.exe'})) {
    $script:processes=@($holder,(New-Watcher)); $script:watchKills.Clear()
    $left=Stop-ClosedDesktopWatchers $dir $script:processes
    Assert ($left -eq $true -and $script:watchKills.Count -eq 1) "An observer whose desktop id was reused by $($holder.Name) was kept"
}
# Never ended while its desktop may still be there: the desktop itself, or an
# id holder whose image and age cannot be read. The stop then names it.
foreach ($holder in @([pscustomobject]@{ProcessId=4321; ParentProcessId=8; CreationDate=$t0.AddMinutes(-5); Name='Orgtree.exe'; ExecutablePath=$desktopExe},
                      [pscustomobject]@{ProcessId=4321; ParentProcessId=8; CreationDate=$null; Name='mystery.exe'; ExecutablePath=$null})) {
    $script:task=New-FakeTask $xml; $script:task.KeepProcesses=$true
    $script:processes=@($holder,(New-Watcher),$conhost); $script:watchKills.Clear()
    Refuses { Stop-OwnedBootTask $script:folder $original $dir 0 } 'Still running: orgtree-engine\.exe pid 501 \(core-recovery watch, parent 4321\)'
    Assert ($script:watchKills.Count -eq 0) "An observer was ended while its desktop could still be running ($($holder.Name))"
}
# Never another installation's binary, and never another mode of this one.
$script:processes=@((New-Watcher -Exe (Join-Path ($dir+'-other') 'resources\engine\orgtree-engine.exe')),(New-Watcher -Id 503 -Mode 'core-recovery arm'),(New-Watcher -Id 504 -Mode 'host'))
$script:watchKills.Clear()
$left=Stop-ClosedDesktopWatchers $dir $script:processes
Assert ($left -eq $false -and $script:watchKills.Count -eq 0) "A process that is not this installation's observer was ended: $($script:watchKills -join ',')"
# Graceful first: an observer that stands down by itself within the grace is
# not ended (later engines do, as soon as their desktop closes for an install).
$savedProcesses=${function:Get-BootProcesses}
$script:standReads=0
function Get-BootProcesses { $script:standReads++; if ($script:standReads -eq 1) { return @((New-Watcher)) }; return @() }
$script:watchKills.Clear(); $script:bootLog.Clear()
$left=Stop-ClosedDesktopWatchers $dir (Get-BootProcesses) 2
Assert ($left -eq $true -and $script:watchKills.Count -eq 0 -and $script:standReads -eq 2) 'An observer that stood down by itself was ended anyway'
Assert (@($script:bootLog -like 'watcher: 1 core-recovery observer(s) of a closed desktop stood down by themselves').Count -eq 1) 'The stand-down was not logged'
Set-Item Function:Get-BootProcesses $savedProcesses
$script:processes=@()

# ---- The removed sign-in engine option (user 2026-10-16 09:37Z: "just replace
# the run at sign in option entirely. agents always start at boot, and then
# automatically get upgraded when signed in"). Run on boot is the boot task and
# the credential helper, which is also the launcher that starts agent turns in
# the operator's signed-in session. "Orgtree Sign-in Engine" from 4.3.x is
# deleted at the update, after its engine is stopped (coordinator ruling E),
# and the record's StartupMode goes with it. The helper's run level follows
# "Run Orgtree as administrator" (ruling C), so the agents it starts keep the
# rights the boot engine gives them.
$script:folder | Add-Member -Force ScriptMethod DeleteTask { param($name,$flags) $script:events.Add('delete'); $script:task=$null }
function Get-RegisteredEnabled($Task) { return ((Read-BootXml $Task.Xml).Task.Settings.Enabled -eq 'true') }
# What 4.3.x registered as "Orgtree Sign-in Engine": the existing task an update meets.
function New-OldSigninTaskXml($Record, [bool]$Highest) {
    $doc = Read-BootXml @'
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description /></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId /></LogonTrigger></Triggers><Principals><Principal id="Operator"><UserId /><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>false</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Operator"><Exec><Command /><WorkingDirectory /></Exec></Actions></Task>
'@
    $doc.Task.RegistrationInfo.Description = "com.maurdekye.orgtree.signin-engine.v1:$($Record.Id)"
    $doc.Task.Triggers.LogonTrigger.UserId = $Record.OperatorSid
    $doc.Task.Principals.Principal.UserId = $Record.OperatorSid
    if ($Highest) { $doc.Task.Principals.Principal.RunLevel = 'HighestAvailable' }
    $doc.Task.Actions.Exec.Command = [string](Join-Path $Record.InstallDir 'resources\engine\orgtree-engine-host.exe')
    $doc.Task.Actions.Exec.WorkingDirectory = [string](Join-Path $Record.InstallDir 'resources\engine')
    return $doc.OuterXml
}
$signinHost=Join-Path $dir 'resources\engine\orgtree-engine-host.exe'
$signinXml=New-OldSigninTaskXml $original $false
# The old task is still recognized by its marker before it is stopped and deleted.
Assert-OwnedSigninTask (New-SigninFake $signinXml) $original $dir
Assert-OwnedSigninTask (New-SigninFake (New-OldSigninTaskXml $original $true)) $original $dir
$omitted=New-SigninFake ($signinXml.Replace('<RunLevel>LeastPrivilege</RunLevel>',''))
Assert ($omitted.Xml -ne $signinXml) 'Windows default-omission fixture is inert'
Assert-OwnedSigninTask $omitted $original $dir
$omitted.Definition.Principal.RunLevel=1
Refuses { Assert-OwnedSigninTask $omitted $original $dir } 'run level'
foreach ($bad in @($signinXml.Replace('InteractiveToken','S4U'),$signinXml.Replace($sid,'S-1-5-21-111-222-333-9999'),$signinXml.Replace($original.Id,[guid]::NewGuid().ToString()),$signinXml.Replace('orgtree-engine-host.exe','other.exe'))) {
    Refuses { Assert-OwnedSigninTask (New-SigninFake $bad) $original $dir } 'sign-in engine'
}
$writable=New-SigninFake $signinXml; $writable.Sddl='O:BAG:BAD:P(A;;GA;;;WD)'
Refuses { Assert-OwnedSigninTask $writable $original $dir } 'write access'

# The helper's run level follows "Run Orgtree as administrator". Ownership
# accepts both levels (and the LeastPrivilege Windows omits) and refuses a
# principal that disagrees with its XML.
$helperDoc=Read-BootXml (New-HelperTaskXml $original $false)
Assert ($helperDoc.Task.Principals.Principal.RunLevel -ceq 'LeastPrivilege') 'Without Run as administrator the helper must run with least privilege'
Assert ((Read-BootXml (New-HelperTaskXml $original $true)).Task.Principals.Principal.RunLevel -ceq 'HighestAvailable') 'Run as administrator must give the helper, and the agents it starts, the highest privileges'
Assert-OwnedHelperTask (New-HelperFake (New-HelperTaskXml $original $false)) $original $dir
Assert-OwnedHelperTask (New-HelperFake (New-HelperTaskXml $original $true)) $original $dir
$omittedHelper=New-HelperFake ((New-HelperTaskXml $original $false).Replace('<RunLevel>LeastPrivilege</RunLevel>',''))
Assert-OwnedHelperTask $omittedHelper $original $dir
$omittedHelper.Definition.Principal.RunLevel=1
Refuses { Assert-OwnedHelperTask $omittedHelper $original $dir } 'run level'

# An update of an installation that started the engine at sign-in: Prepare
# keeps the old task disabled while files are replaced and drops the removed
# mode; Register deletes the old task after its stop, never registers it, and
# runs on boot as before.
[IO.File]::WriteAllText($brokerPath,'fixture')
$script:task=$null; $script:helper=$null; $script:processes=@(); $script:engineAnswers=$false
$script:record=$original.Clone(); $script:record['RunOnStartup']=1; $script:record['StartupMode']='signin'
$script:signin=New-SigninFake $signinXml
$script:events.Clear()
Invoke-BootLifecycle Prepare $dir $sid
Assert ($null -eq $script:record['StartupMode']) 'An update must drop the removed start mode from the record'
Assert ($script:record['RunOnStartup'] -eq 1) 'An installation that started the engine at sign-in must run on boot after the update'
Assert (-not $script:signin.Enabled) 'Prepare must keep the old sign-in engine disabled while files are replaced'
$script:events.Clear()
Invoke-BootLifecycle Register $dir
Assert ($null -eq $script:signin -and $script:events -contains 'signin-delete') "The obsolete sign-in engine task was not deleted: $($script:events -join ',')"
Assert ($script:events.IndexOf('signin-stop') -ge 0 -and $script:events.IndexOf('signin-stop') -lt $script:events.IndexOf('signin-delete')) 'The obsolete sign-in engine task was deleted before its stop'
Assert (-not ($script:events -match '^signin-register')) 'The removed sign-in engine task was registered again'
Assert ((Get-RegisteredEnabled $script:task) -and (Get-RegisteredEnabled $script:helper)) 'Run on boot must enable the boot task and the helper'
Assert ($script:events -contains 'run' -and $script:events -contains 'helper-run') "Run on boot must start the boot task and the helper: $($script:events -join ',')"
$script:runAsAdmin=$true; $script:events.Clear()
Invoke-BootLifecycle Register $dir
Assert ((Read-BootXml $script:helper.Xml).Task.Principals.Principal.RunLevel -ceq 'HighestAvailable') 'Run as administrator must register the helper with the highest privileges'
$script:runAsAdmin=$false; $script:events.Clear()
Invoke-BootLifecycle Register $dir
Assert ((Read-BootXml $script:helper.Xml).Task.Principals.Principal.RunLevel -ceq 'LeastPrivilege') 'Turning Run as administrator off must take the helper back to least privilege'
# Run on boot off: both disabled, neither started, and an old sign-in engine task goes too.
$script:record['RunOnStartup']=0; $script:signin=New-SigninFake $signinXml; $script:events.Clear()
Invoke-BootLifecycle Register $dir
Assert (-not (Get-RegisteredEnabled $script:task) -and -not (Get-RegisteredEnabled $script:helper)) 'Run on boot off must disable the boot task and the helper'
Assert (-not ($script:events -match '^(run|helper-run|signin-run)$')) "A task was started with Run on boot off: $($script:events -join ',')"
Assert ($null -eq $script:signin -and $script:events -contains 'signin-delete') 'An update with Run on boot off must delete the obsolete sign-in engine task too'
$script:record['RunOnStartup']=1
$script:events.Clear()
Invoke-BootLifecycle Register $dir

# Stopping a running old sign-in engine during an update: graceful first, as for the boot engine.
$script:signin=New-SigninFake $signinXml
$hostProcess=[pscustomobject]@{ProcessId=701; ParentProcessId=1; CreationDate='S1'; Name='orgtree-engine-host.exe'; ExecutablePath=$signinHost}
$signinTree=@($hostProcess,
    [pscustomobject]@{ProcessId=702; ParentProcessId=701; CreationDate='S2'; Name='orgtree-engine.exe'; ExecutablePath=(Join-Path $paths.Engine 'orgtree-engine.exe')},
    [pscustomobject]@{ProcessId=703; ParentProcessId=702; CreationDate='S3'; Name='cli.exe'; ExecutablePath='C:\provider\cli.exe'})
$script:task.KeepProcesses=$true
$script:signin.Enabled=$true; $script:processes=$signinTree; $script:engineAnswers=$true; $script:events.Clear()
Stop-OwnedBootTask $script:folder $script:record $dir 2
Assert ($script:events -contains 'engine-request' -and -not ($script:events -contains 'signin-stop')) "The sign-in engine task was ended although the engine took the request: $($script:events -join ',')"
Assert (-not $script:signin.Enabled) 'The sign-in engine task must stay disabled while files are replaced'
$script:signin.Enabled=$true; $script:processes=$signinTree; $script:engineAnswers=$false; $script:events.Clear()
Stop-OwnedBootTask $script:folder $script:record $dir 2
Assert ($script:events.IndexOf('engine-request') -ge 0 -and $script:events.IndexOf('engine-request') -lt $script:events.IndexOf('signin-stop')) "An engine that cannot be asked must be stopped by ending the sign-in engine task, after asking: $($script:events -join ',')"
Assert ($script:processes.Count -eq 0) 'The sign-in engine tree survived its stop'
$script:signin.Enabled=$true; $script:signin.KeepProcesses=$true; $script:processes=$signinTree; $script:events.Clear()
Refuses { Stop-OwnedBootTask $script:folder $script:record $dir 0 } 'did not stop'
Assert ($script:signin.Enabled) 'A failed stop must restore the enabled sign-in engine task'
$script:signin.Enabled=$false
Refuses { Stop-OwnedBootTask $script:folder $script:record $dir 0 } 'did not stop'
Assert (-not $script:signin.Enabled) 'A failed stop must keep a disabled sign-in engine task disabled'
$script:signin.KeepProcesses=$false; $script:processes=@(); $script:signin.Instances=1
Refuses { Stop-OwnedBootTask $script:folder $script:record $dir 0 } 'the Orgtree Sign-in Engine task \(1 instance\(s\) running\)'
$script:signin.Instances=0; $script:task.KeepProcesses=$false
$script:processes=@([pscustomobject]@{ProcessId=777; ParentProcessId=1; CreationDate='X'; Name='orgtree-engine-host.exe'; ExecutablePath=$null})
Refuses { Assert-BootDesktopClosed $dir } 'Cannot verify executable path for process 777'
$script:processes=@()

# A changed or unowned sign-in engine task refuses every action before anything changes.
$script:signin=New-SigninFake ($signinXml.Replace('InteractiveToken','S4U'))
foreach ($action in @('Prepare','Register','Stop','Remove')) {
    $script:events.Clear()
    Refuses { Invoke-BootLifecycle $action $dir $sid } 'sign-in engine'
    Assert (-not ($script:events -match '^(stop|delete|register|save|remove-record|helper-|signin-)')) "A changed sign-in engine task let $action change something: $($script:events -join ',')"
}
$ownedRecord=$script:record; $script:record=$null; $script:task=$null; $script:helper=$null
$script:signin=New-SigninFake $signinXml
Refuses { Invoke-BootLifecycle Prepare $dir $sid } 'without installer ownership'
$script:record=$ownedRecord; $script:signin=$null
# Uninstall deletes a leftover sign-in engine task too, after the stop.
$script:signin=New-SigninFake $signinXml
$script:events.Clear()
Invoke-BootLifecycle Remove $dir
Assert ($null -eq $script:signin -and $script:events -contains 'signin-delete') "Uninstall did not remove the sign-in engine task: $($script:events -join ',')"
Assert ($script:events.IndexOf('signin-stop') -ge 0 -and $script:events.IndexOf('signin-stop') -lt $script:events.IndexOf('signin-delete')) 'The sign-in engine task was deleted before its stop'
Assert ($null -eq $script:record -and $null -eq $script:task -and $null -eq $script:helper) 'Uninstall did not remove the other tasks and the record'
[IO.File]::Delete($signinHost); [IO.File]::Delete($brokerPath)
Write-Output "PASS $script:checks installer assertions; synthetic fixture: $root"
