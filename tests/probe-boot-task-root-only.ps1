# COORDINATOR ONLY, elevated, after review. Creates exactly one random temporary
# task and runs a synthetic Python sleeper, never service_host/engine/providers.
# Ownership registry is replaced with memory. Production task/data are untouched.
param([Parameter(Mandatory=$true)][string]$RuntimeDir,
      [Parameter(Mandatory=$true)][string]$OperatorSid)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Coordinator must run elevated.' }
. "$PSScriptRoot\..\tools\boot-engine-task.ps1"
$script:ProductionBootTaskXml = ${function:New-BootTaskXml}
function Assert-ProbeNoAutomaticStart($Xml) {
    $ns=[Xml.XmlNamespaceManager]::new($Xml.NameTable)
    $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    if ($Xml.SelectNodes('/t:Task/t:Triggers/* | /t:Task/t:Settings/t:RestartOnFailure', $ns).Count -ne 0) {
        throw 'Probe refuses automatic triggers or restart-on-failure.'
    }
}
function New-BootTaskXml($Record) {
    $doc=Read-BootXml (& $script:ProductionBootTaskXml $Record)
    $doc.Task.Triggers.RemoveAll()
    $null=$doc.Task.Settings.RemoveChild($doc.Task.Settings.RestartOnFailure)
    Assert-ProbeNoAutomaticStart $doc # enforced on the XML passed to RegisterTask
    return $doc.OuterXml
}
function Complete-ProbeCleanup($InstallDir, $Result) {
    if ($null -ne $script:probeRecord) {
        try { Invoke-BootLifecycle Remove $InstallDir }
        catch { $Result.cleanupError=$_.Exception.Message; throw }
    }
}
$null=Assert-BootSid $OperatorSid
$root=Join-Path ([IO.Path]::GetTempPath()) ('orgtree-owned-task-probe-'+[guid]::NewGuid().ToString('N'))
$dir=Join-Path $root ('Orgtree & '+[char]0x00e9+' '+[char]0x05d0)
$paths=Get-BootPaths $dir
[IO.Directory]::CreateDirectory((Split-Path $paths.Python)) | Out-Null
foreach($name in @('python.exe','python313.dll','python3.dll','python313.zip','python313._pth','vcruntime140.dll','vcruntime140_1.dll')) {
    $source=Join-Path $RuntimeDir $name
    if (-not [IO.File]::Exists($source)) { throw "Missing bundled runtime file: $name" }
    [IO.File]::Copy($source,(Join-Path (Split-Path $paths.Python) $name))
}
$fixture=@'
import json, os, pathlib, subprocess, sys, time
root = pathlib.Path(__file__).parent
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
sid = subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'], text=True).strip()
(root / 'probe.json').write_text(json.dumps({'exe': sys.executable, 'script': __file__, 'pid': os.getpid(), 'child': child.pid, 'identity': sid}), encoding='utf-8')
time.sleep(120)
'@
[IO.File]::WriteAllText($paths.Host,$fixture,[Text.UTF8Encoding]::new($false))
$script:BootTaskName='Orgtree isolated installer probe '+[guid]::NewGuid().ToString('N')
$script:probeRecord=$null
function Get-BootRecord { return $script:probeRecord }
function Save-BootRecord($Record) { $script:probeRecord=$Record }
function Remove-BootRecord { $script:probeRecord=$null }
$result=@{task=$script:BootTaskName; root=$root; productionTaskTouched=$false; registryTouched=$false}
try {
    Invoke-BootLifecycle Prepare $dir $OperatorSid
    Write-Output "Temporary task: $script:BootTaskName"
    Write-Output "Rollback in an elevated PowerShell: inspect schtasks.exe /Query /TN `"$script:BootTaskName`" /XML; confirm action is `"$($paths.Python)`" with script `"$($paths.Host)`"; then schtasks.exe /End /TN `"$script:BootTaskName`" and schtasks.exe /Delete /TN `"$script:BootTaskName`" /F. Verify only this fixture's processes have exited; retain $root for evidence. No recursive cleanup."
    Invoke-BootLifecycle Register $dir
    $receipt=Join-Path $paths.Engine 'probe.json'
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    while(-not [IO.File]::Exists($receipt) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (-not [IO.File]::Exists($receipt)) { throw 'Synthetic S4U payload did not produce a receipt.' }
    $ran=Get-Content -Raw -LiteralPath $receipt | ConvertFrom-Json
    if ($ran.exe -ine $paths.Python -or $ran.script -ine $paths.Host -or -not $ran.identity.Contains($OperatorSid)) { throw 'Serialized Unicode action or operator identity mismatch.' }
    $result.receipt=$ran
    Invoke-BootLifecycle Stop $dir
    foreach($processId in @($ran.pid,$ran.child)) {
        if(Get-Process -Id $processId -ErrorAction SilentlyContinue) { throw "Synthetic process survived: $processId" }
    }
    $result.stopped=$true
    Invoke-BootLifecycle Remove $dir
    $result.removed=$true
} finally {
    # Never use an unverified Delete/Stop even in cleanup. A refusal leaves the
    # random task named in the receipt for the coordinator to inspect manually.
    try { Complete-ProbeCleanup $dir $result }
    finally {
        $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding UTF8
        Write-Output "Root-only probe evidence: $root"
    }
}
