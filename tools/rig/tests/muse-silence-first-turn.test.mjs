// Actual first-scenario wait block and Rig wait methods; no engine or provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {Rig} from '../lib.mjs'

const repo=fileURLToPath(new URL('../../../',import.meta.url)),file='tools/rig/proofs/muse-tool-silence.mjs'
const source=(process.env.MUSE_SILENCE_PROOF_REF
  ?execFileSync('git',['show',process.env.MUSE_SILENCE_PROOF_REF+':'+file],{cwd:repo,encoding:'utf8'})
  :fs.readFileSync(path.join(repo,file),'utf8')).replaceAll('\r\n','\n')
const start=source.includes('    // The first scenario turns')?source.indexOf('    // The first scenario turns'):source.indexOf("    for (const name of ['tia'")
const end=source.indexOf('    // ---------------------------------------------------------------- tia',start)
assert(start>=0&&end>start)
const execute=new(Object.getPrototypeOf(async function(){}).constructor)('rig','p',source.slice(start,end))
const names=['tia','sol','tom','ida','bea'],ended=[{id:1,ended_at:'done'}]
const flush=()=>new Promise(resolve=>setImmediate(resolve))
async function run(t,{turns=()=>ended}={}){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
  const seen={checks:[],files:[],waits:[]},rig={
    turns:name=>turns(name,Date.now()),
    waitFor(fn,opts){return Rig.prototype.waitFor.call(this,fn,opts)},
    waitTurns(name,count,opts){seen.waits.push({name,count,opts,at:Date.now()});return Rig.prototype.waitTurns.call(this,name,count,opts)}}
  const p={check:(what,ok,detail)=>seen.checks.push({what,ok,detail}),file:(name,value)=>seen.files.push({name,value})}
  let done=false,error=null
  execute(rig,p).then(()=>{done=true},e=>{error=e;done=true})
  await flush()
  while(!done&&Date.now()<=120000){t.mock.timers.tick(500);await flush()}
  assert(done,'the batch remains bounded')
  const result={...seen,error,elapsed:Date.now()}
  t.mock.timers.reset()
  return result
}
function passed(seen,elapsed){assert.equal(seen.error,null);assert.equal(seen.elapsed,elapsed);assert.equal(seen.checks.length,0);assert.deepEqual(seen.waits.map(w=>w.name),names);assert(seen.waits.every(w=>w.count===1))}
function failed(seen,waitingFor='tia'){assert(seen.error);assert.equal(seen.elapsed,120000);assert.equal(seen.files.length,0);assert.equal(seen.checks.length,1);assert.equal(seen.checks[0].ok,false);assert.equal(seen.checks[0].what,'Muse silence scenarios finish within helper grace and execution allowance');assert.equal(seen.checks[0].detail.waitingFor,waitingFor)}

test('helper grace plus four-second tool silence can complete after the old deadline',async t=>{
  passed(await run(t,{turns:(_name,now)=>now<64000?[{id:1,ended_at:null}]:ended}),64000)
})
test('already ended scenarios complete immediately without a fixed delay',async t=>{
  passed(await run(t),0)
})
test('prompt staggered completions preserve all five original wait targets',async t=>{
  const finishedAt={tia:500,sol:4500,tom:8000,ida:8000,bea:4500}
  passed(await run(t,{turns:(name,now)=>now<finishedAt[name]?[{id:1,ended_at:null}]:ended}),8000)
})
test('a later batch member can use only the remaining shared allowance',async t=>{
  const seen=await run(t,{turns:(name,now)=>name==='sol'&&now<119500?[]:ended})
  passed(seen,119500)
  assert.equal(seen.waits.at(-1).opts.timeout,500)
})
test('later missing members cannot reset the overall two-minute bound',async t=>{
  const seen=await run(t,{turns:(name,now)=>name==='tia'?(now<119000?[]:ended):[]})
  failed(seen,'sol')
  assert.equal(seen.waits[1].opts.timeout,1000)
})
test('missing turns and unfinished turns retain named failure at the deadline',async t=>{
  for(const rows of [[],[{id:1,ended_at:null}], [...ended,{id:2,ended_at:null}]])
    failed(await run(t,{turns:()=>rows}))
})
test('unreadable turn state fails within the same finite budget',async t=>{
  failed(await run(t,{turns:()=>{throw new Error('synthetic SQL refusal')}}))
})
test('successful batch retains every completed turn before functional checks',async t=>{
  const seen=await run(t)
  passed(seen,0)
  assert.equal(seen.files.length,1);assert.equal(seen.files[0].name,'first-turns.json')
  assert.deepEqual(seen.files[0].value,{elapsedMs:0,turns:Object.fromEntries(names.map(name=>[name,ended]))})
})
