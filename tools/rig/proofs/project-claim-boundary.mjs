import {Proof} from '../proof.mjs'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
export async function setup(){return {fixture:{org:{name:'Claim boundary'},agents:[{name:'boss',tier:'sol',grant:100}]}}}
export default async function(rig){
 const p=new Proof('project-claim-boundary'),deps='C:/orgtree-build/taskbar-orgs-sol/watchdog-uncap-target/debug/deps'
 const exes=fs.readdirSync(deps).filter(n=>/^orgtree_engine-[a-f0-9]+\.exe$/.test(n)).map(n=>path.join(deps,n)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)
 if(!exes.length)throw Error('compile focused native test first')
 const {port,password}=rig.pgConn()
 const env={...process.env,ORGTREE_CLAIM_TEST_URL:`host=127.0.0.1 port=${port} user=orgtree_admin password=${password} dbname=orgtree_engine`,ORGTREE_CLAIM_TEST_ROOT:rig.dir.replaceAll('\\','/'),ORGTREE_CLAIM_TEST_ORG:String(rig.one(`SELECT org_id FROM ot.agents WHERE name='boss'`).org_id)}
 const result=spawnSync(exes[0],['claim_boundary_stale_reclaim','--ignored','--nocapture'],{env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024**2})
 p.file('native.log',(result.stdout||'')+(result.stderr||''));p.file('exit.json',{status:result.status,signal:result.signal,error:result.error?.message})
 p.check('stale reclaim cannot cross holder, user, ABA, ACK or recovered-holder barriers',result.status===0&&result.signal===null&&!result.error,{status:result.status,signal:result.signal})
 return p.summary()
}
