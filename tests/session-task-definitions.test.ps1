# Pure task definitions: no task registration, registry access, process launch or UAC.
$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\tools\boot-engine-task.ps1"
$failures=[Collections.Generic.List[string]]::new()
$checks=0
function Check($Value,[string]$Message) {
    $script:checks++
    if (-not $Value) { $script:failures.Add($Message); Write-Output "FAIL $Message" }
}
$record=@{InstallDir='C:\synthetic orgtree';OperatorSid='S-1-5-21-111-222-333-1001';Id='01234567-89ab-cdef-0123-456789abcdef';RunOnStartup=0}
foreach ($enabled in @($false,$true)) {
    $record.RunOnStartup=[int]$enabled
    foreach ($kind in @('boot','helper','interactive')) {
        $name=@{boot='New-BootTaskXml';helper='New-HelperTaskXml';interactive='New-InteractiveTaskXml'}[$kind]
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
            Check $false "$kind task definition is available"
            continue
        }
        foreach ($admin in @($false,$true)) {
            $xml=if ($kind -eq 'boot') { & $name $record } else { & $name $record $admin }
            $doc=Read-BootXml $xml
            Check ($doc.Task.Settings.Enabled -eq 'true') "$kind keeps demand launch available (startup=$enabled admin=$admin)"
            $triggers=@($doc.SelectNodes('//*[local-name()="Triggers"]/*'))
            Check ($triggers.Count -eq 1) "$kind has exactly one owned automatic trigger"
            foreach ($trigger in $triggers) {
                Check ($trigger.Enabled -ceq (Get-EnabledText $enabled)) "$kind automatic trigger follows startup=$enabled"
            }
            if ($kind -eq 'interactive') {
                Check ($doc.Task.Principals.Principal.LogonType -ceq 'InteractiveToken') 'Interactive engine uses the existing operator token'
                Check ($doc.Task.Principals.Principal.UserId -ceq $record.OperatorSid) 'Interactive engine pins the operator SID'
                $expected=if ($admin) {'HighestAvailable'} else {'LeastPrivilege'}
                Check ($doc.Task.Principals.Principal.RunLevel -ceq $expected) 'Unified admin setting controls interactive engine rights'
                Check ($doc.Task.Actions.Exec.Arguments -ceq 'session-launch signin') 'Interactive task runs only the fixed native handover command'
                Check ($doc.Task.Actions.Exec.Command -ceq 'C:\synthetic orgtree\resources\engine\orgtree-engine.exe') 'Interactive task executable is installed native engine'
                Check ($doc.SelectNodes('//*[local-name()="Actions"]/*').Count -eq 1) 'No extra task action can elevate arbitrary commands'
                Check ($doc.SelectNodes('//*[local-name()="RestartOnFailure"]').Count -eq 0) 'Failed handover never creates a Scheduler retry loop'
            }
        }
    }
}
Write-Output "RESULT $checks checks; $($failures.Count) failed"
if ($failures.Count) { exit 1 }
