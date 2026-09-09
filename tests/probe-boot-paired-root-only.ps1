# COORDINATOR ONLY: reviewed immutable snapshot; one random on-demand task.
# Real host/launch/guardian, fresh empty data/profile, no provider credentials.
# Runtime audit instrumentation denies remote sockets and provider subprocesses.
param([Parameter(Mandatory=$true)][string]$RuntimeDir,
      [Parameter(Mandatory=$true)][string]$OperatorSid)
$ErrorActionPreference='Stop'
$snapshot=Split-Path $PSScriptRoot
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Coordinator must run elevated.' }
$manifest=Get-Content -Raw -LiteralPath (Join-Path $snapshot 'probe-source.json') | ConvertFrom-Json
if ($manifest.commit -notmatch '^[0-9a-f]{40}$') { throw 'Exact source commit required.' }
foreach($entry in $manifest.files.PSObject.Properties) {
    if ($entry.Name.Contains('..') -or [IO.Path]::IsPathRooted($entry.Name)) { throw 'Invalid snapshot path' }
    $file=Join-Path $snapshot $entry.Name
    if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Snapshot links refused' }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $entry.Value) { throw "Snapshot changed: $($entry.Name)" }
}
. "$snapshot\tools\boot-engine-task.ps1"
$null=Assert-BootSid $OperatorSid
$script:ProductionBootTaskXml=${function:New-BootTaskXml}
function New-BootTaskXml($Record) {
    $doc=Read-BootXml (& $script:ProductionBootTaskXml $Record)
    $doc.Task.Triggers.RemoveAll()
    $null=$doc.Task.Settings.RemoveChild($doc.Task.Settings.RestartOnFailure)
    $ns=[Xml.XmlNamespaceManager]::new($doc.NameTable); $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    if ($doc.SelectNodes('/t:Task/t:Triggers/* | /t:Task/t:Settings/t:RestartOnFailure',$ns).Count) { throw 'Automatic start refused' }
    return $doc.OuterXml
}
function Copy-ProbePlainTree([string]$Source,[string]$Target) {
    $item=Get-Item -LiteralPath $Source
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Runtime link refused: $Source" }
    [IO.Directory]::CreateDirectory($Target) | Out-Null
    foreach($entry in Get-ChildItem -LiteralPath $Source -Force) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Runtime link refused: $($entry.FullName)" }
        $to=Join-Path $Target $entry.Name
        if ($entry.PSIsContainer) { Copy-ProbePlainTree $entry.FullName $to }
        else { [IO.File]::Copy($entry.FullName,$to,$false) }
    }
}
function Test-ProbeRootReleased([string]$Root) {
    $file=[IO.File]::Open((Join-Path $Root '.desktop-engine.lock'),'Open','ReadWrite','ReadWrite')
    try { try { $file.Lock(0,1) } catch [IO.IOException] { return $false }; $file.Unlock(0,1); return $true }
    finally { $file.Dispose() }
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('orgtree-paired-task-'+[guid]::NewGuid().ToString('N'))
$dir=Join-Path $root ('Orgtree & '+[char]0xe9+' '+[char]0x5d0)
$paths=Get-BootPaths $dir
[IO.Directory]::CreateDirectory($paths.Engine) | Out-Null
foreach($entry in $manifest.files.PSObject.Properties | Where-Object { $_.Name.StartsWith('engine/') }) {
    $to=Join-Path $paths.Engine $entry.Name.Substring(7)
    [IO.Directory]::CreateDirectory((Split-Path $to)) | Out-Null
    [IO.File]::Copy((Join-Path $snapshot $entry.Name),$to,$false)
}
Copy-ProbePlainTree $RuntimeDir (Split-Path $paths.Python)
$data=Join-Path $dir 'probe-data'; $profile=Join-Path $dir 'probe-profile'; $ui=Join-Path $dir 'resources\ui'
foreach($folder in @($data,$profile,$ui)) { [IO.Directory]::CreateDirectory($folder) | Out-Null }
[IO.File]::WriteAllText((Join-Path $data 'warm.flag'),'0')
[IO.File]::WriteAllText((Join-Path $ui 'index.html'),'<!doctype html>paired boot probe')
# Keep reviewed host bytes intact; shim ONLY selects the throwaway environment.
[IO.File]::Move($paths.Host,(Join-Path $paths.Engine 'service_host.reviewed.py'))
$shim=@'
import os, pathlib, runpy
install = pathlib.Path(__file__).resolve().parents[2]
keep = {k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','SYSTEMDRIVE','COMSPEC'}}
os.environ.clear(); os.environ.update(keep)
profile = install / 'probe-profile'
for k,p in {'USERPROFILE':profile,'HOME':profile,'APPDATA':profile/'AppData'/'Roaming','LOCALAPPDATA':profile/'AppData'/'Local','TEMP':profile/'Temp','TMP':profile/'Temp','CODEX_HOME':profile/'.codex','CLAUDE_CONFIG_DIR':profile/'.claude'}.items():
    p.mkdir(parents=True, exist_ok=True); os.environ[k] = str(p)
os.environ.update(ORGTREE_DATA=str(install/'probe-data'), ORGTREE_V2_DATA=str(install/'probe-data'), ORGTREE_V2_UI_DIR=str(install/'resources'/'ui'), ORGTREE_WARM='0', ORGTREE_V2_PORT='0', PATH=str(pathlib.Path(keep['SYSTEMROOT'])/'System32'))
runpy.run_path(str(pathlib.Path(__file__).with_name('service_host.reviewed.py')), run_name='__main__')
'@
[IO.File]::WriteAllText($paths.Host,$shim,[Text.UTF8Encoding]::new($false))
# Instrument ONLY the copied runtime. Child is spawned after readiness, hence
# after launch.py is enrolled in the real guardian Job; it is not a provider.
$audit=@'
import json, os, pathlib, sys, threading, time
engine = pathlib.Path(sys.executable).resolve().parent.parent
install = engine.parent.parent
def audit(event, args):
    if event == 'socket.connect' and isinstance(args[1], tuple) and args[1][0] not in ('127.0.0.1','::1'):
        raise RuntimeError('paired probe denies remote connections')
    if event == 'subprocess.Popen':
        exe = pathlib.Path(args[0]).name.lower()
        if exe not in ('python.exe','whoami','whoami.exe','icacls','icacls.exe'):
            raise RuntimeError('paired probe denies non-runtime subprocess')
sys.addaudithook(audit)
(install / ('audit-loaded-'+str(os.getpid())+'.json')).write_text(json.dumps({'pid':os.getpid(),'image':sys.argv[0]}),encoding='utf-8')
if pathlib.Path(sys.argv[0]).name == 'launch.py':
    def child_control():
        import subprocess
        marker=install/'probe-data'/'engine-attach.json'
        deadline=time.monotonic()+100
        while not marker.exists() and time.monotonic()<deadline: time.sleep(.1)
        if not marker.exists(): return
        child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'])
        (install/'child-control.json').write_text(json.dumps({'engine':os.getpid(),'child':child.pid}),encoding='utf-8')
    threading.Thread(target=child_control,daemon=True).start()
'@
$site=Join-Path (Split-Path $paths.Python) 'Lib\site-packages\sitecustomize.py'
if ([IO.File]::Exists($site)) { throw 'Existing sitecustomize refused; use a clean bundled runtime.' }
[IO.Directory]::CreateDirectory((Split-Path $site)) | Out-Null
[IO.File]::WriteAllText($site,$audit,[Text.UTF8Encoding]::new($false))
$script:BootTaskName='Orgtree paired host probe '+[guid]::NewGuid().ToString('N')
$script:probeRecord=$null
function Get-BootRecord { return $script:probeRecord }
function Save-BootRecord($Record) { $script:probeRecord=$Record }
function Remove-BootRecord { $script:probeRecord=$null }
$result=@{commit=$manifest.commit;task=$script:BootTaskName;root=$root;dataRoot=$data;profile=$profile;registryTouched=$false;productionTaskTouched=$false}
Write-Output "Temporary task: $script:BootTaskName"
Write-Output "Rollback: inspect schtasks.exe /Query /TN `"$script:BootTaskName`" /XML; confirm exact action $($paths.Python) + $($paths.Host); then /End /TN `"$script:BootTaskName`" and /Delete /TN `"$script:BootTaskName`" /F using schtasks.exe. Verify fixture process exit, retain $root; no recursive cleanup."
try {
    Invoke-BootLifecycle Prepare $dir $OperatorSid
    Invoke-BootLifecycle Register $dir
    $descriptor=Join-Path $data 'engine-attach.json'; $control=Join-Path $dir 'child-control.json'
    $deadline=[DateTime]::UtcNow.AddSeconds(120)
    while ((-not [IO.File]::Exists($descriptor) -or -not [IO.File]::Exists($control)) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (-not [IO.File]::Exists($descriptor) -or -not [IO.File]::Exists($control)) { throw 'Real host/guardian child control did not become ready.' }
    $ready=Get-Content -Raw -LiteralPath $descriptor | ConvertFrom-Json
    $child=Get-Content -Raw -LiteralPath $control | ConvertFrom-Json
    if ($ready.dataRootId -ine $data -or $ready.enginePid -ne $child.engine) { throw 'Wrong root or engine receipt.' }
    foreach($id in @($ready.hostPid,$ready.enginePid,$child.child)) {
        if (-not [IO.File]::Exists((Join-Path $dir "audit-loaded-$id.json"))) { throw 'Runtime isolation audit is not active in every control process.' }
    }
    $url="http://127.0.0.1:$($ready.port)/api/desktop/identity"
    $reply=Invoke-RestMethod -Uri $url -Headers @{'X-Orgtree-Desktop-Token'=$ready.token} -TimeoutSec 10
    if ($reply.pid -ne $child.engine -or $reply.dataRootId -ine $data) { throw 'Wrong authenticated engine identity' }
    $negative=$false
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 10 | Out-Null }
    catch { if ($_.Exception.Response.StatusCode.value__ -eq 401) { $negative=$true } else { throw } }
    if (-not $negative) { throw 'Unauthenticated identity was not refused' }
    if (Test-ProbeRootReleased $data) { throw 'Guardian lock positive control was not held' }
    foreach($id in @($ready.hostPid,$ready.enginePid,$child.child)) { if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { throw 'Control process absent before Stop' } }
    $result.identity=$true; $result.unauthenticatedRefused=$true; $result.lockHeldBeforeStop=$true
    $result.pids=@($ready.hostPid,$ready.enginePid,$child.child)
    Invoke-BootLifecycle Stop $dir
    foreach($id in $result.pids) { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { throw "Process survived stop: $id" } }
    if (-not (Test-ProbeRootReleased $data)) { throw 'Guardian root lock remains held after stop' }
    $result.treeGone=$true; $result.lockReleased=$true
    # A hard stop may leave a descriptor: its absence is NOT a stop proof.
    Invoke-BootLifecycle Remove $dir
    $result.removed=$true
} finally {
    try { if ($null -ne $script:probeRecord) { Invoke-BootLifecycle Remove $dir } }
    catch { $result.cleanupError=$_.Exception.Message; throw }
    finally { $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'result.json') -Encoding UTF8; Write-Output "Evidence: $root" }
}
