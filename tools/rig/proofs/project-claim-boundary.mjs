import {Proof} from '../proof.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
export async function setup(){return {fixture:{org:{name:'Claim boundary'},agents:[{name:'boss',tier:'sol',grant:100}]}}}
export default async function(rig){
 const filter=process.env.ORGTREE_BOUNDARY_FILTER||'claim_boundary_stale_reclaim'
 const p=new Proof(filter==='all-boundaries'?'project-all-boundaries':filter.startsWith('watch_')?'project-watch-boundary':'project-claim-boundary'),deps='C:/orgtree-build/taskbar-orgs-sol/watchdog-uncap-target/debug/deps'
 const exes=fs.readdirSync(deps).filter(n=>/^orgtree_engine-[a-f0-9]+\.exe$/.test(n)).map(n=>path.join(deps,n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)
 if(!exes.length)throw Error('compile focused native test first')
 const {port,password}=rig.pgConn()
 const env={...process.env,ORGTREE_CLAIM_TEST_URL:`host=127.0.0.1 port=${port} user=orgtree_admin password=${password} dbname=orgtree_engine`,ORGTREE_CLAIM_TEST_ROOT:rig.dir.replaceAll('\\','/'),ORGTREE_CLAIM_TEST_ORG:String(rig.one(`SELECT org_id FROM ot.agents WHERE name='boss'`).org_id)}
 if(filter.startsWith('upgrade_')||filter==='all-boundaries'){
  const list=spawnSync('git',['ls-tree','--name-only','v4.3.3:engine/rs/orgtree-engine/migrations'],{encoding:'utf8',windowsHide:true});if(list.status!==0)throw Error('missing local v4.3.3 migration source')
  const entries=list.stdout.trim().split(/\r?\n/).filter(n=>n.endsWith('.sql')).map(n=>{const r=spawnSync('git',['show',`v4.3.3:engine/rs/orgtree-engine/migrations/${n}`],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('cannot read baseline migration');return{name:n.replace(/\.sql$/,''),sql:r.stdout}})
  env.ORGTREE_V433_MIGRATIONS='C:/orgtree-build/taskbar-orgs-sol/v433-upgrade-migrations.json';fs.writeFileSync(env.ORGTREE_V433_MIGRATIONS,JSON.stringify(entries))
 }
 const selected=filter==='all-boundaries'?'boundary_':filter.startsWith('watch_')?'::watch_boundary_restart_after_edge_commit':filter.startsWith('event_')?'::event_boundary_continues_same_event_after_page_commit':filter.startsWith('upgrade_')?'::upgrade_boundary_v433_to_0050':filter
 const result=spawnSync(exes[0],[selected,'--ignored','--nocapture','--test-threads=1'],{env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024**2})
 p.file('native.log',(result.stdout||'')+(result.stderr||''));p.file('exit.json',{status:result.status,signal:result.signal,error:result.error?.message})
 p.check(filter,result.status===0&&result.signal===null&&!result.error&&(filter!=='all-boundaries'||/5 passed; 0 failed; 0 ignored/.test(result.stdout)),{status:result.status,signal:result.signal})
 return p.summary()
}
