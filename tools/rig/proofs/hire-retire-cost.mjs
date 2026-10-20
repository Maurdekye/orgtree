// Synthetic live-size org:54 agents,80 projects (a deep stack),1400 retired,
// and100k retained mails. Measure real user gestures through record visibility.
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {Proof} from '../proof.mjs'
export async function setup(){return {'quiet-log':process.env.HIRE_COST_QUIET==='1',maxParked:1,fixture:{org:{name:'Hire retire cost'},agents:[{name:'boss',tier:'sol',grant:500}]}}}
export default async function(rig){
 const p=new Proof('hire-retire-cost-'+(process.env.HIRE_COST_QUIET==='1'?'quiet':'verbose'))
 await rig.api('PUT','/api/app-settings/runtime',{warming_enabled:false})
 const org=rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id,boss=rig.one(`SELECT id FROM ot.agents WHERE org_id=${org} AND name='boss'`).id
 const columns=rig.sql(`SELECT column_name FROM information_schema.columns WHERE table_schema='ot' AND table_name='agents' AND is_generated='NEVER' AND identity_generation IS NULL AND column_name NOT IN ('name','parent_id','sibling_order','state','kind','tier','seat','grant_credits') ORDER BY ordinal_position`).map(r=>r.column_name)
 const copy=(prefix,count,state,kind,tier)=>rig.exec(`INSERT INTO ot.agents(name,parent_id,sibling_order,state,kind,tier,seat,grant_credits,${columns.join(',')}) SELECT '${prefix}'||g,${boss},g,'${state}','${kind}','${tier}',0,0,${columns.map(c=>'a.'+c).join(',')} FROM ot.agents a,generate_series(1,${count}) g WHERE a.id=${boss}`)
 copy('project-',80,'live','project','project');copy('peer-',53,'live','agent','sol');copy('old-',1400,'archived','agent','sol')
 rig.exec(`UPDATE ot.agents a SET parent_id=p.id FROM ot.agents p WHERE a.org_id=${org} AND p.org_id=${org} AND a.name LIKE 'project-%' AND substring(a.name FROM 9)::int>1 AND p.name='project-'||(substring(a.name FROM 9)::int-1)`)
 rig.exec(`UPDATE ot.agents SET parent_id=(SELECT id FROM ot.agents WHERE org_id=${org} AND name='project-80') WHERE org_id=${org} AND name='peer-53'`)
 rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,kind,notice,body,state) SELECT 'history-'||g,${org},'@system','agent',${boss},'boss','notice',true,'Synthetic retained history','read' FROM generate_series(1,100000) g`)
 rig.exec('ANALYZE ot.agents; ANALYZE ot.mail')
 await rig.restart()
 const snapshot=()=>rig.api('GET',`/api/orgs/${rig.org}/records`)
 const has=(s,name)=>s.records.some(r=>r.entity==='agent'&&r.body?.id===name&&r.body.state==='live')
 const samples=[]
 for(let i=0;i<5;i++){
  const name='measure-'+i
  let start=performance.now();await rig.op({op:'hire',name,parent:'boss',tier:'sol',grant:0});let reply=performance.now()
  await rig.waitFor(async()=>{const s=await snapshot();return has(s,name)?s:null},{timeout:15000,every:10,what:'hired node in records'})
  samples.push({op:'hire',reply_ms:reply-start,visible_ms:performance.now()-start})
  start=performance.now();await rig.op({op:'retire',node:name});reply=performance.now()
  await rig.waitFor(async()=>{const s=await snapshot();return !has(s,name)?s:null},{timeout:15000,every:10,what:'retired node leaves live records'})
  samples.push({op:'retire',reply_ms:reply-start,visible_ms:performance.now()-start})
 }
 const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)]
 const medians=Object.fromEntries(['hire','retire'].map(op=>[op,Object.fromEntries(['reply_ms','visible_ms'].map(k=>[k,median(samples.filter(s=>s.op===op).map(s=>s[k]))]))]))
 p.file('timings.json',{quiet:process.env.HIRE_COST_QUIET==='1',shape:{live:54,projects:80,retired:1400,read_mail:100000},samples,medians})
 p.note('round trips and record visibility',medians)
 const {port,password}=rig.pgConn()
 const outstanding="m.state='read' AND coalesce((m.extra->'claimed'->>'ack')::boolean,false) AND m.extra->'claimed'->>'acked_at' IS NULL"
 const sql=`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT DISTINCT m.recipient_agent_id FROM ot.mail m WHERE m.org_id=${org} AND (m.extra->'claimed'->>'by_id')::bigint=${boss} AND ${outstanding}`
 const child=spawnSync(path.join(rig.run.pgBin,'psql.exe'),['-X','-q','-At','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','orgtree_admin','-d','orgtree_engine','-c',sql],{encoding:'utf8',windowsHide:true,env:{...process.env,PGPASSWORD:password}})
 if(child.status!==0)throw Error(child.stderr)
 const plan=JSON.parse(child.stdout.trim());p.file('holder-plan.json',plan)
 p.check('holder lookup seeks only active claims, not retained mail history',JSON.stringify(plan).includes('mail_active_claim_holder'),plan)
 p.check('every measured operation reached the live record set',samples.length===10)
 const logs=rig.engineLog();const hot=['rebuild_agents','tool_groups.normalize','tree.stored_forecast','continuation.resolve','catalog.antigravity_pool','usage.at_limit','tree.cold_turn_action']
 p.file('log-volume.json',{bytes:Buffer.byteLength(logs),lines:logs.split(/\r?\n/).length,hot:Object.fromEntries(hot.map(k=>[k,logs.split(/\r?\n/).filter(l=>l.includes(k+'(')).length]))})
 return p.summary()
}
