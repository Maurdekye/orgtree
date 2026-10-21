import { Proof } from '../proof.mjs'
export async function setup() {
  return { fixture: { org: { name: 'Listener boundaries' }, agents: [{ name: 'boss', tier: 'sol', grant: 100 }] } }
}
export default async function(rig) {
  const p = new Proof('project-listener-bounds')
  const node = name => rig.one(`SELECT id,org_id FROM ot.agents WHERE name='${name}' AND state='live'`)
  const project = async name => { await rig.op({op:'create_project',name,parent:'boss'}); return node(name) }
  function members(project, count) {
    rig.exec(`INSERT INTO ot.agents(org_id,name,parent_id,state,tier,born,scope)
      SELECT ${project.org_id},'member-'||${project.id}||'-'||g,${project.id},'live','sol','synthetic','{}'::jsonb FROM generate_series(1,${count}) g`)
  }
  function dogs(project, kind, count, extra = '{}') {
    rig.exec(`INSERT INTO ot.watchdogs(uid,org_id,owner_agent_id,name,kind,target,interval_s,state,once,memo)
      SELECT 'bounds-${kind}-'||a.id, a.org_id,a.id,'bounds-${kind}','${kind}',pr.name,600,'armed',false,
        jsonb_build_object('target_id',pr.id,'notice',true,'count',1) || '${extra}'::jsonb
      FROM ot.agents a JOIN ot.agents pr ON pr.id=a.parent_id WHERE pr.id=${project.id} ORDER BY a.id LIMIT ${count}`)
  }
  function jobs(project,count,prefix='job',sender=null) {
    rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,sender_agent_id,recipient_kind,recipient_agent_id,recipient_name,body,state,notice)
      SELECT '${prefix}-'||${project.id}||'-'||g,pr.org_id,${sender?`a.name`:`'@user'`},${sender??'NULL'},'agent',pr.id,pr.name,'${prefix}-'||g,'pending',true
      FROM ot.agents pr ${sender?`JOIN ot.agents a ON a.id=${sender}`:''} CROSS JOIN generate_series(1,${count}) g WHERE pr.id=${project.id}`)
  }
  const q=await project('many-queue');members(q,66);dogs(q,'fair_queue',65);jobs(q,65)
  const trigger=await rig.tool('boss','orgtree_watchdog',{action:'create',kind:'fair_queue',target:'many-queue',name:'queue-trigger',notice:true})
  await rig.tool('boss','orgtree_message',{metadata:{to:'many-queue',notice:true},body:'flush-service'})
  const served=rig.sql(`SELECT DISTINCT extra->'claimed'->>'by_id' AS owner FROM ot.mail WHERE recipient_agent_id=${q.id} AND state='read'`)
  p.check('all 65 continuous listeners enter service before any is served twice',trigger.ok&&served.length>=65,{trigger:trigger.ok,served:served.length})
  // ACK: the first 64 listeners are at capacity, listener 65 and a new inline
  // candidate both remain eligible. Held copies have valid watchdog provenance.
  const aq=await project('ack-queue');members(aq,66);dogs(aq,'fair_queue',65);jobs(aq,64,'held')
  rig.exec(`UPDATE ot.agents SET scope=scope||'{"mail_queue":"ack"}'::jsonb WHERE id=${aq.id};
    WITH originals AS (SELECT id,uid,row_number() OVER(ORDER BY id) AS rn FROM ot.mail WHERE recipient_agent_id=${aq.id}),
    holders AS (SELECT w.*,a.name AS owner_name,row_number() OVER(ORDER BY w.id) AS rn FROM ot.watchdogs w JOIN ot.agents a ON a.id=w.owner_agent_id WHERE (w.memo->>'target_id')::bigint=${aq.id})
    UPDATE ot.mail m SET state='read',extra=jsonb_build_object('claimed',jsonb_build_object('by_id',h.owner_agent_id,'by',h.owner_name,'dog',h.uid,'ack',true,'at',now(),'copy','copy-'||o.uid))
      FROM originals o JOIN holders h USING(rn) WHERE m.id=o.id;
    INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,state,notice,extra)
      SELECT 'copy-'||m.uid,m.org_id,'@user','agent',a.id,a.name,m.body,'pending',true,
        jsonb_build_object('via_project',jsonb_build_object('id',pr.id,'name',pr.name,'mail',m.uid,'dog',m.extra->'claimed'->>'dog','ack',true))
      FROM ot.mail m JOIN ot.agents a ON a.id=(m.extra->'claimed'->>'by_id')::bigint JOIN ot.agents pr ON pr.id=m.recipient_agent_id WHERE pr.id=${aq.id}`)
  jobs(aq,1,'ack-next')
  const newOwner=rig.one(`SELECT name FROM ot.agents WHERE parent_id=${aq.id} ORDER BY id DESC LIMIT 1`).name
  const inline=await rig.tool(newOwner,'orgtree_watchdog',{action:'create',kind:'fair_queue',target:'ack-queue',name:'inline-tail',once:true,notice:true})
  const assigned=rig.one(`SELECT state,extra->'claimed'->>'by' AS owner FROM ot.mail WHERE recipient_agent_id=${aq.id} AND body='ack-next-1'`)
  p.check('ACK-saturated first 64 do not hide the available tail or inline candidate',inline.ok&&assigned.state==='read',{inline:inline.ok,assigned})
  const e=await project('many-events');members(e,201);dogs(e,'project_listener',201)
  rig.exec(`UPDATE ot.agents SET scope=scope||'{"event_listeners":true}'::jsonb WHERE id=${e.id}`)
  const fire=await rig.tool('boss','orgtree_project',{action:'fire_event',name:'many-events',body:'boundary-event-one'})
  const fired=rig.one(`SELECT count(*)::int AS n FROM ot.watchdogs WHERE kind='project_listener' AND (memo->>'target_id')::bigint=${e.id} AND fired=1`).n
  p.check('one event reaches all 201 continuous listeners',fire.ok&&fired===201,{fire:fire.ok,fired})
  const w=await project('many-watches');members(w,202);dogs(w,'listener_watch',201);dogs(w,'project_listener',1)
  rig.exec(`UPDATE ot.agents SET scope=scope||'{"event_listeners":true}'::jsonb WHERE id=${w.id}`)
  const watch=await rig.tool('boss','orgtree_watchdog',{action:'create',kind:'listener_watch',target:'many-watches',name:'watch-trigger',count:1,notice:true})
  const watches=rig.one(`SELECT count(*)::int AS n FROM ot.watchdogs WHERE kind='listener_watch' AND (memo->>'target_id')::bigint=${w.id} AND fired=1`).n
  p.check('all 201 continuous watches evaluate beyond the first page',watch.ok&&watches>=201,{watch:watch.ok,watches})
  const s=await project('sender-queue');members(s,1);dogs(s,'fair_queue',1)
  rig.exec(`UPDATE ot.agents SET scope=scope||'{"mail_queue_exclude_sender":true}'::jsonb WHERE id=${s.id}`)
  const a=rig.one(`SELECT id FROM ot.agents WHERE parent_id=${s.id}`).id
  jobs(s,64,'own-blocked',a);jobs(s,1,'deliverable')
  const kick=await rig.tool('boss','orgtree_message',{metadata:{to:'sender-queue',notice:true},body:'extra-deliverable'})
  const pending=rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE recipient_agent_id=${s.id} AND body LIKE 'own-blocked-%' AND state='pending'`).n
  const next=rig.one(`SELECT state FROM ot.mail WHERE recipient_agent_id=${s.id} AND body='deliverable-1'`).state
  p.check('64 sender-only head jobs remain pending without blocking mail 65',kick.ok&&pending===64&&next==='read',{kick:kick.ok,pending,next})
  p.note('Seeded synthetic rows only; dispatch/fire/evaluation triggered through public tools, notice delivery prevents live agent work.')
  return p.summary()
}
