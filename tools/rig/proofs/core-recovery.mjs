// Real Engine/CoreLifecycle and Windows process observations. Electron rendering
// is excluded; the native launch target is an explicitly labelled tiny fixture.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {spawn,spawnSync} from 'node:child_process'
import {build} from 'esbuild'
import {cleanEnv,stopRun,writeRun,alive} from '../lib.mjs'
import {Proof} from '../proof.mjs'
export async function setup(){return {name:'core-recovery',fixture:'none'}}
export default async function(rig){
 const p=new Proof('core-recovery'),run=rig.refresh()
 const root=process.env.ORGTREE_CORE_RIG_STATE
 const expected=path.join(os.homedir(),'AppData','Local','orgtree-rig-core-agy')
 if(!root||path.resolve(root).toLowerCase()!==expected.toLowerCase()||fs.existsSync(root))throw Error('exact absent isolated state root required')
 writeRun(rig.dir,{busy:new Date().toISOString()});await stopRun(rig.dir,{keep:true});fs.cpSync(rig.data,root,{recursive:true})
 const bin=path.join(rig.dir,'bin','orgtree-engine.exe')
 const controller=path.join(process.env.ORGTREE_RECOVERY_OUTPUT,'recovery-desktop.cjs')
 await build({entryPoints:['tools/rig/recovery-desktop.ts'],bundle:true,platform:'node',format:'cjs',outfile:controller,logLevel:'silent'})
 p.file('provenance.json',{source:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),dirty:spawnSync('git',['status','--porcelain'],{encoding:'utf8'}).stdout.trim(),engine_sha256:crypto.createHash('sha256').update(fs.readFileSync(bin)).digest('hex'),controller_sha256:crypto.createHash('sha256').update(fs.readFileSync(controller)).digest('hex')})
 const env={...cleanEnv(),ORGTREE_ENGINE_SAFE_START:'1',ORGTREE_ENGINE_RIG:'1',ORGTREE_NET_OFFLINE:'1',ORGTREE_ENGINE_ALLOW_INITDB:'1',
 ORGTREE_P03_PG_BIN:run.pgBin,ORGTREE_CLAUDE_BIN:path.join(rig.dir,'bin','claude.exe'),ORGTREE_CODEX_BIN:path.join(rig.dir,'bin','codex.exe'),
 ORGTREE_AGY_BIN:path.join(rig.dir,'bin','agy.exe'),ORGTREE_TAILSCALE_BIN:path.join(rig.dir,'bin','tailscale.cmd'),
 ORGTREE_FAKECLI_DIR:rig.fakeDir,ORGTREE_FAKECLI_HOME:path.join(root,'rig-home')}
 const wait=async(fn,label,ms=90000)=>{const until=Date.now()+ms;while(Date.now()<until){try{const v=fn();if(v)return v}catch{}await new Promise(r=>setTimeout(r,150))}throw Error('Timed out: '+label)}
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8'))
 const state=()=>read(path.join(root,'core-lifecycle.json'))
 const children=[],pids=new Set();let desk,result,sessions
 const controllerStart=async(label,automatic=false)=>{
  result=path.join(p.dir,label+'.json');const config=path.join(p.dir,label+'-config.json')
  fs.writeFileSync(config,JSON.stringify({root,engine:bin,ui:run.ui,result}))
  const out=fs.openSync(path.join(p.dir,label+'.log'),'w')
  desk=spawn(process.execPath,[controller,config,...automatic?['--automatic']:[]],{env,windowsHide:true,stdio:['ignore',out,out]});fs.closeSync(out)
  children.push(desk);pids.add(desk.pid)
  const ready=await wait(()=>read(result),'controller ready')
  if(ready.error)throw Error(ready.error)
  if(!ready.ready)throw Error('controller not ready')
  pids.add(state().engine.pid);return ready
 }
 const quit=async()=>{const old=state().engine.pid;fs.writeFileSync(result+'.command','quit');await wait(()=>!alive(desk.pid),'desktop Quit');await wait(()=>!alive(old),'engine Quit');return read(result)}
 const native=(action,dir,pid)=>spawnSync(bin,['core-recovery',action,dir,String(pid)],{env,windowsHide:true,encoding:'utf8',timeout:10000})
 const stopReal=async()=>{try{const a=read(path.join(root,'engine-attach.json'));await fetch(`http://127.0.0.1:${a.port}/api/desktop/shutdown`,{method:'POST',headers:{'X-Orgtree-Desktop-Token':a.token},signal:AbortSignal.timeout(5000)})}catch{}}
 const nativeRoot=path.join(p.dir,'native-fixture');fs.mkdirSync(nativeRoot);fs.writeFileSync(path.join(nativeRoot,'.orgtree-rig-root'),'{}')
 try{
  await controllerStart('initial')
  let before=state();sessions=before.sessions;const firstDesktop=desk.pid,firstEngine=before.engine.pid
  p.check('managed engine publishes a verified attachment',read(path.join(root,'engine-attach.json')).managed===true)
  process.kill(firstEngine)
  const next=await wait(()=>{const s=state();return s.engine.pid!==firstEngine&&alive(s.engine.pid)&&read(result).enginePid===s.engine.pid?s:null},'replacement engine',120000)
  pids.add(next.engine.pid)
  await wait(()=>read(result).ready&&state().desktop?.pid===firstDesktop,'recovery registration')
  p.check('unexpected engine death preserves desktop PID',alive(firstDesktop)&&desk.pid===firstDesktop)
  p.check('replacement engine has a fresh stamped identity',next.engine.created!==before.engine.created)
  const survivor=next.engine.pid
  process.kill(firstDesktop);await wait(()=>!alive(firstDesktop),'old desktop exit');await new Promise(r=>setTimeout(r,6500))
  p.check('desktop death preserves the managed engine beyond prior cascade grace',alive(survivor))
  const attached=await controllerStart('reattached',true)
  p.check('replacement controller reattaches same engine',state().engine.pid===survivor&&state().desktop.pid===desk.pid)
  p.check('reattached managed topology is not called a boot task',attached.managed===false&&attached.background===false)
  p.check('manual Quit drains attached managed engine and exits desktop',(await quit()).quit!=='unverified')
  await controllerStart('quit-race')
  const last=state().engine.pid;process.kill(last)
  await quit()
  await new Promise(r=>setTimeout(r,6500))
  p.check('manual Quit during pending recovery does not resurrect engine',!alive(state().engine.pid)&&!alive(desk.pid))
  const retry=spawnSync(bin,['core-control','status',root],{env,windowsHide:true,encoding:'utf8',timeout:10000})
  p.check('native automatic status retains manual Quit barrier',retry.status===0&&JSON.parse(retry.stdout).stopped===true)

  await controllerStart('exhausted')
  const exhaustedEngine=state().engine.pid, exhaustedDesktop=desk.pid
  fs.writeFileSync(path.join(root,'core-recovery-engine-budget.json'),JSON.stringify([Date.now()-60000,Date.now()-60000,Date.now()-60000]))
  process.kill(exhaustedEngine)
  await new Promise(r=>setTimeout(r,9500))
  p.check('exhausted engine budget retains healthy desktop without replacement',alive(exhaustedDesktop)&&!alive(exhaustedEngine)&&state().engine.pid===exhaustedEngine)
  await quit()

  const fixture=process.env.ORGTREE_RECOVERY_FIXTURE
  const fakeEnv={...env,ORGTREE_RECOVERY_FIXTURE_ROOT:nativeRoot}
  const launch=label=>{const c=spawn(fixture,[label],{env:fakeEnv,windowsHide:true,stdio:'ignore'});children.push(c);pids.add(c.pid);return c}
  const stamped=pid=>{const a=spawnSync('powershell.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${pid}; @{pid=$p.Id;created=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8',timeout:10000});if(a.status!==0)throw Error('fixture stamp failed');return JSON.parse(a.stdout)}
  const e=launch('engine'),d=launch('desktop');await wait(()=>fs.existsSync(path.join(nativeRoot,'desktop.pid')),'native fixture start')
  let snap={generation:crypto.randomBytes(16).toString('hex'),engine:stamped(e.pid),desktop:stamped(d.pid),host:null,helper:null,sessions,transition_until:0,transition_desktop:null,installing:false,completion_requested:false}
  const save=()=>fs.writeFileSync(path.join(nativeRoot,'core-lifecycle.json'),JSON.stringify(snap))
  save()
  const arm=()=>spawnSync(bin,['core-recovery','arm',nativeRoot,String(snap.desktop.pid)],{env:fakeEnv,windowsHide:true,encoding:'utf8',timeout:10000})
  arm();arm()
  const watcher=await wait(()=>read(path.join(nativeRoot,'core-recovery-watcher.json')),'native watcher');pids.add(watcher[1].pid)
  process.kill(d.pid)
  const recovered=await wait(()=>Number(fs.readFileSync(path.join(nativeRoot,'recovered.pid'),'utf8')),'native desktop replacement',30000);pids.add(recovered)
  p.check('native watcher launches a replacement desktop while engine survives',recovered!==d.pid&&alive(recovered)&&alive(e.pid))
  const diagnostics=fs.readFileSync(path.join(nativeRoot,'diagnostics','core-exits.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse)
  p.check('native exit diagnostic records original desktop identity and exit code',diagnostics.some(x=>x.event==='native-desktop-exit'&&x.pid===d.pid&&Number.isInteger(x.exit_code)))
  p.check('duplicate arm observers admit one desktop launch',diagnostics.filter(x=>x.event==='desktop-recovery-launched').length===1)
  snap.desktop=stamped(recovered);save();arm()
  const nextWatcher=await wait(()=>{const w=read(path.join(nativeRoot,'core-recovery-watcher.json'));return w[0].pid===recovered?w:null},'replacement observer');pids.add(nextWatcher[1].pid)
  const stale=native('engine',nativeRoot,d.pid)
  p.check('stale desktop observer cannot admit engine recovery',stale.status===0&&JSON.parse(stale.stdout).admitted!==true)
  process.kill(e.pid);await wait(()=>!alive(e.pid),'fixture engine exit')
  snap.transition_until=Date.now()+180000;snap.transition_desktop=snap.desktop;save()
  const deferred=native('engine',nativeRoot,recovered)
  p.check('intentional transition suppresses engine recovery without killing survivor',deferred.status===0&&JSON.parse(deferred.stdout).admitted===false&&alive(recovered))
  snap.transition_until=0;snap.transition_desktop=null;save()
  const admitted=native('engine',nativeRoot,recovered),duplicate=native('engine',nativeRoot,recovered)
  p.check('native engine admission is once per failed generation',admitted.status===0&&JSON.parse(admitted.stdout).admitted===true&&duplicate.status===0&&JSON.parse(duplicate.stdout).admitted===false)
  const q=native('quit',nativeRoot,recovered)
  p.check('native Quit records cancellation before desktop exits',q.status===0&&JSON.parse(q.stdout).cancelled===true)
  process.kill(recovered);await wait(()=>!alive(nextWatcher[1].pid),'cancelled observer');await new Promise(r=>setTimeout(r,6000))
  p.check('manual Quit suppresses a native replacement launch',Number(fs.readFileSync(path.join(nativeRoot,'recovered.pid'),'utf8'))===recovered&&!alive(recovered))
  p.note('Actual Windows native processes and production Engine/CoreLifecycle paths. Native desktop executable is a tiny stand-in, not packaged Electron; no live app or sign-out. No provider calls or real agent work.')
 }catch(error){p.check('proof completed',false,{error:String(error.message)})}
 finally{
  if(desk&&alive(desk.pid)){try{fs.writeFileSync(result+'.command','quit');await wait(()=>!alive(desk.pid),'cleanup desktop',30000)}catch{desk.kill()}}
  await stopReal()
  fs.writeFileSync(path.join(nativeRoot,'fixture-stop'),'stop')
  try{const s=read(path.join(nativeRoot,'core-lifecycle.json'));fs.writeFileSync(path.join(nativeRoot,'core-manual-quit.json'),JSON.stringify(s.sessions))}catch{}
  for(const c of children){if(alive(c.pid))try{await wait(()=>!alive(c.pid),'fixture cleanup',10000)}catch{c.kill()}}
  try{await wait(()=>[...pids].every(pid=>!alive(pid)),'all owned processes stopped',30000)}catch(error){p.check('cleanup',false,{error:error.message})}
  p.file('owned-pids.json',[...pids]);p.check('all tracked rig processes stopped',[...pids].every(pid=>!alive(pid)))
  p.note('Trusted profile-state root left for caller native-PowerShell validated cleanup',{root})
 }
 console.log(JSON.stringify(p.summary()));if(!p.passed)throw Error('recovery proof failed; see receipt')
}
