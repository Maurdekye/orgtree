import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {buildSync} from 'esbuild'

const source=buildSync({entryPoints:['apps/desktop/main/core-lifecycle.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
function fixture({native={stopped:false}, nativeError=null, bridgeResult=false}={}) {
  const calls=[], module={exports:{}}
  let stopped=0
  vm.runInNewContext(source,{module,exports:module.exports,require:name=>{
    assert.equal(name,'node:child_process')
    return {execFile:(binary,args,options,done)=>{
      calls.push({binary,args,options})
      done(nativeError,JSON.stringify(native))
    }}
  },setInterval:()=>({unref(){}}),clearInterval(){}})
  const bridge={core:async(...args)=>{calls.push({bridge:args});if(bridgeResult instanceof Error)throw bridgeResult;return bridgeResult}}
  const core=new module.exports.CoreLifecycle('engine.exe','rig-root',bridge,()=>({origin:'http://127.0.0.1:1234',token:'rig-only'}),()=>stopped++)
  return {core,calls,stopped:()=>stopped}
}
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
test('native death evidence stops without sending another registration',async()=>{
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
