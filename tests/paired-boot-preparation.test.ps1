# Only pure probe functions and audit controls; never execute the task harness.
param([string]$HostRevision='d71aa83')
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
$hostSource=& git -c safe.directory='*' show "${HostRevision}:engine/service_host.py"
if ($LASTEXITCODE -ne 0) { throw 'Cannot read reviewed host subprocess contract' }
$values['host']=$hostSource -join "`n"
$values | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'sources.json') -Encoding UTF8
$runner=@'
import ast, json, os, pathlib, subprocess, sys, types
root=pathlib.Path(sys.argv[1]); sources=json.loads((root/'sources.json').read_text(encoding='utf-8-sig'))
for name, text in sources.items(): compile(text,name,'exec')
install=(root/'fixture').resolve(); (install/'resources'/'engine'/'runtime').mkdir(parents=True)
sys.executable=str(install/'resources'/'engine'/'runtime'/'python.exe'); sys.argv[0]='preparation-only'
scope={}; exec(compile(sources['audit'],'audit','exec'),scope)
def refused(event,*args):
    try: sys.audit(event,*args)
    except RuntimeError: return
    raise AssertionError('Audit guard did not refuse '+event)
refused('socket.connect',None,('192.0.2.1',443))
refused('subprocess.Popen','provider.exe',[],None,None)
sys.audit('socket.connect',None,('127.0.0.1',12345))
sys.audit('subprocess.Popen',sys.executable,[],None,None)
target=install/'probe-data'/f'.engine-attach-{os.getpid()}-0123456789abcdef.tmp'
target.parent.mkdir(); target.write_text('')
ps=scope['powershell']
command=scope['resolve_probe_args'](['powershell.exe','-NoProfile','-NonInteractive','-Command',scope['acl_readback'](target)])
assert command[0] == str(ps)
sys.audit('subprocess.Popen',str(ps),subprocess.list2cmdline(command),None,None)
refused('subprocess.Popen',str(ps),subprocess.list2cmdline([str(ps),'-Command','Invoke-WebRequest https://example.invalid']),None,None)
refused('subprocess.Popen',str(install/'powershell.exe'),subprocess.list2cmdline(command),None,None)
refused('subprocess.Popen',str(ps),subprocess.list2cmdline(command[:-1]+[scope['acl_readback'](install/'foreign.tmp')]),None,None)
# Drive the CURRENT reviewed host's actual three OS-command functions through
# a fake runner that emits real audit events instead of executing commands.
sid='S-1-5-21-111-222-333-1001'; observed=[]
def fake_run(args,**kw):
    args=scope['resolve_probe_args'](args); observed.append(pathlib.Path(args[0]).name.lower())
    sys.audit('subprocess.Popen',args[0],subprocess.list2cmdline(args),None,None)
    return types.SimpleNamespace(stdout=(f'{sid},S-1-5-18,S-1-5-32-544|0' if args[0] == str(ps) else f'"operator","{sid}"'))
names={'_current_user_sid','restrict_descriptor_acl','verify_restricted_acl'}
nodes=[n for n in ast.parse(sources['host']).body if isinstance(n,ast.FunctionDef) and n.name in names]
assert len(nodes)==3
host={'Path':pathlib.Path,'os':types.SimpleNamespace(name='nt'),'sys':sys,'subprocess':types.SimpleNamespace(run=fake_run,SubprocessError=subprocess.SubprocessError)}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'reviewed-host-functions','exec'),host)
assert host['_current_user_sid']()==sid
assert host['restrict_descriptor_acl'](target)
assert host['verify_restricted_acl'](target)
assert set(observed)=={'whoami','icacls','powershell.exe'}, observed
assert list(install.glob('audit-loaded-*.json'))
print('PASS actual audit-hook negative/positive signals; no sockets or subprocesses launched')
'@
[IO.File]::WriteAllText((Join-Path $root 'check.py'),$runner,[Text.UTF8Encoding]::new($false))
python (Join-Path $root 'check.py') $root
if ($LASTEXITCODE -ne 0) { throw 'Audit preparation controls failed' }
Write-Output "PASS paired probe preparation (XML/lock/audit), no task operations: $root"
