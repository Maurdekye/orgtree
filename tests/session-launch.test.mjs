import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {buildSync} from 'esbuild'
const require=createRequire(import.meta.url),module={exports:{}}
vm.runInNewContext(buildSync({entryPoints:['apps/desktop/main/sessionlaunch.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,
  {module,exports:module.exports,require,process,Buffer,URL,setTimeout,clearTimeout,console})
const {replaceWithSessionAdmin,inConsole,elevationScript}=module.exports
const here={session:7,console:7,ownsConsole:true,known:true,operatorSid:'fixture',elevated:false}

test('only a verified same-user console enables session launch',()=>{
  assert.equal(inConsole(here),true)
  for(const change of [{known:false},{session:0},{console:8},{console:null},{ownsConsole:false},{operatorSid:null},{session:1.5,console:1.5},{session:NaN,console:NaN}]) {
    assert.equal(inConsole({...here,...change}),false)
  }
})
test('UAC decline leaves stop and attachment untouched',async()=>{
  const calls=[]
  await assert.rejects(replaceWithSessionAdmin(async()=>{throw Error('declined')},async()=>calls.push('stop'),async()=>calls.push('attach')),/declined/)
  assert.deepEqual(calls,[])
})
test('ready launcher precedes stop; commit follows release, then attach',async()=>{
  const calls=[]
  await replaceWithSessionAdmin(async()=>{calls.push('prepare');return{commit:async()=>calls.push('commit'),cancel:async()=>calls.push('cancel')}},
    async()=>calls.push('stop'),async()=>calls.push('attach'))
  assert.deepEqual(calls,['prepare','stop','commit','attach','cancel'])
})
test('failed graceful stop cancels waiting host without committing or attaching',async()=>{
  const calls=[]
  await assert.rejects(replaceWithSessionAdmin(async()=>({commit:async()=>calls.push('commit'),cancel:async()=>calls.push('cancel')}),
    async()=>{throw Error('root held')},async()=>calls.push('attach')),/root held/)
  assert.deepEqual(calls,['cancel'])
})
test('failed commit is surfaced and cannot claim attachment succeeded',async()=>{
  const calls=[]
  await assert.rejects(replaceWithSessionAdmin(async()=>({commit:async()=>{throw Error('lost receipt')},cancel:async()=>calls.push('cancel')}),
    async()=>calls.push('stop'),async()=>calls.push('attach')),/lost receipt/)
  assert.deepEqual(calls,['stop','cancel'])
})
test('elevation starts only the native waiting host and returns after consent',()=>{
  const script=elevationScript("C:\\fixture's folder\\engine.exe",'C:\\fixture space\\request.json')
  assert.match(script,/session-launch prepare/)
  assert.match(script,/-Verb RunAs -WindowStyle Hidden -PassThru/)
  assert.match(script,/fixture''s folder/)
  assert.doesNotMatch(script,/-Wait|schtasks|RegisterTask|SetValue|shutdown/)
  assert.throws(()=>elevationScript('engine','bad"path'),/Invalid/)
})
