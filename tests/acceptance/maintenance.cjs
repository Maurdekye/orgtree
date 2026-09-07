const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict')
const {app, BrowserWindow, dialog, powerMonitor} = require('electron')
const failureCase=process.env.ORGTREE_ACCEPTANCE_MAINTENANCE_FAILURE==='1'
let failurePassed=false
const root = fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT)
const target = fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP)
app.setAppPath(target)
app.setPath('userData',path.join(root,'profile'))
let idle = 0, ready = null, child, relaunch = false, finished = false, packagedCheck = false
const observations = [], checks = [], acks = () => fs.existsSync(path.join(root,'ack-observations.jsonl')) ? fs.readFileSync(path.join(root,'ack-observations.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
Object.defineProperty(app,'isPackaged',{get:()=>packagedCheck})
powerMonitor.getSystemIdleTime = () => {observations.push({kind:'idle',value:idle});return idle}
app.setLoginItemSettings = () => { throw Error('Acceptance must not register login') }
app.relaunch = () => {
  assert.ok(ready && process.pid !== ready.pid)
  const accepted = acks().find(a=>a.outcome==='execute' && a.accepted)
  assert.ok(accepted && !accepted.admissionOpen)
  if(failureCase){observations.push({kind:'native-execution-threw',id:accepted.id});throw Error('Controlled native restart failure')}
  relaunch = true
  checks.push({name:'native-relaunch-after-exact-ack',status:'PASS',electronPid:process.pid,enginePid:ready.pid,id:accepted.id})
  finish()
}
const originalSpawn = cp.spawn
cp.spawn = function(command,args,options) {
  if (args?.some(a=>String(a).endsWith('launch.py'))) {
    assert.equal(fs.realpathSync.native(options.env.ORGTREE_DATA),fs.realpathSync.native(path.join(root,'data')))
    args=[path.join(__dirname,'maintenance_engine.py'),...args.slice(1)]
  }
  const processChild = originalSpawn.call(this,command,args,options)
  child = processChild
  processChild.stderr?.on('data',b=>fs.appendFileSync(path.join(root,'private-engine.log'),b))
  let buffer=''
  processChild.stdout?.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const row=JSON.parse(line);if(row.type==='ready')ready=row}catch{}}})
  return processChild
}
dialog.showMessageBox = async (...args) => {if(args.at(-1).type==='error' && !(failureCase && args.at(-1).message==='Orgtree maintenance did not complete.')){checks.push({name:'native-dialog',status:'FAIL'});finish()}return {response:0}}
function finish(error) {
  if(finished)return
  finished=true;clearTimeout(deadline)
  if(error)checks.push({name:'runtime',status:'FAIL',reason:error.message})
  fs.writeFileSync(path.join(root,'maintenance.json'),JSON.stringify({status:(relaunch || failurePassed) && checks.every(c=>c.status==='PASS')?'PASS':'FAIL',checks,observations,ready,acks:acks(),childPids:child?[child.pid]:[],limits:['OS idle clock controlled','Update check returns current version','Relaunch captured; no second Electron instance or real installer executed','Synthetic scoped actor, no provider turn']},null,2))
  app.quit()
}
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await pause(200)}throw Error('Bounded condition did not occur')}
const deadline=setTimeout(()=>finish(Error('Maintenance deadline')),65000)
app.on('browser-window-created',(_event,main)=>main.webContents.once('did-finish-load',async()=>{
  try {
    assert.ok(ready && ready.port!==7360)
    assert.equal(fs.realpathSync.native(ready.dataRootId),fs.realpathSync.native(path.join(root,'data')))
    const origin=new URL(main.webContents.getURL()).origin
    const token=fs.readFileSync(path.join(root,'private-agent-token'),'utf8')
    const call=async(tool,node='planner')=>{
      const response=await fetch(origin+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json','X-Orgtree-Agent-Token':token},body:JSON.stringify({org:'acceptance-runtime',node,tool,args:{target:'org'}})})
      return {status:response.status,body:await response.json()}
    }
    const operator=await fetch(origin+'/api/desktop/status',{headers:{'X-Orgtree-Agent-Token':token}})
    assert.equal(operator.status,401)
    assert.ok([401,403].includes((await call('orgtree_chart','builder')).status))
    assert.equal((await call('orgtree_chart')).status,200)
    checks.push({name:'scoped-actor-positive-and-forgery-controls',status:'PASS',port:ready.port})
    const update=await call('orgtree_self_update')
    assert.equal(update.status,200);assert.equal(update.body.armed,true)
    await pause(5500)
    assert.equal(acks().filter(a=>a.accepted).length,0)
    checks.push({name:'OS-active-prevents-ack',status:'PASS'})
    // Only after startup: emulate package update availability without changing
    // resource paths, login registration or engine execution.
    packagedCheck=true;idle=120
    await until(()=>acks().some(a=>a.outcome==='up-to-date' && a.accepted))
    const current=acks().find(a=>a.outcome==='up-to-date' && a.accepted)
    assert.equal(current.id,update.body.maintenance.id);assert.equal(current.admissionOpen,true)
    assert.equal((await call('orgtree_chart')).status,200)
    checks.push({name:'up-to-date-keeps-engine-and-admission-open',status:'PASS'})
    idle=0
    const restart=await call('orgtree_self_restart')
    assert.equal(restart.status,200);assert.equal(restart.body.armed,true)
    const wrong=await main.webContents.executeJavaScript(`fetch('/api/desktop/maintenance/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'wrong-id',outcome:'execute'})}).then(r=>r.json())`)
    assert.equal(wrong.accepted,false)
    checks.push({name:'wrong-maintenance-id-refused',status:'PASS'})
    idle=120
    // The real five-second index.ts poll now owns exact acknowledgment and quit.
    if(failureCase){
      await until(()=>JSON.parse(fs.readFileSync(path.join(root,'data/desktop-maintenance.json'),'utf8')).state==='failed')
      const failure=JSON.parse(fs.readFileSync(path.join(root,'data/desktop-maintenance.json'),'utf8'))
      assert.equal(failure.id,restart.body.maintenance.id)
      const records=fs.readFileSync(path.join(root,'failure-observations.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
      assert.ok(records.some(r=>r.id===failure.id && r.released && r.admissionOpen))
      assert.equal((await call('orgtree_chart')).status,200)
      await pause(5500)
      assert.equal(observations.filter(o=>o.kind==='native-execution-threw').length,1,'Uncertain native execution must never be retried')
      const native=JSON.parse(fs.readFileSync(path.join(root,'profile/maintenance-failures.json'),'utf8'))
      assert.equal(native.automaticBlocked,true);assert.deepEqual(native.pending,[])
      failurePassed=true;checks.push({name:'native-failure-records-exact-id-releases-hold-and-no-retry',status:'PASS'});finish()
    }
  } catch(error){finish(error)}
}))
const Module = require('node:module')
const bundle = path.join(target,'dist/main/index.cjs')
const source = fs.readFileSync(bundle,'utf8')
assert.ok(source.includes('import_electron_updater.autoUpdater.checkForUpdates()'), 'Built updater binding positive control')
const compiled = new Module(bundle,module)
compiled.filename=bundle;compiled.paths=Module._nodeModulePaths(path.dirname(bundle))
// Observe the actual bundled updater instance; requiring the external package
// creates a different instance and cannot control this compiled application.
compiled._compile(source+'\nmodule.exports.__acceptanceUpdater=import_electron_updater.autoUpdater;',bundle)
const updater=compiled.exports.__acceptanceUpdater
updater.checkForUpdates=async()=>{observations.push({kind:'update-check'});return {updateInfo:{version:app.getVersion()}}}
updater.quitAndInstall=()=>{throw Error('Acceptance forbids update installation')}

