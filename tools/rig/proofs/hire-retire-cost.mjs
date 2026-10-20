// Synthetic live-size org:54 agents,80 projects (a deep stack),1400 retired,
// and100k retained mails. Measure real user gestures through record visibility.
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import http from 'node:http'
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
 const logDir=path.join(rig.data,'diagnostics','logs')
 const logPath=fs.readdirSync(logDir).filter(n=>n.endsWith('.log')).map(n=>path.join(logDir,n)).find(file=>{
  const fd=fs.openSync(file,'r'),b=Buffer.alloc(1024);const n=fs.readSync(fd,b,0,b.length,0);fs.closeSync(fd);return b.subarray(0,n).toString().includes(`engine starting pid=${rig.run.enginePid} `)
 })
 if(!logPath)throw Error('No exact engine PID log')
 const logOffset=fs.statSync(logPath).size
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
 const logs=fs.readFileSync(logPath).subarray(logOffset).toString();const hot=['rebuild_agents','tool_groups.normalize','tree.stored_forecast','continuation.resolve','catalog.antigravity_pool','usage.at_limit','tree.cold_turn_action']
 if(process.env.HIRE_COST_QUIET!=='1')p.check('closed mailbox windows are never materialized',!logs.includes('feed.compute.agent_mailbox('))
 p.file('log-volume.json',{bytes:Buffer.byteLength(logs),lines:logs.split(/\r?\n/).length,hot:Object.fromEntries(hot.map(k=>[k,logs.split(/\r?\n/).filter(l=>l.includes(k+'(')).length]))})
 // An explicitly open window still receives full initial bodies and live
 // lifecycle notices/history. Closed-window optimization must preserve it.
 // Node's native WebSocket has no custom-header option. A loopback-only
 // upgrade proxy adds the synthetic desktop token, with no npm dependency.
 const proxy=http.createServer();const connections=new Set()
 proxy.on('upgrade',(req,socket,head)=>{
  connections.add(socket);socket.on('close',()=>connections.delete(socket))
  const upstream=http.request(new URL(`/api/orgs/${rig.org}/ws`,rig.url),{headers:{...req.headers,'X-Orgtree-Desktop-Token':rig.token}})
  upstream.on('upgrade',(res,peer,extra)=>{
   connections.add(peer);peer.on('close',()=>connections.delete(peer))
   socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`)
   if(extra.length)socket.write(extra);if(head.length)peer.write(head)
   socket.pipe(peer);peer.pipe(socket);socket.on('close',()=>peer.destroy());peer.on('error',()=>socket.destroy())
  })
  upstream.on('error',()=>socket.destroy());upstream.on('response',()=>socket.destroy());upstream.end()
 })
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve))
 const ws=new WebSocket(`ws://127.0.0.1:${proxy.address().port}/`)
 const frames=[];ws.addEventListener('message',e=>{try{frames.push(JSON.parse(e.data))}catch{}})
 const event=(name)=>new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('socket '+name+' timeout')),10000);ws.addEventListener(name,()=>{clearTimeout(t);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(t);reject(Error('socket error'))},{once:true})})
 try{
  await event('open')
  ws.send(JSON.stringify({type:'subscribe',sub:9,agents:[],windows:[{kind:'agent_mail',agent:String(boss)},{kind:'agent_history',agent:String(boss)}]}))
  await rig.waitFor(()=>frames.find(f=>f.type==='record_subscribed'&&f.sub===9),{timeout:15000,every:10,what:'open window snapshot'})
  p.check('opening a mailbox reads its retained rows',frames.some(f=>f.type==='record_subscribed'&&(f.records??[]).some(r=>r.entity===`agent_mail:${boss}`)))
  const offset=frames.length
  await rig.op({op:'hire',name:'subscription-control',parent:'boss',tier:'sol',grant:0})
  const changed=await rig.waitFor(()=>frames.slice(offset).find(f=>(f.upserts??[]).some(r=>r.entity===`agent_mail:${boss}`&&JSON.stringify(r.body).includes('subscription-control'))),{timeout:15000,every:10,what:'live subscribed notice'})
  p.check('an open mailbox receives the new lifecycle notice',!!changed)
  const historyOffset=frames.length
  await rig.op({op:'retool',node:'boss',charter:'Synthetic history-window control'})
  const history=await rig.waitFor(()=>frames.slice(historyOffset).find(f=>(f.upserts??[]).some(r=>r.entity===`agent_history:${boss}`&&r.body?.kind==='retool')),{timeout:15000,every:10,what:'live subscribed history'})
  p.check('an open history window receives lifecycle updates',!!history)
 }finally{ws.close();for(const socket of connections)socket.destroy();await new Promise(resolve=>proxy.close(resolve))}
 // Parent scope still propagates through the deep project stack, while
 // project audience changes refresh the actual direct member's card.
 const card=async name=>(await snapshot()).records.find(r=>r.entity==='agent'&&r.body?.id===name)?.body
 await rig.api('POST',`/api/orgs/${rig.org}/nodes/boss/scope`,{tools:{web:true}})
 await rig.waitFor(async()=>(await card('peer-53'))?.scope?.tools?.web===true,{timeout:15000,every:10,what:'scope positive control'})
 await rig.api('POST',`/api/orgs/${rig.org}/nodes/boss/scope`,{tools:{web:false}})
 const restricted=await rig.waitFor(async()=>(await card('peer-53'))?.scope?.tools?.web===false,{timeout:15000,every:10,what:'scope cascade through projects'})
 p.check('scope changes still cascade through 80 projects',!!restricted)
 await rig.api('POST',`/api/orgs/${rig.org}/audiences`,{action:'grant',node:'project-80',target:'user',reason:'Synthetic feed control'})
 const audience=await rig.waitFor(async()=>{const c=await card('peer-53');return JSON.stringify(c?.audiences_held??[]).includes('@user')},{timeout:15000,every:10,what:'project audience updates member card'})
 p.check('project audience changes update the direct member card',!!audience)
 return p.summary()
}
