const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict')
const {app,BrowserWindow,dialog,powerMonitor}=require('electron')
const root=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT),target=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP)
const journal=path.join(root,'relaunch-cycles.jsonl')
const previous=fs.existsSync(journal)?fs.readFileSync(journal,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
const boot=previous.filter(r=>r.kind==='ready').length+1
assert.ok(boot<=3,'Bounded to two real relaunches')
app.setAppPath(target);app.setPath('userData',path.join(root,'profile'))
powerMonitor.getSystemIdleTime=()=>120
let ready,child,finished=false,finalResult
const record=row=>fs.appendFileSync(journal,JSON.stringify({boot,...row})+'\n')
const spawn=cp.spawn
cp.spawn=function(command,args,options){
  if(args?.some(a=>String(a).endsWith('launch.py'))){
    assert.equal(fs.realpathSync.native(options.env.ORGTREE_DATA),fs.realpathSync.native(path.join(root,'data')))
    args=[path.join(__dirname,'maintenance_engine.py'),...args.slice(1)]
  }
  const c=spawn.call(this,command,args,options);child=c
  c.stderr?.on('data',b=>fs.appendFileSync(path.join(root,`private-engine-${boot}.log`),b))
  let buffer='';c.stdout?.on('data',b=>{buffer+=b;while(buffer.includes('\n')){let at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const row=JSON.parse(line);if(row.type==='ready')ready=row}catch{}}})
  return c
}
function finish(error){if(finished)return;finished=true;clearTimeout(deadline);finalResult={status:error?'FAIL':'PASS',reason:error?.message,boot};app.quit()}
dialog.showMessageBox=async(...args)=>{if(args.at(-1).type==='error')finish(Error('Native error dialog'));return {response:0}}
app.on('will-quit',()=>{
  record({kind:'quit',electronPid:process.pid,engineExitCode:child?.exitCode})
  if(finalResult)fs.writeFileSync(path.join(root,'relaunch-final.json'),JSON.stringify(finalResult))
})
const deadline=setTimeout(()=>finish(Error('Relaunch boot deadline')),45000)
app.on('browser-window-created',(_event,main)=>main.webContents.once('did-finish-load',async()=>{
  try{
    assert.ok(ready && ready.port!==7360)
    assert.equal(fs.realpathSync.native(ready.dataRootId),fs.realpathSync.native(path.join(root,'data')))
    const origin=new URL(main.webContents.getURL()).origin
    const status=await main.webContents.executeJavaScript(`fetch('/api/desktop/status').then(r=>r.json())`)
    assert.equal(status.idle,true)
    if(boot>1){
      assert.equal(status.maintenance_outcome.state,'unknown')
      assert.equal(status.maintenance,null)
      assert.ok(previous.filter(r=>r.kind==='ready').every(r=>r.enginePid!==ready.pid && r.electronPid!==process.pid && r.port===ready.port))
    }
    record({kind:'ready',electronPid:process.pid,enginePid:ready.pid,guardianPid:ready.guardianPid,port:ready.port,dataRoot:ready.dataRootId,priorOutcome:status.maintenance_outcome?.state||null})
    const token=fs.readFileSync(path.join(root,'private-agent-token'),'utf8')
    const call=async(tool,args={})=>{const r=await fetch(origin+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json','X-Orgtree-Agent-Token':token},body:JSON.stringify({org:'acceptance-runtime',node:'planner',tool,args})});assert.equal(r.status,200);return r.json()}
    await call('orgtree_chart')
    const request=await call('orgtree_self_restart',{target:'org'})
    assert.equal(request.armed,true);assert.ok(!request.already_armed)
    record({kind:'fresh-request',id:request.maintenance.id})
    if(boot===3){assert.equal((await call('orgtree_prime_restart',{action:'cancel'})).cancelled,true);finish()}
    // Boots one and two use unmodified app.relaunch + quit in production main.
  }catch(error){finish(error)}
}))
require(path.join(target,'dist/main/index.cjs'))
