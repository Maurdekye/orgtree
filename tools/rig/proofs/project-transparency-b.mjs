// Reporting relations must survive inserting/removing project-only edges.
// Real engine + fakeCLI + isolated scratch DB; no installed data or providers.
import { Proof } from '../proof.mjs'

export async function setup() {
  return { reminders: true, fixture: { org: { name: 'Project transparency B' },
    agents: [{ name: 'boss', tier: 'sol', grant: 500 }] } }
}

export default async function(rig) {
  const p = new Proof('project-transparency-b')
  rig.scenario({ default: { turns: [{ steps: [{ text: 'OK.' }] }] } })
  const switches = on => rig.api('PUT','/api/app-settings/runtime',{
    working_checkups_enabled:false,idle_docket_reminders_enabled:on,blocked_docket_reminders_enabled:false })
  await switches(false)
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const id = name => rig.agentRow(name).id
  const project = (name,parent) => rig.op({op:'create_project',name,...(parent?{parent}:{})})
  const hire = (name,parent,grant=0) => rig.op({op:'hire',name,parent,tier:'sol',grant,tools:{web:false}})
  const mark = () => rig.one('SELECT coalesce(max(id),0)::bigint AS id FROM ot.mail').id
  const notices = (since,variant) => rig.sql(`SELECT recipient_name AS name,notice,ev FROM ot.mail
    WHERE org_id=${org} AND id>${since} AND ev->>'variant'='${variant}' ORDER BY id`)
  const settled = () => rig.waitFor(()=>rig.sql(`SELECT id FROM ot.turns WHERE ended_at IS NULL`).length===0,
    {what:'fixture turns settle',timeout:45000})
  const turn = async (name,text) => {
    await settled()
    const before = rig.turns(name).filter(t=>t.ended_at).length
    await rig.userMail(name,text)
    await rig.waitTurns(name,before+1)
    return rig.fakeLog(name).filter(r=>r.kind==='turn').at(-1)?.prompt??''
  }
  const shapes=[]
  for (const shape of ['direct','one','nested','root','empty']) {
    const manager=shape==='root'?null:`manager-${shape}`
    if(manager) await hire(manager,'boss',60)
    let parent=manager
    if(['one','nested','root'].includes(shape)) {
      parent=`project-${shape}`;await project(parent,manager)
      if(shape!=='one') {await project(`inner-${shape}`,parent);parent=`inner-${shape}`}
    }
    const peer=`peer-${shape}`
    await hire(peer,manager??'root-peer-project',0).catch(async e=>{
      if(manager) throw e
      await project('root-peer-project');await hire(peer,'root-peer-project')
    })
    const name=`worker-${shape}`
    let since=mark()
    await hire(name,parent,12)
    const h=notices(since,'lifecycle.hired')
    p.check(`${shape}: hire tells the real superior and reporting peers, passively`,
      (!manager||h.some(r=>r.name===manager&&r.ev.relation==='report'))&&h.some(r=>r.name===peer&&r.ev.relation==='peer')&&h.every(r=>r.notice),h)
    p.check(`${shape}: hire's parent field is the agent superior or user`,h.length>0&&h.every(r=>r.ev.parent===manager),h.map(r=>r.ev.parent))
    if(shape==='empty') await project('empty-below-worker',name)
    shapes.push({shape,name,parent,manager,peer})
  }

  // Requests never enter a project mailbox, even with a fair-queue watcher.
  for(const s of shapes) {
    const {shape,name,parent,manager,peer}=s
    if(manager&&shape!=='direct'&&shape!=='empty') {
      const dog=await rig.tool(name,'orgtree_watchdog',{action:'create',name:'ask-queue',kind:'fair_queue',target:parent})
      p.check(`${shape}: fair-queue trap is armed`,dog.ok,dog.text)
    }
    const before=mark()
    const ask=await rig.tool(name,'orgtree_ask',{question:`PTB-QUESTION-${shape}: which option?`,options:[{label:'A'},{label:'B'}]})
    const scope=await rig.tool(name,'orgtree_request_scope',{items:[{kind:'tool',tool:'web'}],reason:`PTB-SCOPE-${shape}`})
    const routed=rig.sql(`SELECT recipient_name,ev,body FROM ot.mail WHERE id>${before} AND sender='${name}'`)
    const card=rig.one(`SELECT uid,rev,body FROM ot.asks WHERE agent_id=${id(name)} AND status='open' ORDER BY id DESC LIMIT 1`)
    if(manager) {
      p.check(`${shape}: question and scope request both reach the agent superior`,ask.ok&&scope.ok&&routed.length===2&&routed.every(r=>r.recipient_name===manager)&&!card,{ask:ask.text,scope:scope.text,routed})
    } else {
      p.check(`${shape}: questions/scope from a root-project agent open a user card`,ask.ok&&scope.ok&&!!card&&routed.length===0,{ask:ask.text,scope:scope.text,card})
      if(card) {
        await rig.api('POST',`/api/orgs/${rig.org}/nodes/${name}/batch`,{revs:{ask:card.rev,scope:card.rev},answers:['A'],scope:['approve']})
        p.check('root: the user answer returns to the actual asker',rig.sql(`SELECT id FROM ot.mail WHERE recipient_agent_id=${id(name)} AND sender='@user' AND kind='decision'`).length===1)
      } else p.check('root: the user answer returns to the actual asker',false,'no card on baseline')
    }
    const created=await rig.tool(name,'orgtree_work',{action:'create',title:`PTB item ${shape}`,objective:'Synthetic project-transparency handoff and deployer fixture.'})
    if(!created.ok) throw new Error(created.text)
    s.slug=created.json.slug
    const since=mark()
    const hand=await rig.tool(name,'orgtree_work',{action:'handoff',slug:s.slug,reason:'PTB-HANDOFF'})
    const mails=rig.sql(`SELECT recipient_name FROM ot.mail WHERE id>${since} AND sender='${name}' AND body LIKE '%PTB-HANDOFF%'`)
    p.check(`${shape}: default docket handoff goes to the real superior/user`,hand.ok&&mails.length===1&&mails[0].recipient_name===(manager??'@user'),{result:hand.text,mails})
    const updated=await rig.tool(name,'orgtree_work',{action:'update',slug:s.slug,status:'deploy_ready',done_so_far:['Ready'],working_on_next:[]})
    if(!updated.ok) throw new Error(updated.text)
    const item=(await rig.api('GET',`/api/orgs/${rig.org}/work-items/${s.slug}`)).item
    p.check(`${shape}: deploy_ready names the agent deployer (or top-level owner)`,item.next_action?.node===(manager??name)&&item.next_action?.role===(manager?'deployer':'owner'),item.next_action)

    // Mail relationship and roster checks use a real turn, not a fabricated view.
    await rig.tool(peer,'orgtree_send_notice',{to:name,body:`PTB-PEER-${shape}`})
    if(manager) await rig.tool(manager,'orgtree_send_notice',{to:name,body:`PTB-SUPERIOR-${shape}`})
    else await rig.userMail(name,'PTB-SUPERIOR-root',{notice:true})
    const prompt=await turn(name,`PTB-CONTEXT-${shape}`)
    p.check(`${shape}: mail identifies the logical peer and immediate superior`,prompt.includes(`FROM ${peer} (your peer)`)&&(!manager||prompt.includes(`FROM ${manager} (your superior)`)),prompt.slice(-4500))
    p.check(`${shape}: user-contact guidance names the agent superior, never a project`,manager?prompt.includes(`direct superior (${manager})`):!prompt.includes('you do not have direct contact with the user'),prompt.slice(0,1700))
    p.check(`${shape}: the roster includes logical peers and excludes projects as reports`,prompt.includes(peer)&&!/^Your reports:.*empty-below-worker/m.test(prompt),prompt.slice(0,1700))
    if(manager) {
      const bossPrompt=await turn(manager,`PTB-ROSTER-${shape}`)
      p.check(`${shape}: the superior's roster names its report through projects`,/^Your reports:.*worker-/m.test(bossPrompt)&&bossPrompt.split('\n').find(l=>l.startsWith('Your reports:'))?.includes(name),bossPrompt.slice(0,1700))
    }
    // Cheap-compaction source is user, so superior suppression (by==recipient)
    // does not mask the notice. Capture only its new handoff header for recall.
    const cm=mark()
    await rig.op({op:'cheap_compact',node:name})
    const cc=notices(cm,'lifecycle.cheap_compacted')
    p.check(`${shape}: cheap compact keeps its own notice and supervisor notice`,cc.some(r=>r.name===name)&&(!manager||cc.some(r=>r.name===manager&&r.ev.relation==='report')),cc)
    const fresh=await turn(name,`PTB-FRESH-${shape}`)
    const hint=fresh.split('Last messages from your current superior')[1]?.split('Older context follows.')[0]??''
    p.check(`${shape}: fresh-session recall includes actual superior's recent mail`,hint.includes(`PTB-SUPERIOR-${shape}`),hint)
    for(const [op,args,variant] of [
      ['reallocate',{delta:1},'access.grant_changed'],
      ['switch_model',{tier:'sonnet'},'lifecycle.model_switched'],
    ]) {
      const cursor=mark();await rig.op({op,node:name,...args})
      const rows=notices(cursor,variant)
      p.check(`${shape}: ${op} tells self and the real superior`,rows.some(r=>r.name===name)&&(!manager||rows.some(r=>r.name===manager)),rows)
    }
  }

  // Same physical parent OFF remains the signed policy exception. A different
  // project with the same supervisor remains reachable without delegation.
  await rig.op({op:'configure_project',node:'inner-nested',settings:{peer_mail:false}})
  await hire('nested-sibling','inner-nested')
  const denied=await rig.tool('worker-nested','orgtree_send_notice',{to:'nested-sibling',body:'PTB blocked'})
  const allowed=await rig.tool('worker-nested','orgtree_send_notice',{to:'peer-nested',body:'PTB allowed'})
  p.check('physical-parent peer-mail OFF exception is preserved',!denied.ok&&allowed.ok,{denied:denied.text,allowed:allowed.text})
  const policyPrompt=await turn('worker-nested','PTB-POLICY')
  p.check('peer-mail policy labels its physical project independently of superior guidance',policyPrompt.includes('Peer mail under inner-nested: OFF')&&policyPrompt.includes('manager-nested'),policyPrompt.slice(0,1800))

  // One real reminder sweep, with synthetic old activity in the scratch DB.
  await settled()
  rig.exec(`UPDATE ot.turns SET started_at=started_at-interval '30 minutes',ended_at=ended_at-interval '30 minutes';
    UPDATE ot.agents SET extra=extra||jsonb_build_object('docket_reminder_at',now()-interval '30 minutes','working_activity_at',now()-interval '30 minutes') WHERE org_id=${org}`)
  await switches(true)
  const reminded=s=>rig.sql(`SELECT m.recipient_name,m.ev FROM ot.mail m WHERE m.org_id=${org} AND m.ev->>'variant'='reminder.idle_docket' AND m.ev->'items' @> '[{"slug":"${s.slug}"}]'::jsonb`)
  await rig.waitFor(()=>shapes.every(s=>reminded(s).length),{what:'deployer reminder sweep',timeout:14000}).catch(()=>null)
  for(const s of shapes) p.check(`${s.shape}: a real idle reminder reaches the computed deployer`,reminded(s).some(r=>r.recipient_name===(s.manager??s.name)),reminded(s))
  await switches(false)

  // Movement leaves structural placement intact but describes the reporting
  // change. Same-superior movement still reaches both physical peer groups.
  for(const s of shapes.filter(s=>s.manager)) {
    const before=mark()
    await rig.op({op:'move',node:s.name,new_parent:'root-inner-destination'}).catch(async e=>{
      if(rig.one(`SELECT id FROM ot.agents WHERE org_id=${org} AND name='root-inner-destination'`)) throw e
      await project('root-inner-destination');await rig.op({op:'move',node:s.name,new_parent:'root-inner-destination'})
    })
    const moved=notices(before,'lifecycle.moved')
    p.check(`${s.shape}: move tells the former real superior and names user destination`,moved.some(r=>r.name===s.manager&&r.ev.role==='old_parent')&&moved.every(r=>r.ev.from_parent===s.manager&&r.ev.to_parent===null),moved)
    await rig.op({op:'move',node:s.name,new_parent:s.parent})
  }
  // Isolated leaves keep retire/rehire notices separate from dissolve behavior.
  for(const s of shapes) {
    const leaf=`leaf-${s.shape}`;await hire(leaf,s.parent)
    let before=mark();await rig.op({op:'retire',node:leaf})
    let rows=notices(before,'lifecycle.retired')
    p.check(`${s.shape}: retire reaches real superior/peer`,(!s.manager||rows.some(r=>r.name===s.manager))&&rows.some(r=>r.name===s.peer),rows)
    before=mark();await rig.op({op:'rehire',node:leaf})
    rows=notices(before,'lifecycle.rehired')
    p.check(`${s.shape}: rehire reaches self and real superior/peer`,rows.some(r=>r.name===leaf)&&(!s.manager||rows.some(r=>r.name===s.manager))&&rows.some(r=>r.name===s.peer),rows)
  }
  p.check('supervisory notices/requests never target project queue rows',rig.sql(`SELECT m.id FROM ot.mail m JOIN ot.agents a ON a.id=m.recipient_agent_id WHERE a.org_id=${org} AND a.kind='project' AND (m.ev->>'variant' LIKE 'lifecycle.%' OR m.sender LIKE 'worker-%')`).length===0)
  p.keep(rig,{agents:shapes.map(s=>s.name),grep:/handoff|reminder|error|panic/})
  return p.summary()
}
