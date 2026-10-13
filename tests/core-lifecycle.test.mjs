import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {buildSync} from 'esbuild'

const source=buildSync({entryPoints:['apps/desktop/main/core-lifecycle.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
function fixture({native={stopped:false}, nativeError=null, stderr='', bridgeResult=false}={}) {
  const calls=[], records=[], module={exports:{}}
  let stopped=0, now=1000
  vm.runInNewContext(source,{module,exports:module.exports,require:name=>{
    assert.equal(name,'node:child_process')
    return {execFile:(binary,args,options,done)=>{
      calls.push({binary,args,options})
      done(typeof nativeError === 'function' ? nativeError(args) : nativeError,
        JSON.stringify(typeof native === 'function' ? native(args) : native), stderr)
    }}
  },process:{pid:123},Date:{now:()=>now},setInterval:()=>({unref(){}}),clearInterval(){}})
  const bridge={core:async(...args)=>{calls.push({bridge:args});if(bridgeResult instanceof Error)throw bridgeResult;return bridgeResult}}
  const core=new module.exports.CoreLifecycle('engine.exe','rig-root',bridge,()=>({origin:'http://127.0.0.1:1234',token:'rig-only'}),()=>stopped++,
    failure=>records.push(failure))
  return {core,calls,records,stopped:()=>stopped,advance:ms=>{now+=ms}}
}
const failed=(fields)=>Object.assign(new Error('Command failed'),fields)
test('automatic login does not clear a stopped generation',async()=>{
  const f=fixture({native:{stopped:true}})
  assert.equal(await f.core.begin(true),true)
  assert.equal(f.calls[0].args[1],'status')
  assert.equal(f.calls.some(c=>c.args?.[1]==='begin'),false)
})
test('explicit launch asks native guard to release old generation',async()=>{
  const f=fixture()
  assert.equal(await f.core.begin(false),false)
  assert.deepEqual(Array.from(f.calls[0].args),['core-control','begin','rig-root'])
  assert.equal(f.calls[0].options.windowsHide,true)
})
test('explicit stopped journal ends desktop without another registration',async()=>{
  const f=fixture({native:{stopped:true}});await f.core.tick()
  assert.equal(f.stopped(),1);assert.equal(f.calls.length,1)
})
test('uncertain native probe does not become process death',async()=>{
  const f=fixture({nativeError:new Error('busy')});await f.core.tick()
  assert.equal(f.stopped(),0)
})
test('HTTP failure does not become process death',async()=>{
  const f=fixture({bridgeResult:new Error('timeout')});await f.core.tick()
  assert.equal(f.stopped(),0)
})
test('authenticated stop response ends a healthy-looking desktop',async()=>{
  const f=fixture({bridgeResult:true});await f.core.tick()
  assert.equal(f.stopped(),1)
})
test('install and completion use distinct authenticated actions',async()=>{
  const f=fixture();await f.core.transition(true);await f.core.complete()
  assert.deepEqual(f.calls.filter(c=>c.bridge).map(c=>c.bridge[2]),['install',undefined,'complete'])
})


test('known engine death recovers that component after native admission, keeping desktop alive',async()=>{
  const f=fixture({native:args=>args[0]==='core-recovery'?{admitted:true}:{generation:'a',engineGone:true}})
  let recovered=0
  f.core.configureRecovery(async()=>recovered++,false)
  await f.core.tick();assert.equal(recovered,0)
  f.advance(5000);await f.core.tick()
  assert.equal(recovered,1);assert.equal(f.stopped(),0)
  await f.core.tick();assert.equal(recovered,1)
})

test('low resources or exhausted native admission leave surviving desktop alive',async()=>{
  const f=fixture({native:args=>args[0]==='core-recovery'?{admitted:false}:{generation:'a',engineGone:true}})
  let recovered=0;f.core.configureRecovery(async()=>recovered++,false)
  await f.core.tick();f.advance(6000);await f.core.tick()
  f.advance(120000);await f.core.tick()
  assert.equal(recovered,0);assert.equal(f.stopped(),0)
})

test('manual Quit invalidates pending and later recovery ticks',async()=>{
  const f=fixture({native:args=>args[0]==='core-recovery'?{admitted:true}:{generation:'a',engineGone:true}})
  let recovered=0;f.core.configureRecovery(async()=>recovered++,false)
  await f.core.tick();await f.core.cancelRecovery();f.advance(10000);await f.core.tick()
  assert.equal(recovered,0)
  assert.equal(f.calls.some(c=>c.args?.[0]==='core-recovery'&&c.args?.[1]==='quit'),true)
})

test('intentional replacement does not compete with automatic engine recovery',async()=>{
  const f=fixture({native:{generation:'a',engineGone:true,transitioning:true}})
  let recovered=0;f.core.configureRecovery(async()=>recovered++,false)
  await f.core.tick();f.advance(200000);await f.core.tick()
  assert.equal(recovered,0);assert.equal(f.stopped(),0)
})


test('a host-replaced engine is reattached without admitting another launch',async()=>{
  let generation='old'
  const f=fixture({native:()=>({generation,engineGone:false})})
  const modes=[];f.core.configureRecovery(async allowSpawn=>modes.push(allowSpawn),false)
  await f.core.complete();generation='new'
  await f.core.tick();await f.core.tick()
  assert.deepEqual(modes,[false]);assert.equal(f.stopped(),0)
  assert.equal(f.calls.some(c=>c.args?.[1]==='engine'),false)
})

test('failed reattachment stays retryable without spending launch permission',async()=>{
  let generation='old';let attempts=0
  const f=fixture({native:()=>({generation,engineGone:false})})
  f.core.configureRecovery(async allowSpawn=>{assert.equal(allowSpawn,false);if(++attempts===1)throw Error('not ready')},false)
  await f.core.complete();generation='new'
  await f.core.tick();await f.core.tick();await f.core.tick()
  assert.equal(attempts,2);assert.equal(f.stopped(),0)
})

// A refused launch must say why afterwards (laptop incident 2026-10-13: the
// refusal's cause could not be recovered). The user's message is unchanged.
test('a refused launch records which members held it back, never raw stderr',async()=>{
  const line=JSON.stringify({refused:'members',message:'still stopping',path:'C:\\Users\\someone\\private',
    members:[{role:'engine',life:'alive'},{role:'helper',life:'unknown',stage:'open',os:5,note:'C:\\Users\\someone'}]})
  const f=fixture({nativeError:failed({code:1,killed:false,signal:null}),stderr:line+'\r\nmore text'})
  await assert.rejects(f.core.begin(false),/previous Orgtree session has not finished stopping/)
  // records come from the sandbox's realm: compare their JSON, as the log holds it
  assert.deepEqual(JSON.parse(JSON.stringify(f.records)),[{event:'core-control-failed',command:'core-control',action:'begin',ms:0,exit:1,errno:null,
    signal:null,timedOut:false,refusal:{refused:'members',members:[{role:'engine',life:'alive'},{role:'helper',life:'unknown',stage:'open',os:5}]}}])
  assert.doesNotMatch(JSON.stringify(f.records),/Users|someone|still stopping|more text/)
})
test('a refusal line outside the fixed shape keeps only how the command failed',async()=>{
  for(const stderr of ['The previous Orgtree session is still stopping.',JSON.stringify({refused:'members',members:[{role:'other',life:'alive'}]}),
    JSON.stringify({refused:'members',members:[{role:'engine',life:'unknown',stage:'open',os:'5'}]})]){
    const f=fixture({nativeError:failed({code:1}),stderr})
    await assert.rejects(f.core.begin(false))
    assert.equal(f.records[0].exit,1);assert.equal(f.records[0].refusal,null)
  }
})
test('a timed-out or unstartable lifecycle command records how it failed',async()=>{
  const slow=fixture({nativeError:failed({killed:true,signal:'SIGTERM',code:null})})
  await assert.rejects(slow.core.begin(false))
  assert.deepEqual([slow.records[0].timedOut,slow.records[0].signal,slow.records[0].exit],[true,'SIGTERM',null])
  const missing=fixture({nativeError:failed({code:'ENOENT'})})
  await missing.core.tick()
  assert.equal(missing.stopped(),0,'an uncertain status is still not process death')
  assert.deepEqual([missing.records[0].action,missing.records[0].errno,missing.records[0].exit],['status','ENOENT',null])
})
test('a repeating status failure is recorded at most once a minute',async()=>{
  const f=fixture({nativeError:failed({code:1})})
  await f.core.tick();await f.core.tick();assert.equal(f.records.length,1)
  f.advance(60000);await f.core.tick();assert.equal(f.records.length,2)
})
test('a failed recovery control is recorded and Quit stays retryable',async()=>{
  const f=fixture({nativeError:args=>args[0]==='core-recovery'?failed({code:1}):null})
  await assert.rejects(f.core.cancelRecovery(),/Native recovery control failed/)
  assert.deepEqual([f.records[0].command,f.records[0].action,f.records[0].exit],['core-recovery','quit',1])
  assert.equal(f.records.length,1)
})
