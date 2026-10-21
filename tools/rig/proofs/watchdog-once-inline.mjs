import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import {Proof} from '../proof.mjs'
export async function setup(){return{recover:true,'quiet-log':true,fixture:{org:{name:'Inline one-shot'},agents:[{name:'boss',tier:'sol',grant:100}]}}}
export default async function(rig){
 const p=new Proof('watchdog-once-inline')
 rig.scenario({default:{turns:[{steps:[{text:'Synthetic turn complete.'}]}]}})
 const settled=()=>rig.waitFor(()=>rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length===0,{what:'synthetic fixture turns',timeout:60000})
 await settled()
 const create=(name,kind,target,extra={})=>rig.tool('boss','orgtree_watchdog',{action:'create',name,kind,target,once:true,...extra})
 const absent=name=>!rig.one(`SELECT id FROM ot.watchdogs WHERE name='${name}'`)
 const mails=name=>rig.sql(`SELECT uid,body FROM ot.mail WHERE body LIKE '%Watchdog "${name}" fired%'`)
 const inline=r=>r.ok&&r.json?.resolved===true&&r.json?.registered===false&&/immediately|already resolved/i.test(r.text)
 const command=await create('matched','command','echo READY',{pattern:'READY',fire_actions:[{tool:'orgtree_list_tiers',args:{}}]})
 p.check('matching command resolves from smoke with full fire and inline actions',inline(command)&&command.text.includes('READY')&&command.text.includes('Fire actions'),command.text)
 p.check('matching command never registers or sends fire mail',absent('matched')&&mails('matched').length===0)
 const pending=await create('pending','command','echo WAIT',{pattern:'READY',notice:true})
 p.check('unmatched command registers normally',pending.ok&&!pending.json?.resolved&&!absent('pending'),pending.text)
 const silence=await create('silence','command','echo READY',{pattern:'READY',fire_mode:'silence',quiet_period_s:3600,notice:true})
 p.check('silence mode never resolves inline',silence.ok&&!silence.json?.resolved&&!absent('silence'))
 const down=await create('already-down','process','pid:2147483647')
 p.check('already-down process resolves inline',inline(down)&&/DOWN/.test(down.text)&&absent('already-down')&&mails('already-down').length===0,down.text)
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r))
 try{const up=await create('still-up','process','port:'+server.address().port,{notice:true});p.check('live process port remains registered',up.ok&&!up.json?.resolved&&!absent('still-up'),up.text)}finally{await new Promise(r=>server.close(r))}
 const scratch=path.join(rig.dir,'inline-owner');fs.mkdirSync(scratch,{recursive:true})
 const file=path.join(scratch,'already-present.log');fs.writeFileSync(file,'READY\n')
 // A real owner working folder, isolated inside this synthetic fixture.
 rig.exec(`UPDATE ot.agents SET scratch_dir='${scratch.replaceAll("'","''")}' WHERE name='boss'`)
 const f=await create('append-only','file',file,{pattern:'READY',notice:true})
 p.check('old file contents do not resolve a new once watch',f.ok&&!f.json?.resolved&&!absent('append-only'),f.text)
 await rig.op({op:'create_project',name:'build',parent:'boss'});await rig.op({op:'set_slots',node:'build',capacity:2});await settled()
 const slot=await create('slot-free','slot','build',{slots:2})
 p.check('free slots return their whole lease inline without a dog or mail',inline(slot)&&!!slot.json?.lease&&absent('slot-free')&&mails('slot-free').length===0,slot.text)
 const held=rig.one("SELECT uid,slot_count FROM ot.slot_leases WHERE ended_at IS NULL AND project_id=(SELECT id FROM ot.agents WHERE name='build')")
 p.check('inline slot grant is a durable lease',held?.slot_count===2&&held.uid===slot.json?.lease,held)
 await rig.op({op:'hire',name:'waiter',parent:'build',tier:'sol',grant:0});await settled()
 const queued=await rig.tool('waiter','orgtree_watchdog',{action:'create',kind:'slot',name:'queued',target:'build',notice:true})
 p.check('unavailable slot registers a normal pending claim',queued.ok&&!queued.json?.resolved&&!!rig.one("SELECT id FROM ot.watchdogs WHERE name='queued' AND state='armed'"),queued.text)
 const release=held?await rig.tool('boss','orgtree_project',{action:'release_slot',lease:held.uid}):{ok:false}
 p.check('inline lease releases normally and grants the waiting claim',release.ok&&!!rig.one("SELECT id FROM ot.slot_leases WHERE holder_agent_id=(SELECT id FROM ot.agents WHERE name='waiter') AND ended_at IS NULL"),release.text)
 await rig.op({op:'hire',name:'tail',parent:'build',tier:'sol',grant:0});await settled()
 const head=await create('slot-head','slot','build',{slots:2,notice:true})
 const tail=await rig.tool('tail','orgtree_watchdog',{action:'create',name:'slot-tail',kind:'slot',target:'build',slots:1,once:true,notice:true})
 p.check('inline candidates respect a whole-unit FIFO head even with room for the tail',head.ok&&!head.json?.resolved&&tail.ok&&!tail.json?.resolved&&rig.one("SELECT count(*)::int n FROM ot.slot_leases WHERE ended_at IS NULL").n===1,{head:head.text,tail:tail.text})
 for(const ack of [false,true]){
  const name=ack?'ackq':'roundq';await rig.op({op:'create_project',name,parent:'boss'});if(ack)await rig.op({op:'set_mail_queue',node:name,mode:'ack'});await settled()
  rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,notice)
   SELECT 'm-inline-${name}-'||g,p.org_id,CASE WHEN g=2 THEN '@net:outside.fixture' ELSE '@user' END,'agent',p.id,p.name,'job-${name}-'||g,'pending',false FROM ot.agents p CROSS JOIN generate_series(1,3) g WHERE p.name='${name}'`)
  const before=rig.one("SELECT count(*)::int n FROM ot.turns WHERE agent_id=(SELECT id FROM ot.agents WHERE name='boss')").n
  const take=await create('take-'+name,'fair_queue',name,{batch:2})
  p.check(name+' returns its complete available batch inline',inline(take)&&take.json?.messages?.length===2&&take.text.includes('job-'+name+'-1')&&take.text.includes('job-'+name+'-2'),take.text)
  p.check(name+' retains canonical sender authority, EXTERNAL and queue/ACK instructions',take.text.includes('outside party · see EXTERNAL')&&take.text.includes('Via project '+name)&&(!ack||take.text.includes('ACK MODE')),take.text)
  const copies=rig.sql(`SELECT uid,state,extra FROM ot.mail WHERE recipient_name='boss' AND extra->'via_project'->>'name'='${name}' ORDER BY id`)
  p.check(name+' copies are already consumed and no dog is registered',absent('take-'+name)&&copies.length===2&&copies.every(m=>m.state==='read'),copies)
  p.check(name+' keeps unclaimed mail and ACK provenance',rig.one(`SELECT count(*)::int n FROM ot.mail WHERE recipient_name='${name}' AND state='pending'`).n===1&&copies.every(m=>m.extra.via_project.ack===ack))
  p.check(name+' inline resolution schedules no holder turn',rig.one("SELECT count(*)::int n FROM ot.turns WHERE agent_id=(SELECT id FROM ot.agents WHERE name='boss')").n===before)
  if(ack&&copies[0]){
   // A second creation cannot exceed the existing unacked batch; its normal
   // release-stale pass must not reclaim the inline listener's outstanding jobs.
   const capped=await create('ack-capped','fair_queue',name,{batch:2,notice:true})
   p.check('inline ACK custody survives and batch cap blocks another inline claim',capped.ok&&!capped.json?.resolved&&rig.one(`SELECT count(*)::int n FROM ot.mail WHERE recipient_name='${name}' AND extra->'claimed'->>'inline'='true' AND NOT coalesce((extra->'claimed'->>'acked')::boolean,false)`).n===2,capped.text)
   const done=await rig.tool('boss','orgtree_message',{metadata:{to:name,reply_to:copies[0].uid},body:'ack completed'});p.check('inline ACK mail still accepts its normal reply acknowledgement',done.ok,done.text)
  }
 }
 await rig.op({op:'create_project',name:'emptyq',parent:'boss'});await settled()
 const q=await create('empty-queue','fair_queue','emptyq',{notice:true})
 p.check('empty queue registers a normal listener',q.ok&&!q.json?.resolved&&!absent('empty-queue'),q.text)
 const denied=await rig.tool('waiter','orgtree_watchdog',{action:'create',name:'no-reach',kind:'fair_queue',target:'roundq',once:true})
 p.check('inline queue claims do not expand project reach',!denied.ok&&absent('no-reach'),denied.text)
 const dir=path.join(rig.data,'rig-home','rig-usage');fs.mkdirSync(dir,{recursive:true})
 fs.writeFileSync(path.join(dir,'openai.json'),JSON.stringify({available:true,observed_at:new Date().toISOString(),limits:[{kind:'session',group:'session',percent:100,resets_at:new Date(Date.now()+3600000).toISOString()}]}))
 await rig.api('GET','/api/codex/usage?force=true')
 const reading=await rig.tool('boss','orgtree_usage',{accounts:['openai/primary']})
 p.check('usage fixture has a real fresh cached limit',reading.json?.accounts?.[0]?.windows?.some(w=>w.used_percent===100),reading.text)
 const usage={accounts:['openai/primary'],windows:['session'],usage_events:['above','limit'],threshold_percent:98}
 const current=await create('usage-now','usage','usage',usage)
 p.check('current cached usage levels resolve inline without a dog or mail',inline(current)&&current.text.includes('above')&&current.text.includes('limit')&&absent('usage-now')&&mails('usage-now').length===0,current.text)
 const edge=await create('usage-edge','usage','usage',{...usage,usage_events:['reset','recovered','refused','account_added','account_removed'],notice:true})
 p.check('edge-only usage events cannot be already true',edge.ok&&!edge.json?.resolved&&!absent('usage-edge'),edge.text)
 const repeating=await create('usage-repeat','usage','usage',{...usage,once:false,notice:true})
 await rig.waitFor(()=>mails('usage-repeat').length===1,{what:'creation level is the repeating dog first fire',timeout:15000})
 p.check('repeating usage delivers its creation level once through normal mail',repeating.ok&&!repeating.json?.resolved&&mails('usage-repeat').length===1&&rig.one("SELECT fired FROM ot.watchdogs WHERE name='usage-repeat'")?.fired===1,repeating.text)
 rig.exec(`UPDATE ot.agents SET frozen=jsonb_build_object('limit',true,'account','openai/primary','at',now(),'until',now()+interval '1 hour') WHERE name='waiter'`)
 const frozen=await create('usage-frozen','usage','usage',{accounts:['openai/primary'],usage_events:['frozen']})
 p.check('visible current usage freeze resolves inline',inline(frozen)&&frozen.text.includes('frozen')&&absent('usage-frozen'),frozen.text)
 p.keep(rig,{agents:['boss','waiter'],grep:/inline|watchdog|error/});return p.summary()
}
