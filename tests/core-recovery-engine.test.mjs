import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {buildSync} from 'esbuild'
const req=createRequire(import.meta.url)
const module={exports:{}}
vm.runInNewContext(buildSync({entryPoints:['apps/desktop/main/engine.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,
  {module,exports:module.exports,require:req,process,Buffer,URL,fetch,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,console})
const {Engine}=module.exports
const options={dataRoot:'unused-test-root',forbiddenRoot:'unused-forbidden',directory:'unused',python:'unused',uiDirectory:'unused'}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}

test('recovery adopts a supervisor replacement without spawning',async()=>{
  const e=new Engine();let spawned=0
  e.attach=async()=>true;e.start=async()=>spawned++
  await e.recoverUnexpected(options,false)
  assert.equal(spawned,0)
})
test('attachment-only recovery never falls back to spawn',async()=>{
  const e=new Engine();let spawned=0
  e.attach=async()=>false;e.start=async()=>spawned++
  await assert.rejects(e.recoverUnexpected(options,false),/not yet ready/)
  assert.equal(spawned,0)
})
test('unreleased root refuses recovery and retains a retryable failure',async()=>{
  const e=new Engine();let spawned=0
  e.attach=async()=>false;e.rootReleased=async()=>false;e.start=async()=>spawned++
  await assert.rejects(e.recoverUnexpected(options),/release its data root/)
  assert.equal(spawned,0);assert.equal(e.status.state,'unavailable')
})
test('Quit during an attachment check prevents the subsequent spawn path',async()=>{
  const e=new Engine(), gate=deferred();let released=0
  e.attach=()=>gate.promise;e.rootReleased=async()=>{released++;return true}
  const attempt=e.recoverUnexpected(options)
  e.cancelLaunches();gate.resolve(false);await attempt
  assert.equal(released,0)
})
test('Quit during root-release proof is checked again by actual start before spawn',async()=>{
  const e=new Engine(), gate=deferred(), entered=deferred()
  e.attach=async()=>false;e.rootReleased=()=>{entered.resolve();return gate.promise}
  const attempt=e.recoverUnexpected(options)
  await entered.promise;e.cancelLaunches();gate.resolve(true)
  await assert.rejects(attempt,/cancelled by Quit/)
  assert.equal(e.child,undefined)
})
test('reattached managed engine preserves topology and can explicitly restart',async()=>{
  const e=new Engine();e.managed=false;e.attachedManaged=true
  const calls=[];e.stopForQuit=async()=>{calls.push('drain');return 'stopped'}
  e.rootReleased=async()=>{calls.push('release');return true};e.start=async()=>{calls.push('start')}
  assert.equal(e.usesBackgroundTask,false)
  await e.restart(options)
  assert.deepEqual(calls,['drain','release','start'])
})
