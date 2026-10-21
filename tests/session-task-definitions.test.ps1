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
            $xml=& $name $record $admin
            $doc=Read-BootXml $xml
            Check ($doc.Task.Settings.Enabled -eq 'true') "$kind keeps demand launch available (startup=$enabled admin=$admin)"
            $triggers=@($doc.SelectNodes('//*[local-name()="Triggers"]/*'))
            Check ($triggers.Count -eq 1) "$kind has exactly one owned automatic trigger"
            # The user-session engine moves the engine into the operator's session
            # at sign-in only while "Run as admin" is on (coordinator Q1, 2026-10-21
            # 16:27Z); with it off decision 84 stands and only demand runs start it.
            $want=if ($kind -eq 'interactive') { $enabled -and $admin } else { $enabled }
            foreach ($trigger in $triggers) {
                Check ($trigger.Enabled -ceq (Get-EnabledText $want)) "$kind automatic trigger follows startup=$enabled admin=$admin"
            }
            # One "Run as admin" for every owned task: the Session 0 boot engine
            # too (coordinator Q2), and only exactly these two run levels.
            $expected=if ($admin) {'HighestAvailable'} else {'LeastPrivilege'}
            Check ($doc.Task.Principals.Principal.RunLevel -ceq $expected) "Unified admin setting controls the $kind task's rights (admin=$admin)"
            if ($kind -eq 'boot') {
                Check ($doc.Task.Principals.Principal.LogonType -ceq 'S4U') 'The boot engine keeps the S4U logon at boot'
            }
            if ($kind -eq 'interactive') {
                Check ($doc.Task.Principals.Principal.LogonType -ceq 'InteractiveToken') 'Interactive engine uses the existing operator token'
                Check ($doc.Task.Principals.Principal.UserId -ceq $record.OperatorSid) 'Interactive engine pins the operator SID'
                # Windowless: the engine is a console program, so the task starts it
                # through the broker's fixed `session-engine` (no console window).
                Check ($doc.Task.Actions.Exec.Command -ceq 'C:\synthetic orgtree\resources\engine\orgtree-credential-broker.exe') 'Interactive task executable is the installed windowless broker'
                Check ($doc.Task.Actions.Exec.Arguments -ceq 'session-engine') 'Interactive task runs only the fixed session-engine launcher'
                Check ($doc.Task.Actions.Exec.WorkingDirectory -ceq 'C:\synthetic orgtree\resources\engine') 'Interactive task runs from the installed engine folder'
                Check ($doc.SelectNodes('//*[local-name()="Actions"]/*').Count -eq 1) 'No extra task action can elevate arbitrary commands'
                Check ($doc.SelectNodes('//*[local-name()="RestartOnFailure"]').Count -eq 0) 'Failed handover never creates a Scheduler retry loop'
                Check ($doc.Task.Settings.MultipleInstancesPolicy -ceq 'Parallel') 'A new start may run beside the host it replaces'
            }
        }
    }
}
Write-Output "RESULT $checks checks; $($failures.Count) failed"
if ($failures.Count) { exit 1 }
