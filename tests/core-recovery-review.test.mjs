import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import {buildSync} from 'esbuild'
const require=createRequire(import.meta.url)
const options={dataRoot:path.resolve('unused-recovery-review-root'),forbiddenRoot:path.resolve('unused-forbidden-root'),directory:'unused',python:'unused',uiDirectory:'unused'}
function source(file) {
 const base=process.env.CORE_RECOVERY_REVIEW_BASE
 return base?execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8',windowsHide:true}):fs.readFileSync(file,'utf8')
}
function load(name,native) {
 const module={exports:{}}
 const code=buildSync({stdin:{contents:source(`apps/desktop/main/${name}.ts`),loader:'ts',resolveDir:path.resolve('apps/desktop/main')},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text
 vm.runInNewContext(code,{module,exports:module.exports,require:id=>id==='node:child_process'&&native?{execFile:(_b,args,_o,cb)=>cb(null,JSON.stringify(native(args)))}:require(id),process,Error,Buffer,URL,fetch,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,console})
 return module.exports
}
const {Engine}=load('engine'),{CredentialBridge}=load('credential-bridge')
for(const admitted of [false,true])test(`boot recovery real first attach guard, admission ${admitted}`,async()=>{
 const e=new Engine();e.managed=false;e.attachedManaged=false;e.rootReleased=async()=>false
 let tasks=0
 await assert.rejects(e.recoverUnexpected(options,admitted,async()=>tasks++),admitted?/release its data root/:/not yet ready to attach/)
 assert.equal(tasks,0);assert.equal(e.usesBackgroundTask,true)
})
test('post-task recovery executes real attachWithRetry and retains boot topology on timeout',async()=>{
 const e=new Engine();e.managed=false;e.attachedManaged=false;e.rootReleased=async()=>true
 e.attachWithRetry=opts=>Engine.prototype.attachWithRetry.call(e,opts,0)
 let tasks=0
 await assert.rejects(e.recoverUnexpected(options,true,async()=>tasks++),/did not become ready/)
 assert.equal(tasks,1);assert.equal(e.usesBackgroundTask,true)
})
const index=source('apps/desktop/main/index.ts')
const handler=index.slice(index.indexOf('  const restartEngine = async () => {'),index.indexOf('  const rebuildTray = () => {'))
async function tray({native,withCore=true,healthy=false,cancel=false,blocked=false}) {
 const e=new Engine();let starts=0,transitions=0,tasks=0
 e.stop=async()=>{};e.stoppedConfirmed=async()=>true;e.rootReleased=async()=>true;e.start=async()=>{starts++}
 const bridge=new CredentialBridge()
 if(healthy)bridge.core=async()=>{transitions++;return false}
 const {CoreLifecycle}=load('core-lifecycle',()=>native)
 const core=withCore?new CoreLifecycle('unused','unused',bridge,()=>({origin:e.origin,token:e.token}),()=>{}):undefined
 if(core){
  core.complete=async()=>{}
  core.configureRecovery(allow=>e.recoverUnexpected(options,allow,async()=>tasks++),false)
  if(cancel)await core.cancelRecovery()
 }
 const messages=[]
 const context={engine:e,coreLifecycle:core,engineRestartOptions:options,engineRestartBlocked:()=>blocked,resumeEngineStartup:undefined,
 startBootTask:async()=>tasks++,refreshTrayEngine:()=>{},rebuildTray:()=>{},dialog:{showMessageBox:async value=>messages.push(value)},Error}
 vm.createContext(context);vm.runInContext(handler+';globalThis.invokeRestart=restartEngine',context);await context.invokeRestart()
 return {starts,transitions,tasks,messages}
}
test('actual tray/core/bridge recovers initialized dead managed engine without dead HTTP transition',async()=>{
 const r=await tray({native:{generation:'dead',engineGone:true,stopped:false}})
 assert.equal(r.starts,1);assert.equal(r.messages.length,0)
})
test('healthy manual restart retains authenticated transition',async()=>{
 const r=await tray({native:{generation:'alive',engineGone:false},healthy:true})
 assert.equal(r.starts,1);assert.equal(r.transitions,1);assert.equal(r.messages.length,0)
})
test('unknown native state does not bypass an unavailable endpoint',async()=>{
 const r=await tray({native:{generation:'unknown'}})
 assert.equal(r.starts,0);assert.equal(r.messages.length,1)
})
test('manual Quit cancellation and stopped journal prohibit manual recovery',async()=>{
 for(const cancel of [false,true]){
  const r=await tray({native:{generation:'dead',engineGone:true,stopped:!cancel,cancelled:true},cancel})
  assert.equal(r.starts,0);assert.equal(r.messages.length,1)
 }
})
test('intentional transition and UI shutdown block manual dead-engine recovery',async()=>{
 for(const blocked of [false,true]){
  const r=await tray({native:{generation:'dead',engineGone:true,transitioning:true},blocked})
  assert.equal(r.starts,0)
 }
})
test('non-core manual restart still uses existing Engine.restart',async()=>{
 const r=await tray({withCore:false,native:{}})
 assert.equal(r.starts,1);assert.equal(r.messages.length,0)
})

function manualCore() {
 const {CoreLifecycle}=load('core-lifecycle',()=>({}))
 return new CoreLifecycle('unused','unused',new CredentialBridge(),()=>({origin:'',token:''}),()=>{})
}
test('Quit during native proof cancels the pending manual retry',async()=>{
 const core=manualCore();let resolve,starts=0
 core.native=()=>new Promise(r=>{resolve=r})
 core.configureRecovery(async()=>{starts++},false)
 const attempt=core.restart(async()=>{starts++})
 await core.cancelRecovery()
 resolve({generation:'dead',engineGone:true})
 await assert.rejects(attempt,/cancelled/);assert.equal(starts,0)
})
test('manual retry serializes duplicate clicks and automatic ticks without resetting their budget',async()=>{
 const core=manualCore();let resolve,starts=0,probes=0
 core.native=async()=>{probes++;return {generation:'dead',engineGone:true}}
 core.failure={generation:'dead',since:1,attempted:true}
 core.configureRecovery(async()=>{starts++;await new Promise(r=>{resolve=r})},false)
 const attempt=core.restart(async()=>assert.fail('dead engine must use recovery'))
 await Promise.resolve()
 await assert.rejects(core.restart(async()=>{starts++}),/already running/)
 await core.tick();assert.equal(probes,1);assert.equal(starts,1)
 resolve();await attempt
 assert.equal(core.failure.attempted,true);assert.equal(core.busy,false)
})
test('Quit during healthy transition prevents the later restart',async()=>{
 const core=manualCore();let resolve,entered,starts=0
 const transitionStarted=new Promise(r=>{entered=r})
 core.native=async()=>({generation:'alive',engineGone:false})
 core.transition=()=>new Promise(r=>{resolve=r;entered()})
 const attempt=core.restart(async()=>{starts++})
 await transitionStarted;await core.cancelRecovery();resolve()
 await assert.rejects(attempt,/cancelled/);assert.equal(starts,0)
})
