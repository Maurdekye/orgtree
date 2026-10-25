// Execute the proof's real removal block and Rig.waitFor with synthetic states.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {Rig} from '../lib.mjs'

const repo=fileURLToPath(new URL('../../../',import.meta.url)),file='tools/rig/proofs/codex-accounts.mjs'
const source=(process.env.CODEX_REMOVAL_PROOF_REF
  ?execFileSync('git',['show',process.env.CODEX_REMOVAL_PROOF_REF+':'+file],{cwd:repo,encoding:'utf8'})
  :fs.readFileSync(path.join(repo,file),'utf8')).replaceAll('\r\n','\n')
const start=source.includes('  const removalSeats =')?source.indexOf('  const removalSeats ='):source.indexOf('  const removed =')
const end=source.indexOf("\n  p.note('removing B'",start)
assert(start>=0&&end>start)
const execute=new(Object.getPrototypeOf(async function(){}).constructor)('rig','p','B',source.slice(start,end)+'\nreturn removed')
const names=['mia','ned','ola'],ids={mia:5,ned:7,ola:8}
const base=name=>({id:name,ord:ids[name],state:'live',busy:false,inflight_at:null})
const flush=()=>new Promise(resolve=>setImmediate(resolve))
const refusal=process.env.CODEX_REMOVAL_PACKET
  ?JSON.parse(fs.readFileSync(process.env.CODEX_REMOVAL_PACKET,'utf8')).deletionResponses.candidate.parsed.error
  :'DELETE /api/accounts/openai-1 → 409: mia is running a turn and requires a session boundary; removal succeeds once that turn ends'

async function run(t,{detail=(name)=>base(name),turns=()=>[{ended_at:'ended'}],identity=name=>ids[name],deny=false}={}){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
  const seen={checks:[],files:[],deletes:[],reads:0},rig={org:'rig-org',agentRow:name=>({id:identity(name)}),turns:name=>turns(name,Date.now()),
    waitFor(fn,options){return Rig.prototype.waitFor.call(this,fn,options)},
    async api(method,url){
      if(method==='GET'){seen.reads++;return detail(url.split('/').at(-2),Date.now())}
      assert.equal(method,'DELETE');assert.equal(url,'/api/accounts/openai-1');seen.deletes.push(Date.now())
      const busy=names.some(name=>{const d=detail(name,Date.now());return d.busy!==false||d.inflight_at!==null||turns(name,Date.now()).some(row=>!row.ended_at)})
      if(deny||busy)throw new Error(refusal)
      return{removed:'openai-1'}
    }}
  const p={check:(what,ok,detail)=>seen.checks.push({what,ok,detail}),file:(name,value)=>seen.files.push({name,value})}
  let done=false,result,error=null
  execute(rig,p,'openai-1').then(r=>{result=r;done=true},e=>{error=e;done=true})
  await flush()
  while(!done&&Date.now()<=30000){t.mock.timers.tick(500);await flush()}
  assert(done,'the actual boundary wait terminates within its bound')
  const value={...seen,result,error,elapsed:Date.now()}
  t.mock.timers.reset()
  return value
}
function succeeded(seen,at){assert.equal(seen.error,null);assert.equal(seen.result?.removed,'openai-1');assert.deepEqual(seen.deletes,[at]);assert.equal(seen.checks.length,0)}
function blocked(seen){assert(seen.error);assert.deepEqual(seen.deletes,[]);assert.equal(seen.elapsed,30000);assert.equal(seen.checks.length,1);assert.equal(seen.checks[0].what,'B removal: bound seats reach published idle before DELETE');assert.equal(seen.checks[0].ok,false)}

test('ledger-ended mia must reach published idle before the single DELETE',async t=>{
  succeeded(await run(t,{detail:(name,now)=>({...base(name),busy:name==='mia'&&now<500})}),500)
})
test('ned must also reach the boundary while mia is already idle',async t=>{
  succeeded(await run(t,{detail:(name,now)=>({...base(name),busy:name==='ned'&&now<500})}),500)
})
test('ola inflight clearance is required even after idle publication',async t=>{
  succeeded(await run(t,{detail:(name,now)=>({...base(name),inflight_at:name==='ola'&&now<500?'claimed':null})}),500)
})
test('an unfinished ledger row blocks otherwise idle bound seats',async t=>{
  succeeded(await run(t,{turns:(name,now)=>[{ended_at:name==='ned'&&now<500?null:'ended'}]}),500)
})
test('already settled bound seats remove once without a fixed delay',async t=>{
  succeeded(await run(t),0)
})
test('missing, replaced or malformed seat identity never admits DELETE',async t=>{
  for(const mutate of [d=>({...d,ord:99}),d=>({...d,id:'other'}),d=>({...d,state:'retired'}),d=>({...d,busy:undefined}),d=>({...d,inflight_at:undefined})]){
    blocked(await run(t,{detail:name=>name==='ned'?mutate(base(name)):base(name)}))
  }
  blocked(await run(t,{identity:name=>name==='ned'?undefined:ids[name]}))
})
test('unreadable runtime state reaches a real deadline and records failure before DELETE',async t=>{
  blocked(await run(t,{detail:()=>{throw new Error('synthetic detail unavailable')}}))
})
test('a lawful DELETE409 is retained without any mutation retry',async t=>{
  const seen=await run(t,{deny:true})
  assert.equal(seen.error,null);assert.equal(seen.result.error,refusal);assert.deepEqual(seen.deletes,[0])
})
