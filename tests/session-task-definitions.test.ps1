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
# Decision 94: the main engine always runs in Session 0, so the installer no
# longer defines the "Orgtree User Session Engine" task (decision 93's move
# into the signed-in session); Register deletes a leftover one.
foreach ($retired in @('New-InteractiveTaskXml','Register-InteractiveTask')) {
    Check (-not (Get-Command $retired -ErrorAction SilentlyContinue)) "The retired user-session task has no $retired"
}
foreach ($kept in @('Find-InteractiveTask','Assert-OwnedInteractiveTask','Remove-InteractiveTask')) {
    Check (Get-Command $kept -ErrorAction SilentlyContinue) "An update can still verify and delete a leftover user-session task ($kept)"
}
foreach ($enabled in @($false,$true)) {
    $record.RunOnStartup=[int]$enabled
    foreach ($kind in @('boot','helper')) {
        $name=@{boot='New-BootTaskXml';helper='New-HelperTaskXml'}[$kind]
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
            Check $false "$kind task definition is available"
            continue
        }
        foreach ($admin in @($false,$true)) {
            $xml=& $name $record $admin
            $doc=Read-BootXml $xml
            Check ($doc.Task.Settings.Enabled -eq 'true') "$kind keeps demand launch available (startup=$enabled admin=$admin)"
            $triggers=@($doc.SelectNodes('//*[local-name()="Triggers"]/*'))
            Check ($triggers.Count -eq 1) "$kind has exactly one owned automatic trigger"
            $want=$enabled
            foreach ($trigger in $triggers) {
                Check ($trigger.Enabled -ceq (Get-EnabledText $want)) "$kind automatic trigger follows startup=$enabled admin=$admin"
            }
            # One "Run as admin" for both owned tasks, the Session 0 engine and
            # the session-1 helper, with only these two run levels (invariant 7).
            $expected=if ($admin) {'HighestAvailable'} else {'LeastPrivilege'}
            Check ($doc.Task.Principals.Principal.RunLevel -ceq $expected) "Unified admin setting controls the $kind task's rights (admin=$admin)"
            if ($kind -eq 'boot') {
                Check ($doc.Task.Principals.Principal.LogonType -ceq 'S4U') 'The boot engine keeps the S4U logon at boot'
            }
            if ($kind -eq 'helper') {
                Check ($doc.Task.Principals.Principal.LogonType -ceq 'InteractiveToken') 'The helper runs in the operator''s signed-in session'
            }
        }
    }
}
Write-Output "RESULT $checks checks; $($failures.Count) failed"
if ($failures.Count) { exit 1 }
