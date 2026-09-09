# Only pure probe functions and audit controls; never execute the task harness.
param([string]$HostRevision='e4e8545227cea881aaafdb023cde96916d5b470e')
$ErrorActionPreference='Stop'
. "$PSScriptRoot\..\tools\boot-engine-task.ps1"
$script:ProductionBootTaskXml=${function:New-BootTaskXml}
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot\probe-boot-paired-root-only.ps1",[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw $errors }
foreach($name in @('New-BootTaskXml','Test-ProbeRootReleased','Read-ProbeJsonBytes')) {
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
$unicode='Orgtree & '+[char]0xe9+' '+[char]0x5d0
$json=@{dataRootId=$unicode} | ConvertTo-Json -Compress
if ((Read-ProbeJsonBytes ([Text.Encoding]::UTF8.GetBytes($json))).dataRootId -cne $unicode) { throw 'UTF8 identity positive failed' }
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
$prior=& git -c safe.directory='*' show '98b105359350de3d30d194e317758b8056622869:tests/probe-boot-paired-root-only.ps1'
if ($LASTEXITCODE -ne 0) { throw 'Cannot load original failing audit for regression control' }
$priorAst=[Management.Automation.Language.Parser]::ParseInput(($prior -join "`n"),[ref]$tokens,[ref]$errors)
$priorNode=$priorAst.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$audit'},$true)
$values['previousAudit']=$priorNode.Right.FindAll({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst]},$true).Value

$values | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'sources.json') -Encoding UTF8
$runner=@'
import ast, json, os, pathlib, subprocess, sys, types
root=pathlib.Path(sys.argv[1]); sources=json.loads((root/'sources.json').read_text(encoding='utf-8-sig'))
for name, text in sources.items(): compile(text,name,'exec')
install=(root/'fixture').resolve(); (install/'resources'/'engine'/'runtime').mkdir(parents=True)
sys.executable=str(install/'resources'/'engine'/'runtime'/'python.exe'); sys.argv[0]='preparation-only'
# Use the actual Windows audit-event shape without starting any child.
# executable defaults to None unless the Popen wrapper supplies it explicitly.
observed_exec=[]
class WindowsPopenControl:
    def __init__(self,args,*rest,**kw):
        observed_exec.append(kw.get('executable'))
        sys.audit('subprocess.Popen',kw.get('executable'),subprocess.list2cmdline(args),None,None)
subprocess.Popen=WindowsPopenControl
scope={}; exec(compile(sources['audit'],'audit','exec'),scope)
# Replay the original audited function directly: Windows supplied None and
# the old Path(None) crashed before any child could be created.
prior_scope=dict(scope)
prior_fn=next(n for n in ast.parse(sources['previousAudit']).body if isinstance(n,ast.FunctionDef) and n.name=='audit')
exec(compile(ast.Module(body=[prior_fn],type_ignores=[]),'original-audit','exec'),prior_scope)
try: prior_scope['audit']('subprocess.Popen',(None,subprocess.list2cmdline([sys.executable,'launch.py']),None,None))
except TypeError: pass
else: raise AssertionError('Original Path(None) failure did not reproduce')

# This invocation used to fail before launch with Path(None).
scope['ProbePopen']([sys.executable,'launch.py'])
assert observed_exec[-1] == sys.executable
try: WindowsPopenControl([sys.executable,'launch.py'])
except RuntimeError as exc: assert 'explicit executable' in str(exc)
else: raise AssertionError('Missing executable positive-negative control became inert')
try: scope['ProbePopen']([str(install/'foreign'/'python.exe'),'-c','pass'])
except RuntimeError: pass
else: raise AssertionError('Foreign same-name Python permitted')
def refused(event,*args):
    try: sys.audit(event,*args)
    except RuntimeError: return
    raise AssertionError('Audit guard did not refuse '+event)
refused('socket.connect',None,('192.0.2.1',443))
refused('subprocess.Popen','provider.exe',[],None,None)
try: scope['ProbePopen'](['git','rev-parse','HEAD'])
except FileNotFoundError: pass
else: raise AssertionError('Fixture Git must stay unavailable; no Git subprocess permitted')
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
    return types.SimpleNamespace(stdout=(f'{sid}|{sid},S-1-5-18,S-1-5-32-544|0' if args[0] == str(ps) else f'"operator","{sid}"'))
names={'_current_user_sid','restrict_descriptor_acl','verify_restricted_acl'}
nodes=[n for n in ast.parse(sources['host']).body if isinstance(n,ast.FunctionDef) and n.name in names]
assert len(nodes)==3
host={'Path':pathlib.Path,'os':types.SimpleNamespace(name='nt'),'sys':sys,'subprocess':types.SimpleNamespace(run=fake_run,SubprocessError=subprocess.SubprocessError)}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'reviewed-host-functions','exec'),host)
assert host['_current_user_sid']()==sid
assert host['restrict_descriptor_acl'](target)
assert host['verify_restricted_acl'](target)
assert set(observed)=={'whoami.exe','icacls.exe','powershell.exe'}, observed
assert list(install.glob('audit-loaded-*.json'))
# Exercise exception capture using the real shim, with run_path replaced by
# a sentinel failure. No reviewed host, child process or provider is executed.
import runpy
original_run=runpy.run_path; original_env=dict(os.environ); original_stderr=sys.stderr
shimfile=install/'resources'/'engine'/'service_host.py'
def fails_early(*args,**kw): raise RuntimeError('paired-preparation-early-failure-control')
runpy.run_path=fails_early
try:
    try: exec(compile(sources['shim'],'shim','exec'),{'__file__':str(shimfile)})
    except RuntimeError as exc: assert str(exc)=='paired-preparation-early-failure-control'
    else: raise AssertionError('Expected early exception')
finally:
    runpy.run_path=original_run; os.environ.clear(); os.environ.update(original_env)
    if sys.stderr is not original_stderr: sys.stderr.close()
    sys.stderr=original_stderr
assert 'paired-preparation-early-failure-control' in (install/'host-stderr.log').read_text()
print('PASS Windows executable=None regression and captured early traceback control')
print('PASS actual audit-hook negative/positive signals; no sockets or subprocesses launched')
'@
[IO.File]::WriteAllText((Join-Path $root 'check.py'),$runner,[Text.UTF8Encoding]::new($false))
python (Join-Path $root 'check.py') $root
if ($LASTEXITCODE -ne 0) { throw 'Audit preparation controls failed' }
Write-Output "PASS paired probe preparation (XML/lock/audit), no task operations: $root"
