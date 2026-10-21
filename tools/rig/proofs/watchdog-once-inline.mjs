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
 const file=path.join(rig.dir,'already-present.log');fs.writeFileSync(file,'READY\n')
 // This process owns the synthetic rig directory; explicitly grant it to the fixture agent.
 rig.exec(`UPDATE ot.agents SET scope=jsonb_set(scope,'{add_dirs}',to_jsonb(ARRAY['${rig.dir.replaceAll("'","''")}']::text[])) WHERE name='boss'`)
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
 for(const ack of [false,true]){
  const name=ack?'ackq':'roundq';await rig.op({op:'create_project',name,parent:'boss'});if(ack)await rig.op({op:'set_mail_queue',node:name,mode:'ack'});await settled()
  rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,notice)
   SELECT 'm-inline-${name}-'||g,p.org_id,'@user','agent',p.id,p.name,'job-${name}-'||g,'pending',false FROM ot.agents p CROSS JOIN generate_series(1,3) g WHERE p.name='${name}'`)
  const before=rig.one("SELECT count(*)::int n FROM ot.turns WHERE agent_id=(SELECT id FROM ot.agents WHERE name='boss')").n
  const take=await create('take-'+name,'fair_queue',name,{batch:2})
  p.check(name+' returns its complete available batch inline',inline(take)&&take.json?.messages?.length===2&&take.text.includes('job-'+name+'-1')&&take.text.includes('job-'+name+'-2'),take.text)
  const copies=rig.sql(`SELECT uid,state,extra FROM ot.mail WHERE recipient_name='boss' AND extra->'via_project'->>'name'='${name}' ORDER BY id`)
  p.check(name+' copies are already consumed and no dog is registered',absent('take-'+name)&&copies.length===2&&copies.every(m=>m.state==='read'),copies)
  p.check(name+' keeps unclaimed mail and ACK provenance',rig.one(`SELECT count(*)::int n FROM ot.mail WHERE recipient_name='${name}' AND state='pending'`).n===1&&copies.every(m=>m.extra.via_project.ack===ack))
  p.check(name+' inline resolution schedules no holder turn',rig.one("SELECT count(*)::int n FROM ot.turns WHERE agent_id=(SELECT id FROM ot.agents WHERE name='boss')").n===before)
  if(ack&&copies[0]){const done=await rig.tool('boss','orgtree_message',{metadata:{to:name,reply_to:copies[0].uid},body:'ack completed'});p.check('inline ACK mail still accepts its normal reply acknowledgement',done.ok,done.text)}
 }
 await rig.op({op:'create_project',name:'emptyq',parent:'boss'});await settled()
 const q=await create('empty-queue','fair_queue','emptyq',{notice:true})
 p.check('empty queue registers a normal listener',q.ok&&!q.json?.resolved&&!absent('empty-queue'),q.text)
 p.keep(rig,{agents:['boss','waiter'],grep:/inline|watchdog|error/});return p.summary()
}
