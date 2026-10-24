// Execute the proof's actual wait closure with deterministic DB/publication order.
// No engine, provider or database. The optional ref is for a predecessor red control.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'

const repo=fileURLToPath(new URL('../../../',import.meta.url))
const file='tools/rig/proofs/muse-r4-removal.mjs'
const source=(process.env.MUSE_REMOVAL_PROOF_REF
 ? execFileSync('git',['show',process.env.MUSE_REMOVAL_PROOF_REF+':'+file],{cwd:repo,encoding:'utf8'})
 : fs.readFileSync(path.join(repo,file),'utf8')).replaceAll('\r\n','\n')
const start=source.indexOf("  await interrupt('z2')",source.indexOf('const X16 ='))
const end=source.indexOf('  const again = await del(X16)',start)
assert(start>=0&&end>start,'isolate the exact wait between interrupt and second DELETE')
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
const wait=new AsyncFunction('rig','interrupt','row','p',"const z2Id=row('z2').id;\n"+source.slice(start,end))
const idle={id:'z2',ord:20,state:'live',busy:false,inflight_at:null}

function fixture(states){
 const seen={index:-1,api:[],sql:[],files:[],checks:[],interrupts:[]}
 const rig={org:'synthetic-muse',
  api:async(method,route)=>{assert.equal(method,'GET');assert.equal(route,'/api/orgs/synthetic-muse/nodes/z2/detail');seen.api.push(route);return states[seen.index].detail},
  sql:sql=>{assert.match(sql,/a\.name = 'z2'.*t\.ended_at IS NULL/);seen.sql.push(sql);return states[seen.index].open?[{id:42}]:[]},
  waitFor:async(fn,options)=>{
   assert.equal(options.timeout,30000);seen.options=options
   for(let i=0;i<states.length;i++){seen.index=i;if(await fn())return await fn()}
   throw new Error('bounded idle wait timed out')
  },
 }
 const interrupt=async name=>{assert.equal(name,'z2');seen.interrupts.push(name)}
 const row=name=>{assert.equal(name,'z2');return {id:20}}
 const p={file:(name,value)=>seen.files.push({name,value}),check:(what,ok,detail)=>seen.checks.push({what,ok,detail})}
 return {seen,run:()=>wait(rig,interrupt,row,p)}
}

test('DB completion alone cannot release the after-turn removal while runtime is busy',async()=>{
 const f=fixture([{open:false,detail:{...idle,busy:true}},{open:false,detail:idle}])
 await f.run();assert.equal(f.seen.index,1,'must observe published idle after the DB is already ended')
 assert.deepEqual(f.seen.interrupts,['z2']);assert.equal(f.seen.files[0]?.value.busy,false)
})

test('published idle still requires the existing DB completion guard',async()=>{
 const f=fixture([{open:true,detail:idle},{open:false,detail:idle}])
 await f.run();assert.equal(f.seen.index,1);assert.equal(f.seen.files[0]?.value.ended,true)
})

test('a wrong name, replacement identity or retired seat cannot satisfy idle',async()=>{
 const f=fixture([
  {open:false,detail:{...idle,id:'other'}},
  {open:false,detail:{...idle,ord:21}},
  {open:false,detail:{...idle,state:'retired'}},
  {open:false,detail:idle},
 ])
 await f.run();assert.equal(f.seen.index,3);assert.equal(f.seen.files[0]?.value.ord,20)
})

test('an uncleared inflight marker prevents release despite busy false',async()=>{
 const f=fixture([{open:false,detail:{...idle,inflight_at:'still finishing'}},{open:false,detail:idle}])
 await f.run();assert.equal(f.seen.index,1)
})

test('missing publication or a perpetually busy runtime times out with a durable failure',async()=>{
 for(const detail of [null,{}, {...idle,busy:undefined}, {...idle,inflight_at:undefined}, {...idle,busy:true}]){
  const f=fixture([{open:false,detail}])
  await assert.rejects(f.run(),/bounded idle wait timed out/)
  assert.equal(f.seen.options.timeout,30000);assert.equal(f.seen.files.length,0)
  assert.equal(f.seen.checks.length,1);assert.equal(f.seen.checks[0].ok,false)
  assert.match(f.seen.checks[0].what,/published runtime idle/)
 }
})
