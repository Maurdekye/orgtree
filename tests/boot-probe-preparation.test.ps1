# Parse the machine probe, execute ONLY its pure XML/cleanup functions with mocks.
$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\tools\boot-engine-task.ps1"
$script:ProductionBootTaskXml=${function:New-BootTaskXml}
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot\probe-boot-task-root-only.ps1",[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw $errors }
foreach($name in @('Assert-ProbeNoAutomaticStart','New-BootTaskXml','Complete-ProbeCleanup')) {
    $fn=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object Name -eq $name
    if (@($fn).Count -ne 1) { throw "Missing unique function $name" }
    . ([scriptblock]::Create($fn.Extent.Text))
}
$record=@{InstallDir='C:\Orgtree & é'; OperatorSid='S-1-5-21-111-222-333-1001'; Id='ff371d24-7f4b-463e-aede-29a18ef84693'}
$original=Read-BootXml (& $script:ProductionBootTaskXml $record)
$refused=$false
try { Assert-ProbeNoAutomaticStart $original } catch { $refused=$true }
if (-not $refused) { throw 'Positive automatic-trigger control did not fail' }
$xml=Read-BootXml (New-BootTaskXml $record)
Assert-ProbeNoAutomaticStart $xml
foreach($part in @('Principals','Actions')) {
    if ($xml.Task.$part.OuterXml -cne $original.Task.$part.OuterXml) { throw "Changed $part" }
}
# A restart-only payload must also be rejected.
$original.Task.Triggers.RemoveAll()
$refused=$false
try { Assert-ProbeNoAutomaticStart $original } catch { $refused=$true }
if (-not $refused) { throw 'Restart-only control did not fail' }
$script:probeRecord=$record
$script:removes=0
function Invoke-BootLifecycle($Action,$InstallDir) { if ($Action -ne 'Remove') { throw 'Unexpected action' }; $script:removes++ }
$result=@{}
Complete-ProbeCleanup $record.InstallDir $result
if ($script:removes -ne 1) { throw 'Cleanup positive control did not execute' }
function Invoke-BootLifecycle { throw 'synthetic cleanup refusal' }
$failed=$false
try { Complete-ProbeCleanup $record.InstallDir $result } catch { $failed=$true }
if (-not $failed -or $result.cleanupError -ne 'synthetic cleanup refusal') { throw 'Cleanup error was swallowed or lost' }
# Output of the task name and rollback guidance must precede registration.
$source=$ast.Extent.Text
$registration=$source.IndexOf('Invoke-BootLifecycle Register $dir')
foreach($text in @('Write-Output "Temporary task:', 'Write-Output "Rollback in an elevated PowerShell:')) {
    if ($source.IndexOf($text) -lt 0 -or $source.IndexOf($text) -gt $registration) { throw 'Rollback guidance follows registration' }
}
Write-Output 'PASS probe XML isolation, principal/action preservation, automatic-start refusal controls, cleanup propagation, pre-registration guidance; no machine operations'
