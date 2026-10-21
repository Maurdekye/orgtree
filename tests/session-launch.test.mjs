// The desktop's routing for the background engine (docket
// after-an-update-or-engine-restart-while-the-user). Fakes only: no task,
// UAC prompt, registry or engine is reached.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {buildSync} from 'esbuild'
const require=createRequire(import.meta.url),module={exports:{}}
vm.runInNewContext(buildSync({entryPoints:['apps/desktop/main/sessionlaunch.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,
  {module,exports:module.exports,require,process,Buffer,URL,setTimeout,clearTimeout,console})
const {inConsole,route,parseAttempt,failureMessage,startInSession,runSessionAsAdmin,elevationScript,lastFailure}=module.exports
const here={session:7,console:7,ownsConsole:true,known:true,operatorSid:'fixture',elevated:false}
const scratch=()=>fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-session-launch-test-'))
const record=(fields)=>JSON.stringify({id:'a'.repeat(32),phase:'ready',by:'desktop',owner:{pid:1,created:'1'},session:7,admin:false,stopped_old:true,
  at_ms:Date.now(),epoch:[],error:null,rollback:null,reported:null,...fields})

test('only a verified same-user console enables session launch',()=>{
  assert.equal(inConsole(here),true)
  for(const change of [{known:false},{session:0},{console:8},{console:null},{ownsConsole:false},{operatorSid:null},{session:1.5,console:1.5},{session:NaN,console:NaN}]) {
    assert.equal(inConsole({...here,...change}),false)
  }
})

test('starts go to the user-session task at the console, else the boot task, else this desktop',()=>{
  const all={boot:true,helper:true,interactive:false}
  assert.equal(route(all,here),'session','a demand-enabled task whose sign-in trigger is off still serves restarts')
  assert.equal(route({...all,boot:false},here),'session','Run on boot off: the task still starts the engine in this session')
  assert.equal(route(all,{...here,console:8}),'boot','not at the console: the boot host decides')
  assert.equal(route({...all,interactive:null},here),'boot','an installation without the user-session task')
  assert.equal(route({...all,interactive:undefined},here),'boot','an older reading without it')
  assert.equal(route({...all,boot:false,interactive:null},here),'managed','Run on boot off and no task: this desktop starts its own')
  assert.equal(route(null,here),'managed','no installer tasks at all (per-user, development)')
  assert.equal(route(all,null),'boot','an unverifiable session never routes into it')
})

test('the attempt record is read in fixed words and its failures say what runs now',()=>{
  assert.equal(parseAttempt('not json'),null)
  assert.equal(parseAttempt(record({phase:'gone'})),null)
  const failed=parseAttempt(record({phase:'failed',error:'the engine in the signed-in session did not become ready',rollback:'done'}))
  assert.equal(failed.phase,'failed'); assert.equal(failed.rollback,'done'); assert.equal(failed.stoppedOld,true)
  assert.match(failureMessage(failed),/did not become ready\), so it started the engine in Session 0 instead\./)
  assert.match(failureMessage({...failed,rollback:'failed'}),/did not start in Session 0 either\. Use Start engine in the tray/)
  assert.match(failureMessage({...failed,rollback:null,stoppedOld:false,error:'the running engine refused the handover'}),/refused the handover\)\. The running engine is unchanged\./)
  assert.match(failureMessage({...failed,rollback:null}),/It is starting the engine in Session 0 instead\./)
})

const tasks=()=>{const calls=[];return {calls,runner:async(file,args)=>{calls.push([file,...args]);return {code:0,stdout:'',stderr:''}}}}

test('a restart asks for a restart, runs the user-session task and waits for its own answer',async()=>{
  const root=scratch(),t=tasks()
  const done=startInSession(root,true,20000,t.runner)
  await new Promise(r=>setTimeout(r,300))
  const ask=JSON.parse(fs.readFileSync(path.join(root,'session-launch-request.json'),'utf8'))
  assert.deepEqual({by:ask.by,restart:ask.restart},{by:'desktop',restart:true})
  assert.deepEqual(t.calls,[['schtasks','/Run','/TN','Orgtree User Session Engine']])
  // an older attempt's answer is not this restart's
  fs.writeFileSync(path.join(root,'core-handover.json'),record({at_ms:ask.atMs-60000}))
  await new Promise(r=>setTimeout(r,800))
  let settled=false; done.then(()=>{settled=true},()=>{settled=true})
  await new Promise(r=>setTimeout(r,50)); assert.equal(settled,false,'it waits for its own attempt')
  fs.writeFileSync(path.join(root,'core-handover.json'),record({at_ms:ask.atMs+10}))
  await done
  fs.rmSync(root,{recursive:true,force:true})
})

test('a restart whose launcher failed throws what happened; a start leaves the waiting to attach',async()=>{
  const root=scratch(),t=tasks()
  const done=startInSession(root,true,20000,t.runner)
  await new Promise(r=>setTimeout(r,300))
  fs.writeFileSync(path.join(root,'core-handover.json'),record({phase:'failed',error:'the running engine refused the handover',stopped_old:false}))
  await assert.rejects(done,/refused the handover\)\. The running engine is unchanged\./)
  assert.match(await lastFailure(root,Date.now()-5000),/refused the handover/,'the start path names the same failure')
  assert.equal(await lastFailure(root,Date.now()+60000),null,'only a failure since the start counts')
  const start=tasks(),began=Date.now()
  await startInSession(root,false,20000,start.runner)
  assert.ok(Date.now()-began<2000,'a start returns once the task runs; the caller attaches to whichever engine comes up')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'session-launch-request.json'),'utf8')).restart,false)
  fs.rmSync(root,{recursive:true,force:true})
})

test('run this session as admin: a declined prompt changes nothing',async()=>{
  const root=scratch()
  const calls=[]
  const runner=async(file,args)=>{
    calls.push(file)
    if(args[0]==='session-launch') return {code:0,stdout:JSON.stringify({...here,parent:{pid:process.pid,created:'9'}}),stderr:''}
    return {code:1223,stdout:'',stderr:''}
  }
  const options={binary:path.join(root,'orgtree-engine.exe'),dataRoot:root,forbiddenRoot:path.join(os.tmpdir(),'orgtree-forbidden'),uiDirectory:root}
  await assert.rejects(runSessionAsAdmin(options,runner),/Windows did not give permission; the running engine is unchanged\./)
  assert.equal(calls.length,2,'only the session check and the one prompt')
  fs.rmSync(root,{recursive:true,force:true})
})

test('run this session as admin: the elevated launcher is checked, then its own outcome decides',async()=>{
  for (const outcome of ['done','refused']) {
    const root=scratch()
    const runner=async(file,args)=>{
      if(args[0]==='session-launch') return {code:0,stdout:JSON.stringify({...here,parent:{pid:process.pid,created:'9'}}),stderr:''}
      // the prompt: find the request the elevated launcher would read, answer as it would
      const script=Buffer.from(args[args.indexOf('-EncodedCommand')+1],'base64').toString('utf16le')
      assert.match(script,/session-launch prepare/)
      const file=/prepare "([^"]+)"/.exec(script)[1], dir=path.dirname(file)
      const request=JSON.parse(fs.readFileSync(file,'utf8'))
      assert.equal(request.admin,true); assert.equal(request.dataRoot,root)
      setTimeout(()=>{
        fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({nonce:request.nonce,identity:{pid:4242},session:7,admin:true}))
        setTimeout(()=>fs.writeFileSync(path.join(dir,outcome==='done'?'done.json':'error.json'),
          JSON.stringify(outcome==='done'?{enginePid:5}:{error:'the running engine refused the handover',stoppedOld:false})),200)
      },200)
      return {code:0,stdout:'4242\r\n',stderr:''}
    }
    const options={binary:path.join(root,'orgtree-engine.exe'),dataRoot:root,forbiddenRoot:path.join(os.tmpdir(),'orgtree-forbidden'),uiDirectory:root}
    if (outcome==='done') await runSessionAsAdmin(options,runner)
    else await assert.rejects(runSessionAsAdmin(options,runner),/not restarted as administrator: the running engine refused the handover\. The running engine is unchanged\./)
    fs.rmSync(root,{recursive:true,force:true})
  }
})

test('elevation starts only the native launcher and returns after consent',()=>{
  const script=elevationScript("C:\\fixture's folder\\engine.exe",'C:\\fixture space\\request.json')
  assert.match(script,/session-launch prepare/)
  assert.match(script,/-Verb RunAs -WindowStyle Hidden -PassThru/)
  assert.match(script,/fixture''s folder/)
  assert.doesNotMatch(script,/-Wait|schtasks|RegisterTask|SetValue|shutdown/)
  assert.throws(()=>elevationScript('engine','bad"path'),/Invalid/)
})
