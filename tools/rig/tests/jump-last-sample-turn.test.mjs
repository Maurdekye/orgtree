// Replay the actual setup block with relational fixture rows and Rig.waitFor.
// No engine, PostgreSQL or desktop is started by these virtual-clock controls.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
import {Rig} from '../lib.mjs'

const repo=fileURLToPath(new URL('../../../',import.meta.url)),file='tools/rig/proofs/jump-last-sent.mjs'
const source=(process.env.JUMP_LAST_SAMPLE_PROOF_REF
  ?execFileSync('git',['show',process.env.JUMP_LAST_SAMPLE_PROOF_REF+':'+file],{cwd:repo,encoding:'utf8'})
  :fs.readFileSync(path.join(repo,file),'utf8')).replaceAll('\r\n','\n')
const start=source.includes('  // An ended seed')?source.indexOf('  // An ended seed'):source.indexOf('  await rig.userMail(')
const end=source.indexOf('  const evidence =',start)
assert(start>=0&&end>start)
const execute=new(Object.getPrototypeOf(async function(){}).constructor)('rig','p',source.slice(start,end))
const flush=()=>new Promise(resolve=>setImmediate(resolve))
const uid="sample'uid",org="sample'org"
const finished=(extra={})=>({id:20,agent_id:7,ended_at:'done',killed:false,error:null,...extra})
const mail=(extra={})=>({uid,org_id:3,recipient_agent_id:7,state:'delivered',turn_id:20,...extra})

async function run(t,{receipt={accepted:true,id:uid},mails=()=>[mail()],turns=()=>[finished()],globalBusy=()=>false,sqlError=false,sendError=false}={}){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
  const seen={checks:[],files:[],sends:[],queries:[]}
  const rig={org,
    async userMail(name,text){seen.sends.push({name,text,at:Date.now()});if(sendError)throw new Error('synthetic send refusal');return receipt},
    turns(){return[{id:10,agent_id:7,ended_at:'seed'},...turns(Date.now())]},
    sql(query){assert.equal(query,'SELECT 1 FROM ot.turns WHERE ended_at IS NULL');if(sqlError)throw new Error('synthetic SQL refusal');return globalBusy(Date.now())?[{one:1}]:[]},
    one(query){
      seen.queries.push(query)
      if(sqlError)throw new Error('synthetic SQL refusal')
      assert.match(query,/a\.id = m\.recipient_agent_id/)
      assert.match(query,/o\.id = a\.org_id AND m\.org_id = o\.id/)
      assert.match(query,/LEFT JOIN ot\.turns t ON t\.id = m\.turn_id AND t\.agent_id = a\.id/)
      const where=query.match(/WHERE o\.slug = '((?:[^']|'')*)' AND a\.name = '([^']*)' AND m\.uid = '((?:[^']|'')*)'/)
      assert(where,'query keeps all three identity predicates')
      const selectedOrg=where[1].replaceAll("''","'"),name=where[2],selectedUid=where[3].replaceAll("''","'")
      const m=mails(Date.now()).find(m=>m.uid===selectedUid&&m.org_id===3&&m.recipient_agent_id===7&&selectedOrg===org&&name==='rhea')
      if(!m)return null
      const row=turns(Date.now()).find(t=>t.id===m.turn_id&&t.agent_id===7)
      return{uid:m.uid,state:m.state,turn_id:m.turn_id,ended_at:row?.ended_at??null,killed:row?.killed??null,error:row?.error??null}
    },
    waitFor(fn,opts){return Rig.prototype.waitFor.call(this,fn,opts)}}
  const p={check:(what,ok,detail)=>seen.checks.push({what,ok,detail}),file:(name,value)=>seen.files.push({name,value})}
  let done=false,error=null
  execute(rig,p).then(()=>{done=true},e=>{error=e;done=true})
  await flush()
  while(!done&&Date.now()<=120000){t.mock.timers.tick(500);await flush()}
  assert(done,'setup terminates within its finite deadline')
  const result={...seen,error,elapsed:Date.now()}
  t.mock.timers.reset()
  return result
}
function admitted(seen,at){assert.equal(seen.error,null);assert.equal(seen.elapsed,at);assert.equal(seen.checks.length,0);assert.equal(seen.sends.length,1)}
function blocked(seen,at=120000){assert(seen.error);assert.equal(seen.elapsed,at);assert.equal(seen.sends.length,1);assert.equal(seen.files.length,0);assert.equal(seen.checks.length,1);assert.equal(seen.checks[0].what,'sample mail reaches its own completed turn before the desktop opens');assert.equal(seen.checks[0].ok,false)}

test('an ended seed cannot admit a queued sample mail',async t=>{
  const seen=await run(t,{mails:now=>[mail(now<500?{state:'pending',turn_id:null}:{})]})
  admitted(seen,500)
  assert.equal(seen.files[0].name,'sample-turn.json')
  assert.equal(seen.files[0].value.receipt.id,uid)
  assert.equal(seen.files[0].value.turn.turn_id,20)
})
test('the delivered sample own turn must finish, rather than the prior seed',async t=>{
  admitted(await run(t,{turns:now=>[finished({ended_at:now<1000?null:'done'})]}),1000)
})
test('a sample after helper grace can finish within the bounded execution allowance',async t=>{
  admitted(await run(t,{mails:now=>now<65000?[]:[mail()]}),65000)
})
test('an already completed sample admits immediately without a fixed sleep',async t=>{
  admitted(await run(t),0)
})
test('an unrelated unfinished turn cannot block this completed sample',async t=>{
  admitted(await run(t,{globalBusy:()=>true}),0)
})
test('foreign UID, org, recipient and turn owner cannot replace the sample',async t=>{
  for(const extra of [{uid:'old-seed'},{org_id:4},{recipient_agent_id:8},{turn_id:10}])
    blocked(await run(t,{mails:()=>[mail(extra)]}))
  blocked(await run(t,{turns:()=>[finished({agent_id:8})]}))
})
test('missing receipt and send refusal record setup failure before desktop admission',async t=>{
  for(const receipt of [null,{accepted:false,id:uid},{accepted:true,id:20},{accepted:true,id:''}])
    blocked(await run(t,{receipt}),0)
  blocked(await run(t,{sendError:true}),0)
})
test('pending, failed or killed sample and unreadable SQL reach a named bounded failure',async t=>{
  blocked(await run(t,{mails:()=>[mail({state:'delivering'})]}))
  for(const extra of [{error:'synthetic failure'},{killed:true}])
    blocked(await run(t,{turns:()=>[finished(extra)]}))
  blocked(await run(t,{sqlError:true}))
})
