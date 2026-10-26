// Complete actual proof, synthetic publication/SQL/tool payloads, virtual clock.
// No engine, process, database, provider or window is started.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {Rig} from '../lib.mjs'
const repo=fileURLToPath(new URL('../../../',import.meta.url)),file='tools/rig/proofs/turn-start-clock.mjs'
const source=(process.env.TURN_CLOCK_PROOF_REF?execFileSync('git',['show',process.env.TURN_CLOCK_PROOF_REF+':'+file],{cwd:repo,encoding:'utf8'}):fs.readFileSync(path.join(repo,file),'utf8')).replaceAll('\r\n','\n')
const body=source.replace(/^import .*\n/gm,'').replace('export default async function (rig)','return async function (rig)')
const load=new Function('Proof','SEED_SETTLE_TIMEOUT',body)
const titles=['idle: neither the node nor the chat payload names a running turn','running: the node and the chat payload name the same turn start',"running: the turn's call started at or after it","it is this turn's admission: after the mail was sent, within 2 s of the turn row's start",'the call ran and the turn ended well (control)','after the turn: neither names a running turn again']
const flush=()=>new Promise(resolve=>setImmediate(resolve))
async function run(t,opts={}){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
  let phase='initial',start=null,done=false,error=null,checks=[],files={},waits=[],mailedAt
  class Proof{check(what,ok,detail){checks.push({what,ok:!!ok,detail})}file(name,value){files[name]=structuredClone(value)}keep(){}summary(){return{checks}}}
  const proof=load(Proof,120000),old='2026-10-25T23:43:16.869Z'
  const initialNode=()=>({id:'alice',busy:Date.now()<(opts.nodeAt??0),starting:Date.now()<(opts.startingAt??0),turn_started_at:opts.staleClock||Date.now()<(opts.nodeAt??0)?old:null})
  const initialChat=()=>({busy:Date.now()<(opts.chatAt??0),turn_started_at:Date.now()<(opts.chatAt??0)?old:null,messages:[]})
  const rig={org:'synthetic',scenario(){},sql:()=>[],
    one(){if(opts.rowError)throw Error('synthetic SQL unavailable');if(opts.missingRow)return null;
      return {inflight_at:Date.now()<(opts.inflightAt??0)?old:null,unfinished:Date.now()<(opts.ledgerAt??0)}},
    async api(_method,url){const chat=url.endsWith('/chat');let v
      if(phase==='initial')v=chat?(opts.missingChat?null:initialChat()):(opts.missingNode?null:initialNode())
      else if(phase==='running'){const stamp=chat?start:opts.runningMismatch?'1970-01-01T00:00:20.000Z':start;
        v={id:'alice',busy:true,starting:false,turn_started_at:stamp,messages:[{tools:[{arg:'sleep 6',started_at:opts.chipBefore?'1969-12-31T23:59:59.000Z':start}]}]}}
      else v={id:'alice',busy:false,starting:false,turn_started_at:opts.finalClock?old:null,messages:[{tools:[{arg:'sleep 6',result:opts.badControl?'wrong':'slept'}]}]}
      return chat?v:{roots:[{id:'parent',children:v?[v]:[]}]}
    },
    turns:()=>phase==='initial'?[{ended_at:'seed done'}]:[{started_at:opts.badAdmission?'1969-12-31T23:00:00.000Z':start,ended_at:phase==='ended'?'done':null,error:null,killed:false}],
    async userMail(who,text){assert.equal(who,'alice');assert.match(text,/PROOF-TURN-START/);mailedAt=Date.now();start=new Date(mailedAt).toISOString();phase='running'},
    async waitTurns(){phase='ended'},
    waitFor(fn,options){waits.push(options);return Rig.prototype.waitFor.call(this,fn,options)},
  }
  proof(rig).then(()=>{done=true},e=>{error=e;done=true});await flush()
  while(!done&&Date.now()<=10200){t.mock.timers.tick(200);await flush()}
  const elapsed=Date.now();t.mock.timers.reset();assert(done,'bounded initial-idle wait');assert.equal(error,null);assert.deepEqual(checks.map(c=>c.what),titles)
  return{checks,files,waits,mailedAt,elapsed}
}
const allPass=r=>assert(r.checks.every(c=>c.ok),JSON.stringify(r.checks))
function initialFails(r){assert.equal(r.checks[0].ok,false);assert(r.checks.slice(1).every(c=>c.ok));assert.equal(r.mailedAt,10000);assert.equal(r.files['initial-idle-state.json'].ready,false)}
test('late node publication after the ended seed ledger reaches the original six passes',async t=>{
  const r=await run(t,{nodeAt:600});allPass(r);assert.equal(r.mailedAt,600);assert(r.files['initial-idle-state.json'].samples.length>=4)
})
test('published idle completes promptly and saves independent state',async t=>{
  const r=await run(t);allPass(r);assert.equal(r.mailedAt,0);assert.equal(r.files['initial-idle-state.json'].ready,true)
})
test('starting, chat busy, inflight and unfinished-ledger signals each gate sampling',async t=>{
  for(const signal of ['startingAt','chatAt','inflightAt','ledgerAt']){const r=await run(t,{[signal]:400});allPass(r);assert.equal(r.mailedAt,400)}
})
test('missing node, chat or agent row fails closed at the bounded deadline',async t=>{
  for(const missing of ['missingNode','missingChat','missingRow'])initialFails(await run(t,{[missing]:true}))
})
test('unavailable SQL state fails closed instead of assuming idle',async t=>{
  initialFails(await run(t,{rowError:true}))
})
test('a permanently busy publication cannot pass by eventually reading null clocks',async t=>{
  initialFails(await run(t,{startingAt:20000}))
})
test('a real stale clock on an otherwise idle node still fails immediately',async t=>{
  const r=await run(t,{staleClock:true});assert.equal(r.checks[0].ok,false);assert.equal(r.mailedAt,0)
  assert.equal(r.checks[0].detail.node,'2026-10-25T23:43:16.869Z');assert(r.checks.slice(1).every(c=>c.ok))
})
test('all original running, admission, control and final-idle negatives remain effective',async t=>{
  for(const [option,index]of [['runningMismatch',1],['chipBefore',2],['badAdmission',3],['badControl',4],['finalClock',5]]){
    const r=await run(t,{[option]:true});assert.equal(r.checks[0].ok,true);assert.equal(r.checks[index].ok,false,option)
  }
})
