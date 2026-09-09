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
$script:events.Clear()
Invoke-BootLifecycle Remove $dir
Assert ($null -eq $script:record -and $null -eq $script:task) 'Uninstall did not remove own task/record'
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
