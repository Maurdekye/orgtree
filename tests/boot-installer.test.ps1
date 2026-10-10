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
function Register-HelperTask($Folder,[string]$Xml,[int]$Flags,[string]$Sid,[string]$Sddl) {
    $script:events.Add("helper-register:$Flags")
    Assert ($Sid -eq $script:record.OperatorSid -and $Sddl -match '^O:BAG:BAD:P') 'Wrong helper principal or ACL'
    $script:helper=New-FakeTask $Xml
    $script:helper | Add-Member -Force ScriptMethod Stop { param($flags) $script:events.Add('helper-stop') }
    $script:helper | Add-Member -Force ScriptMethod Run { param($args) $script:events.Add('helper-run') }
    return $script:helper
}
function Remove-HelperTask($Folder) { $script:events.Add('helper-delete'); $script:helper=$null }
function Stop-HelperProcess($Process) { $script:events.Add('helper-kill'); $script:processes=@($script:processes | Where-Object { $_.ProcessId -ne $Process.ProcessId }) }
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
# The operator's own "Run on startup" from desktop-settings.json: none unless a test sets one.
$script:operatorChoice=$null
function Get-OperatorStartupChoice([string]$Sid) { return $script:operatorChoice }

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
Refuses { Invoke-BootLifecycle Prepare $dir $sid } 'Cannot verify executable path'
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
Assert (-not $script:task.Enabled) 'The task must stay disabled while files are replaced'
# An engine that cannot be asked is stopped by ending its task, after asking.
$script:task=New-FakeTask $xml
$script:processes=$engineTree; $script:engineAnswers=$false; $script:events.Clear()
Stop-OwnedBootTask $script:folder $original $dir 2
Assert ($script:events.IndexOf('engine-request') -ge 0 -and $script:events.IndexOf('engine-request') -lt $script:events.IndexOf('stop')) 'The engine must be asked before its task is ended'
# Nothing running: there is nobody to ask, and the task is ended as before.
$script:task=New-FakeTask $xml
$script:processes=@(); $script:events.Clear()
Stop-OwnedBootTask $script:folder $original $dir 2
Assert (-not ($script:events -contains 'engine-request') -and $script:events -contains 'stop') 'An idle engine needs no request'
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
Write-Output "PASS $script:checks installer assertions; synthetic fixture: $root"
