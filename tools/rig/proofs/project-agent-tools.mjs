// Focused G3/G5/G6/P1 proof. Run only in the synthetic rig, never against live
// state. The caller supplies a C: evidence directory and owns the build slot.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export default async function (rig) {
  const out=process.env.PROJECT_TOOLS_EVIDENCE
  assert.ok(out,'PROJECT_TOOLS_EVIDENCE is required')
  fs.mkdirSync(out,{recursive:true})
  const checks=[]
  const check=(name,ok)=>{checks.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);assert.ok(ok,name)}
  const tool=async(who,name,args)=>{const r=await rig.tool(who,name,args);assert.equal(r.ok,true,r.text);return r.json??JSON.parse(r.text)}
  const inbox=(who,args)=>tool(who,'orgtree_inbox',{project:'queue',...args})
  const project=(who,args)=>tool(who,'orgtree_project',{name:'queue',...args})
  const row=name=>rig.one(`SELECT id,parent_id,org_id FROM ot.agents WHERE name='${name}' AND org_id=(SELECT id FROM ot.orgs WHERE slug='${rig.org}')`)
  try {
    await rig.op({op:'hire',name:'boss',tier:'haiku',grant:40,charter:'Synthetic project tools proof.'})
    await rig.op({op:'create_project',name:'queue',parent:'boss'})
    for(const [name,parent] of [['worker-a','queue'],['worker-b','queue'],['outsider','boss']]) {
      await rig.op({op:'hire',name,parent,tier:'haiku',grant:0,charter:'Synthetic project tools proof.'})
    }
    const p=row('queue'),a=row('worker-a'),b=row('worker-b')
    await rig.api('PUT','/api/app-settings/runtime',{project_listener_wake_enabled:false})
    rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,notice,state)
      SELECT 'history-'||n,${p.org_id},'@user','agent',${p.id},'queue','waiting '||n,true,'pending' FROM generate_series(1,205) n;
      INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,notice,state,extra) VALUES
      ('delivered',${p.org_id},'@user','agent',${p.id},'queue','delivered',true,'read','{"claimed":{"by":"worker-a","ack":false}}'),
      ('claimed',${p.org_id},'@user','agent',${p.id},'queue','claimed',true,'read','{"claimed":{"by":"worker-a","ack":true}}'),
      ('acked',${p.org_id},'@user','agent',${p.id},'queue','acked',true,'read','{"claimed":{"by":"worker-a","ack":true,"acked_at":"2026-10-18T00:00:00Z"}}'),
      ('dead',${p.org_id},'@user','agent',${p.id},'queue','dead',true,'retracted','{"dead_letter":{"why":"fixture","attempts":3}}'),
      ('purged',${p.org_id},'@user','agent',${p.id},'queue','purged',true,'retracted','{"purged":{"by":"boss"}}');
      INSERT INTO ot.mail(uid,org_id,sender,sender_agent_id,recipient_kind,recipient_agent_id,recipient_name,body,notice,state)
      VALUES ('sent-project',${p.org_id},'queue',${p.id},'agent',${a.id},'worker-a','sent fixture',true,'read');
      UPDATE ot.mail SET body=repeat('🦀é',40000) WHERE uid='history-205';`)
    const stamp=()=>rig.one(`SELECT md5(string_agg(uid||state||extra::text||coalesce(read_at::text,''),',' ORDER BY id)) AS hash FROM ot.mail WHERE recipient_agent_id=${p.id}`).hash
    const before=stamp()
    let cursor;const ids=[];let pages=0
    do {const v=await inbox('boss',{action:'list',limit:200,...(cursor?{cursor}:{})});ids.push(...v.messages.map(m=>m.id));cursor=v.next_cursor;pages++}while(cursor)
    check('waiting backlog beyond200 pages completely without duplicates',pages===2&&ids.length===205&&new Set(ids).size===205)
    const history=await inbox('worker-a',{action:'list',folder:'inbox',limit:200})
    check('project member can read delivered history and continue it',history.messages.some(m=>m.status==='acked')&&history.has_more)
    const changed=await rig.tool('boss','orgtree_inbox',{action:'list',project:'queue',folder:'sent',cursor:history.next_cursor})
    check('cursor rejects caller or filter substitution',!changed.ok)
    for(const status of ['waiting','delivered','claimed','acked','dead-letter']) {
      const v=await inbox('boss',{action:'list',folder:'inbox',status,limit:200})
      check(`queue status ${status} selects the correct stage`,v.messages.length>0&&v.messages.every(m=>m.status===status))
      if(status==='delivered')check('purged mail is not reported as delivered',v.messages.length===1&&v.messages[0].id==='delivered')
    }
    const sent=await inbox('boss',{action:'list',folder:'sent'})
    check('Sent reads project outgoing records separately',sent.messages.length===1&&sent.messages[0].id==='sent-project'&&sent.messages[0].to==='worker-a')
    const fetched=await inbox('boss',{action:'fetch',folder:'inbox',message_ids:['acked','dead','sent-project']})
    check('historical fetch accepts acked and dead-letter records only in its folder',fetched.messages.length===2&&fetched.not_found.includes('sent-project'))
    const long=(await inbox('boss',{action:'fetch',message_ids:['history-205']})).messages[0]
    let rebuilt=long.content
    for(let i=1;i<long.chunk_total;i++) {
      const v=await inbox('boss',{action:'chunk',message_id:long.id,delivery_id:long.delivery_id,chunk_index:i})
      rebuilt+=v.content
    }
    check('historical project mail chunks reassemble exact Unicode body and digest',rebuilt==='🦀é'.repeat(40000)&&crypto.createHash('sha256').update(rebuilt).digest('hex')===long.body_sha256)
    const wrong=await rig.tool('worker-a','orgtree_inbox',{action:'chunk',project:'queue',message_id:long.id,delivery_id:long.delivery_id,chunk_index:1})
    check('project body handle cannot be used by another caller',!wrong.ok)
    const outsider=await rig.tool('outsider','orgtree_inbox',{action:'fetch',project:'queue',message_ids:['acked']})
    check('unrelated agent cannot read project history',!outsider.ok)
    check('all project list/fetch/chunk reads preserve queue state exactly',stamp()===before)

    const wrapped=await project('boss',{action:'create',name:'wrapper',above:'worker-a'})
    const w=row('wrapper')
    check('tool creates above atomically without an index',!!wrapped&&row('worker-a').parent_id===w.id&&w.parent_id===p.id)
    const denied=await rig.tool('outsider','orgtree_project',{action:'create',name:'forbidden-wrapper',above:'worker-b'})
    check('create above retains canonical authority and leaves no partial node',!denied.ok&&!row('forbidden-wrapper'))
    const root=await project('boss',{action:'create',name:'forbidden-root',parent:'user',index:0})
      .then(()=>true,()=>false)
    check('ordinary root project creation remains refused',!root&&!row('forbidden-root'))

    rig.exec(`INSERT INTO ot.documents(uid,org_id,agent_id,node_name,title,body,bytes,format)
      VALUES ('long-presentation',${p.org_id},${p.id},'queue','Unicode body',repeat('🦀é',40000),240000,'markdown'),
      ('member-presentation',${p.org_id},${a.id},'worker-a','Member body','member',6,'markdown');`)
    let body='',index=0,count=0,revision
    do {const v=await project('worker-a',{action:'read_presentation',document:'long-presentation',chunk_index:index,...(revision?{body_revision:revision}:{})});const d=v.documents[0];
      check(`presentation window${index} is bounded`,Buffer.byteLength(d.body)<=65536);body+=d.body;index=d.next_chunk_index;count++;revision=d.body_revision
    }while(index!==null)
    check('presentation continuation reconstructs full body beyond60000 without clipping',count>1&&body==='🦀é'.repeat(40000))
    const outOfRange=await rig.tool('boss','orgtree_project',{action:'read_presentation',name:'queue',document:'long-presentation',chunk_index:999})
    check('invalid presentation body index refuses',!outOfRange.ok)
    const noTeam=await rig.tool('worker-a','orgtree_project',{action:'read_presentation',name:'queue',document:'member-presentation'})
    const team=await project('worker-a',{action:'read_presentation',document:'member-presentation',team:true})
    check('presentation team scope remains explicit',!noTeam.ok&&team.documents[0].body==='member')
    const noGallery=await rig.tool('outsider','orgtree_project',{action:'read_presentation',name:'queue',document:'long-presentation'})
    check('unrelated agent cannot read full presentation body',!noGallery.ok)
    rig.exec("UPDATE ot.documents SET body=body||' revised' WHERE uid='long-presentation'")
    const stale=await rig.tool('worker-a','orgtree_project',{action:'read_presentation',name:'queue',document:'long-presentation',chunk_index:1,body_revision:revision})
    check('replacement during a body read refuses stale continuation',!stale.ok)

    for(const who of ['worker-a','worker-b']) await tool(who,'orgtree_message',{metadata:{to:'boss',notice:true},body:`reply source ${who}`})
    const source=who=>rig.one(`SELECT uid FROM ot.mail WHERE sender_agent_id=${row(who).id} AND recipient_agent_id=${row('boss').id} AND body='reply source ${who}'`).uid
    const sources=[source('worker-a'),source('worker-b')]
    const reply=await project('boss',{action:'broadcast',body:'Plural reply proof',notice:true,reply_to:sources[0],replies:sources})
    const replyRows=rig.sql("SELECT recipient_name,replies FROM ot.mail WHERE body='Plural reply proof' ORDER BY recipient_name")
    check('broadcast plural replies send per recipient and filter foreign conversation context',reply.outcomes.length===2&&reply.outcomes.every(v=>v.sent)&&replyRows.length===2&&replyRows.every(r=>r.replies.length===1&&r.replies[0].from===r.recipient_name))
    const refused=await project('boss',{action:'broadcast',body:'Must refuse urgency',urgent:true,urgent_reason:'Synthetic deadline',notice:true})
    check('urgent broadcast refuses each recipient outsideDND and writes nothing',refused.outcomes.every(v=>!v.sent)&&rig.one("SELECT count(*)::int AS n FROM ot.mail WHERE body='Must refuse urgency'").n===0)
    // A real fake-CLI turn supplies DND; no synthetic live-row fault injection.
    rig.scenario({default:{turns:[{match:'DND-PROBE',steps:[{sleep_ms:120000},{text:'done'}]},{steps:[{text:'ok'}]}]}})
    await rig.userMail('worker-a','DND-PROBE')
    await rig.waitFor(()=>rig.one(`SELECT count(*)::int AS n FROM ot.turns WHERE agent_id=${a.id} AND ended_at IS NULL`).n>0,{what:'fakeCLI DND turn',timeout:30000})
    const dnd=await rig.tool('worker-a','orgtree_status',{status:'working',summary:'Synthetic DND proof',dnd:true})
    assert.equal(dnd.ok,true,dnd.text)
    const urgent=await project('boss',{action:'broadcast',body:'Mixed urgency proof',urgent:true,urgent_reason:'Synthetic deadline',notice:true})
    const by=new Map(urgent.outcomes.map(o=>[o.to,o.sent]))
    check('urgent broadcast mixes DND send and nonDND refusal honestly',by.get('worker-a')===true&&by.get('worker-b')===false)
    check('urgent metadata reaches ordinary delivery storage',rig.one("SELECT urgent,urgent_reason FROM ot.mail WHERE body='Mixed urgency proof'")?.urgent===true)
    return {passed:true,checks:checks.length}
  } finally {
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({checks,passed:checks.length>0&&checks.every(c=>c.ok)},null,2))
  }
}
