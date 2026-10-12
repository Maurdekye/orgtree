import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
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

test('background recovery keeps the configured task and never spawns a managed engine',async()=>{
  const e=new Engine();e.managed=false;e.attachedManaged=false
  const calls=[];e.attach=async()=>false;e.rootReleased=async()=>true
  e.start=async()=>calls.push('managed');e.attachWithRetry=async()=>{calls.push('attach');return true}
  await e.recoverUnexpected(options,true,async()=>calls.push('task'))
  assert.deepEqual(calls,['task','attach']);assert.equal(e.managed,false)
})
test('Quit during task restart suppresses subsequent attachment',async()=>{
  const e=new Engine();e.managed=false;e.attachedManaged=false
  const gate=deferred(), entered=deferred();let attached=0
  e.attach=async()=>false;e.rootReleased=async()=>true;e.attachWithRetry=async()=>{attached++;return true}
  const attempt=e.recoverUnexpected(options,true,async()=>{entered.resolve();await gate.promise})
  await entered.promise;e.cancelLaunches();gate.resolve();await attempt
  assert.equal(attached,0)
})
test('update path keeps bounded transition instead of manual Quit barrier',()=>{
  const source=fs.readFileSync('apps/desktop/main/index.ts','utf8')
  const start=source.indexOf('await coreLifecycle?.transition(true)',source.indexOf('const applyDownloadedUpdate ='))
  const finish=source.indexOf('const outcome = await prepareAndHandOff',start)
  assert.ok(start>0&&finish>start)
  const body=source.slice(start,finish)
  assert.equal(body.includes('cancelRecovery()'),false)
  assert.doesNotMatch(body,/^\s*app\.quit\(\)/m)
  assert.equal(body.includes('engine.cancelLaunches()'),true)
})
