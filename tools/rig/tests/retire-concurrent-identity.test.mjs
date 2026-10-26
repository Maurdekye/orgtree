// Execute the complete actual proof with synthetic process tables and tool/SQL
// replies. No process inspection, signal, engine, database or provider is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {Rig} from '../lib.mjs'

const repo=fileURLToPath(new URL('../../../',import.meta.url)),file='tools/rig/proofs/retire-concurrent.mjs'
const source=(process.env.RETIRE_IDENTITY_PROOF_REF
  ?execFileSync('git',['show',process.env.RETIRE_IDENTITY_PROOF_REF+':'+file],{cwd:repo,encoding:'utf8'})
  :fs.readFileSync(path.join(repo,file),'utf8')).replaceAll('\r\n','\n')
const body=source.replace(/^import .*\n/gm,'').replaceAll('export async function','async function')
  .replaceAll('export function','function').replace('export default async function (rig)', 'return async function (rig)')
const load=new Function('Proof','alive','spawnSync','path','SEED_SETTLE_TIMEOUT',body)
const names=Array.from({length:22},(_,i)=>`w${String(i+1).padStart(2,'0')}`)
const dir='D:\\orgtree-work\\rig\\identity-control\\runs\\own'
const rows=names.map((node,i)=>({pid:100+i,born:String(639000000000000001n+BigInt(i)),
  exe:path.win32.join(dir,'bin',i%2?'codex.exe':'claude.exe')}))
const titles=[
  'at least 20 workers hold a warm CLI before the retires','all workers are live reports of boss',
  'every one of the 22 concurrent retires answered ok','the whole concurrent batch ended within 10 s',
  'all 22 workers are archived','boss holds nothing for its retired reports, and the replies freed exactly what it held',
  "every worker's retire ran to Ok in the engine",'the engine ran retires side by side (overlapping spans)',
  'every conflicted try was tried again, and none ran out of tries','every warm worker CLI exited after its retire',
]
const flush=()=>new Promise(resolve=>setImmediate(resolve))
async function run(t,{before=rows,after=[],queryError=false,postReply,aliveAfter=after.map(x=>x.pid)}={}){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:0})
  let retired=0,log='',done=false,error=null,checks=[],files={},queries=[]
  class Proof {
    note(){} keep(){} file(name,value){files[name]=structuredClone(value)}
    check(what,ok,detail){checks.push({what,ok:!!ok,detail});return !!ok}
    summary(){return {checks}}
  }
  const spawn=(_exe,args,options)=>{
    queries.push({args,options,retired})
    if(queryError&&retired)return {status:1,signal:null,stderr:'synthetic denied',stdout:''}
    return retired&&postReply?postReply:{status:0,signal:null,stdout:JSON.stringify(retired?after:before)}
  }
  const proof=load(Proof,pid=>retired?aliveAfter.includes(pid):rows.some(r=>r.pid===pid),spawn,path,120000)
  const rig={dir,org:'synthetic',engineLog:()=>log,
    sql:q=>q.includes('ended_at')?[]:q.includes("state='archived'")?names.map(name=>({name})):names.map(()=>({})),
    one:q=>q.includes('sum(seat')?{h:retired?0:22}:{id:1},
    async restart(){log='runtime: warming done warmed=22 candidates=22\n'+names.map((node,i)=>`INFO [2026-10-25 22:00:00.000000] agent:1/${node} runtime.claude: CLI started agent=1 pid=${100+i} ready`).join('\n')},
    async tool(_who,tool,{node}){if(tool==='orgtree_chart')return {text:'Credits: synthetic'};
      retired++;log+=`\nINFO [2026-10-25 22:00:01.000000] domain.ops.retire(actor=boss)\nINFO [2026-10-25 22:00:01.100000] domain.ops.retire(...) [100 ms] -> Ok({"node":"${node}"})`;
      return {ok:true,json:{freed:1},text:'ok'}},
    waitFor(fn,opts){return Rig.prototype.waitFor.call(this,fn,opts)},
  }
  proof(rig).then(()=>{done=true},e=>{error=e;done=true})
  await flush()
  while(!done&&Date.now()<=31000){t.mock.timers.tick(500);await flush()}
  const elapsed=Date.now();t.mock.timers.reset()
  assert(done,'bounded original wait');assert.equal(error,null)
  assert.deepEqual(checks.map(c=>c.what),titles)
  assert(checks.slice(0,9).every(c=>c.ok),'all other nine original checks pass')
  return {checks,files,queries,elapsed}
}
function verdict(result,pass){assert.equal(result.checks.at(-1).ok,pass);assert.equal(result.elapsed,pass?0:30000)}

test('all original ten checks pass when every captured CLI exits',async t=>{
  const r=await run(t);verdict(r,true)
  assert.deepEqual(r.files['cli-identities-before.json'].rows,rows)
  assert.deepEqual(r.files['cli-identities-after.json'].rows,[])
})
test('same PID with a different native creation tick is no longer the owned CLI',async t=>{
  // One 100ns tick is deliberately below Number precision at this magnitude.
  const other={...rows[4],born:String(BigInt(rows[4].born)+1n)}
  verdict(await run(t,{after:[other]}),true)
})
test('a genuinely living captured CLI still fails after the original thirty seconds',async t=>{
  verdict(await run(t,{after:[rows[4]]}),false)
})
test('a failed process query cannot impersonate an empty process table',async t=>{
  const r=await run(t,{queryError:true});verdict(r,false)
  assert.equal(r.checks.at(-1).detail[0].state,'unknown identity')
})
test('missing creation identity before retires stays unknown even after PID disappears',async t=>{
  verdict(await run(t,{before:rows.filter(r=>r.pid!==104)}),false)
})
test('foreign executable before retires cannot establish ownership',async t=>{
  verdict(await run(t,{before:rows.map(r=>r.pid===104?{...r,exe:'C:\\foreign\\claude.exe'}:r)}),false)
})
test('ambiguous and malformed native snapshots fail closed',async t=>{
  for(const stdout of ['', '{', '{}',JSON.stringify([rows[4],rows[4]]),JSON.stringify([{...rows[4],born:null}]),
    JSON.stringify([{...rows[4],born:Number(rows[4].born)}]),JSON.stringify([{...rows[4],exe:null}])])
    verdict(await run(t,{postReply:{status:0,signal:null,stdout}}),false)
})
test('native query timeout and signal fail closed',async t=>{
  for(const reply of [{status:null,signal:null,error:new Error('timed out'),stdout:''},
    {status:null,signal:'SIGTERM',stdout:''}])verdict(await run(t,{postReply:reply}),false)
})
test('same native creation identity with inconsistent executable remains unknown',async t=>{
  verdict(await run(t,{after:[{...rows[4],exe:'C:\\foreign\\claude.exe'}]}),false)
})
test('queries are bounded, hidden, restricted to captured PIDs and saved after success',async t=>{
  const r=await run(t);verdict(r,true)
  assert(r.queries.length>=2)
  for(const q of r.queries){assert.equal(q.options.windowsHide,true);assert.equal(q.options.timeout,5000);
    assert(q.args.includes('-NonInteractive'));assert(q.args.at(-1).includes('CreationDate.ToUniversalTime().Ticks.ToString()'));
    assert(q.args.at(-1).includes('ProcessId=104'));assert(q.args.at(-1).includes("$ErrorActionPreference='Stop'"))}
})
