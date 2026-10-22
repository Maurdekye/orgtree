import {Proof} from '../proof.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
function ownedInput(value, owner) {
 if(!value||!path.isAbsolute(value))throw Error('explicit absolute owned boundary input required')
 const file=path.resolve(value),base=path.resolve('C:/orgtree-build',owner),relative=path.relative(base,file)
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('boundary input outside owned build scope')
 for(let at=file;;at=path.dirname(at)){
  if(fs.lstatSync(at).isSymbolicLink())throw Error('boundary input symlink/junction refused')
  if(path.dirname(at)===at)break
 }
 if(fs.realpathSync(file).toLowerCase()!==file.toLowerCase())throw Error('boundary input canonical path mismatch')
 return file
}
export async function setup(){return {fixture:{org:{name:'Claim boundary'},agents:[{name:'boss',tier:'sol',grant:100}]}}}
export default async function(rig){
 const filter=process.env.ORGTREE_BOUNDARY_FILTER||'claim_boundary_stale_reclaim'
 const p=new Proof(filter==='all-boundaries'?'project-all-boundaries':filter.startsWith('watch_')?'project-watch-boundary':'project-claim-boundary')
 const owner=process.env.ORGTREE_AGENT
 if(!owner||!/^[A-Za-z0-9_-]{1,64}$/.test(owner))throw Error('explicit boundary owner required')
 const native=ownedInput(process.env.ORGTREE_BOUNDARY_NATIVE_EXE,owner),output=ownedInput(process.env.ORGTREE_CLAIM_TEST_OUTPUT,owner)
 if(!fs.statSync(native).isFile()||!/^orgtree_engine-[a-f0-9]+\.exe$/.test(path.basename(native))||!fs.statSync(output).isDirectory())throw Error('native executable and output directory required')
 const {port,password}=rig.pgConn()
 const env={...process.env,ORGTREE_CLAIM_TEST_OUTPUT:output,ORGTREE_CLAIM_TEST_URL:`host=127.0.0.1 port=${port} user=orgtree_admin password=${password} dbname=orgtree_engine`,ORGTREE_CLAIM_TEST_ROOT:rig.dir,ORGTREE_CLAIM_TEST_ORG:String(rig.one(`SELECT org_id FROM ot.agents WHERE name='boss'`).org_id)}
 if(filter.startsWith('upgrade_')||filter==='all-boundaries'){
  const list=spawnSync('git',['ls-tree','--name-only','v4.3.3:engine/rs/orgtree-engine/migrations'],{encoding:'utf8',windowsHide:true});if(list.status!==0)throw Error('missing local v4.3.3 migration source')
  const entries=list.stdout.trim().split(/\r?\n/).filter(n=>n.endsWith('.sql')).map(n=>{const r=spawnSync('git',['show',`v4.3.3:engine/rs/orgtree-engine/migrations/${n}`],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('cannot read baseline migration');return{name:n.replace(/\.sql$/,''),sql:r.stdout}})
  env.ORGTREE_V433_MIGRATIONS=path.join(output,'v433-upgrade-migrations.json');fs.writeFileSync(env.ORGTREE_V433_MIGRATIONS,JSON.stringify(entries),{flag:'wx'})
 }
 const guards=spawnSync(native,['domain::native_fixture::rejects_invalid_inputs','--ignored','--exact','--nocapture','--test-threads=1'],{env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024**2})
 p.file('guards.log',(guards.stdout||'')+(guards.stderr||''));p.file('guards-exit.json',{status:guards.status,signal:guards.signal,error:guards.error?.message})
 p.check('portable fixture refuses absent, foreign, live and non-disposable inputs',guards.status===0&&!guards.signal&&!guards.error&&guards.stdout.includes('1 passed; 0 failed; 0 ignored'))
 if(guards.status!==0||guards.signal||guards.error)return p.summary()
 const selected=filter==='all-boundaries'?'boundary_':filter.startsWith('watch_')?'::watch_boundary_restart_after_edge_commit':filter.startsWith('event_')?'::event_boundary_continues_same_event_after_page_commit':filter.startsWith('upgrade_')?'::upgrade_boundary_v433_to_0050':filter
 const result=spawnSync(native,[selected,'--ignored','--nocapture','--test-threads=1'],{env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024**2})
 p.file('native.log',(result.stdout||'')+(result.stderr||''));p.file('exit.json',{status:result.status,signal:result.signal,error:result.error?.message})
 const expected=filter==='all-boundaries'?7:filter==='recovery_boundary_'?2:null
 p.check(filter,result.status===0&&result.signal===null&&!result.error&&(!expected||result.stdout.includes(`${expected} passed; 0 failed; 0 ignored`)),{status:result.status,signal:result.signal,expected})
 return p.summary()
}
