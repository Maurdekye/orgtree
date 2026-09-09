# Only pure probe functions and audit controls; never execute the task harness.
$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\tools\boot-engine-task.ps1"
$script:ProductionBootTaskXml=${function:New-BootTaskXml}
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot\probe-boot-paired-root-only.ps1",[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw $errors }
foreach($name in @('New-BootTaskXml','Test-ProbeRootReleased')) {
    $fn=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true) | Where-Object Name -eq $name
    if (@($fn).Count -ne 1) { throw "Missing function: $name" }
    . ([scriptblock]::Create($fn.Extent.Text))
}
$record=@{InstallDir='C:\probe';OperatorSid='S-1-5-21-111-222-333-1001';Id=[guid]::NewGuid().ToString()}
$original=Read-BootXml (& $script:ProductionBootTaskXml $record)
$doc=Read-BootXml (New-BootTaskXml $record)
$ns=[Xml.XmlNamespaceManager]::new($doc.NameTable); $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
if ($doc.SelectNodes('/t:Task/t:Triggers/* | /t:Task/t:Settings/t:RestartOnFailure',$ns).Count) { throw 'Probe can auto-start' }
if (-not $original.SelectNodes('/t:Task/t:Triggers/*',$ns).Count) { throw 'Trigger removal positive control inert' }
foreach($name in @('Actions','Principals')) { if ($doc.Task.$name.OuterXml -cne $original.Task.$name.OuterXml) { throw 'Changed action/principal' } }
$root=Join-Path ([IO.Path]::GetTempPath()) ('orgtree-paired-preparation-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$file=Join-Path $root '.desktop-engine.lock'; [IO.File]::WriteAllText($file,'0')
$held=[IO.File]::Open($file,'Open','ReadWrite','ReadWrite')
try { $held.Lock(0,1); if (Test-ProbeRootReleased $root) { throw 'Held lock was reported released' } }
finally { $held.Dispose() }
if (-not (Test-ProbeRootReleased $root)) { throw 'Released lock positive control failed' }
$assignments=$ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst]},$true)
$values=@{}
foreach($name in @('shim','audit')) {
    $node=$assignments | Where-Object { $_.Left.Extent.Text -eq ('$'+$name) }
    $literal=$node.Right.FindAll({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst]},$true)
    if (@($literal).Count -ne 1) { throw 'Expected a single literal fixture' }
    $values[$name]=$literal.Value
}
$values | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'sources.json') -Encoding UTF8
$runner=@'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1]); sources=json.loads((root/'sources.json').read_text(encoding='utf-8-sig'))
for name, text in sources.items(): compile(text,name,'exec')
install=root/'fixture'; (install/'resources'/'engine'/'runtime').mkdir(parents=True)
sys.executable=str(install/'resources'/'engine'/'runtime'/'python.exe'); sys.argv[0]='preparation-only'
exec(compile(sources['audit'],'audit','exec'),{})
def refused(event,*args):
    try: sys.audit(event,*args)
    except RuntimeError: return
    raise AssertionError('Audit guard did not refuse '+event)
refused('socket.connect',None,('192.0.2.1',443))
refused('subprocess.Popen','provider.exe',[],None,None)
sys.audit('socket.connect',None,('127.0.0.1',12345))
sys.audit('subprocess.Popen',sys.executable,[],None,None)
assert list(install.glob('audit-loaded-*.json'))
print('PASS actual audit-hook negative/positive signals; no sockets or subprocesses launched')
'@
[IO.File]::WriteAllText((Join-Path $root 'check.py'),$runner,[Text.UTF8Encoding]::new($false))
python (Join-Path $root 'check.py') $root
if ($LASTEXITCODE -ne 0) { throw 'Audit preparation controls failed' }
Write-Output "PASS paired probe preparation (XML/lock/audit), no task operations: $root"
