// Agent visibility and authority are invariant under inserted project edges.
import { Proof } from '../proof.mjs'
import fs from 'node:fs'
import path from 'node:path'

export async function setup() {
  return { fixture:{org:{name:'Project access relations'},agents:[{name:'boss',tier:'sol',grant:1000}]} }
}
export default async function(rig) {
  const p=new Proof('project-access-relations')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  const org=rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const id=n=>rig.agentRow(n).id
  const project=(name,parent)=>rig.op({op:'create_project',name,...(parent?{parent}:{})})
  const hire=(name,parent,grant=0)=>rig.op({op:'hire',name,...(parent?{parent}:{}),tier:'sol',grant,org_visibility:'full'})
  const aud=(who,args)=>rig.tool(who,'orgtree_audience',args)
  const inspect=(who,node)=>rig.tool(who,'orgtree_state_inspect',{node})
  await rig.op({op:'retool',node:'boss',org_visibility:'full'})
  await hire('outsider',null,10)
  const events=[]
  for(const shape of ['direct','one','nested','root','empty']) {
    let parent=shape==='root'?null:'boss'
    const wrappers=[]
    if(['one','nested','root'].includes(shape)) {
      const outer=`outer-${shape}`;await project(outer,parent);parent=outer;wrappers.push(outer)
      if(shape!=='one') {const inner=`inner-${shape}`;await project(inner,parent);parent=inner;wrappers.push(inner)}
    }
    const who=`owner-${shape}`,child=`child-${shape}`,peer=`peer-${shape}`
    await hire(who,parent,40)
    await hire(peer,shape==='root'?null:'boss',4)
    await project(`reports-${shape}`,who);await hire(child,`reports-${shape}`,8)
    await hire(`grand-${shape}`,child)
    if(shape==='empty') await project('empty-wrapper',who)
    await rig.op({op:'retool',node:who,org_visibility:'self'})
    const own=await rig.tool(who,'orgtree_chart',{})
    p.check(`${shape}: self chart sees first agent reports through projects`,own.ok&&own.text.includes(child)&&!own.text.includes(`grand-${shape}`),own.text)
    await rig.op({op:'retool',node:who,org_visibility:'team'})
    const chart=await rig.tool(who,'orgtree_chart',{})
    const state=await inspect(who,peer)
    p.check(`${shape}: team chart includes real superior, peer and first report`,chart.ok&&chart.text.includes(peer)&&chart.text.includes(child)&&(shape==='root'||chart.text.includes('boss')),chart.text)
    p.check(`${shape}: state inspection includes the reporting peer`,state.ok,state.text)
    const eventName=`event-peer-${shape}`,dogName=`peer-dog-${shape}`
    const dog=await rig.tool(who,'orgtree_watchdog',{action:'create',name:dogName,kind:'event',target:'agent.hired',pattern:eventName,once:true,notice:true})
    p.check(`${shape}: team event watcher arms`,dog.ok,dog.text)
    await hire(eventName,shape==='root'?null:'boss')
    events.push({who,dogName,eventName})
    await rig.op({op:'retool',node:who,org_visibility:'full'})
    const full=await rig.tool(who,'orgtree_chart',{})
    const count=await rig.tool(who,'orgtree_watchdog',{action:'create',name:'org-count',kind:'event',target:'agents.live',event_scope:'org',threshold:'at least 99999',notice:true})
    p.check(`${shape}: projects do not cap full chart or organization event access`,full.ok&&full.text.includes('outsider')&&count.ok,{chart:full.text,count:count.text})
    if(count.ok) await rig.tool(who,'orgtree_watchdog',{action:'remove',id:'org-count'})
    const peerGrant=await aud(who,{action:'grant',from:child,target:peer})
    const superiorGrant=shape==='root'?{ok:true}:await aud(who,{action:'grant',from:child,target:'boss'})
    p.check(`${shape}: an agent grants its report an audience with its own peer/superior`,peerGrant.ok&&superiorGrant.ok,{peer:peerGrant.text,superior:superiorGrant.text})
    if(shape==='root') {
      const grant=await aud(who,{action:'grant',from:child,target:'user'})
      const revoke=await aud(who,{action:'revoke',grantee:child,target:'user'})
      const inbox=await aud(who,{action:'grant',from:who,target:'extern'})
      p.check('root: top-level audience grant/revoke and org-inbox authority survive wrappers',grant.ok&&revoke.ok&&inbox.ok,{grant:grant.text,revoke:revoke.text,inbox:inbox.text})
      if(inbox.ok) await aud(who,{action:'revoke',grantee:who,target:'extern'})
      const made=await rig.tool(who,'orgtree_work',{action:'create',title:'Root project disposable item',objective:'Synthetic top-level deletion proof.'})
      const deleted=made.ok?await rig.tool(who,'orgtree_work',{action:'delete',slug:made.json.slug}):made
      p.check('root: a top-level owner retains docket deletion authority',deleted.ok,deleted.text)
    }
    if(wrappers.length) {
      // Even an old damaged row cannot become a permission or visibility cap.
      rig.exec(`UPDATE ot.agents SET scope=scope||'{"org_visibility":"self","tools":{"orgtree":{"inspection":false}}}'::jsonb WHERE id=${id(wrappers[0])}`)
      const damaged=await rig.tool(who,'orgtree_chart',{})
      p.check(`${shape}: project kind overrides stale agent permission fields`,damaged.ok&&damaged.text.includes('outsider'),damaged.text)
      rig.exec(`UPDATE ot.agents SET scope=scope-'org_visibility'-'tools' WHERE id=${id(wrappers[0])}`)
    }
  }
  const fires=e=>rig.sql(`SELECT body FROM ot.mail WHERE recipient_agent_id=${id(e.who)} AND sender='${e.dogName}' AND kind='watchdog'`)
  await rig.waitFor(()=>events.every(e=>fires(e).some(m=>m.body.includes(e.eventName))),{what:'reporting-peer events delivered',timeout:8000}).catch(()=>{})
  for(const e of events) p.check(`${e.who}: reporting-peer event reaches the watcher`,fires(e).some(m=>m.body.includes(e.eventName)),fires(e))

  // Keep the signed physical-sibling delegation exception narrow.
  await project('delegate-a','boss');await project('delegate-b','boss')
  await hire('delegate-one','delegate-a');await hire('delegate-two','delegate-a');await hire('delegate-other','delegate-b')
  const same=await aud('boss',{action:'grant',from:'delegate-one',target:'delegate-two'})
  const different=await aud('boss',{action:'grant',from:'delegate-one',target:'delegate-other'})
  p.check('delegation remains allowed only between the same physical siblings',same.ok&&!different.ok,{same:same.text,different:different.text})
  // A real agent's permission ceiling must still apply.
  await rig.op({op:'retool',node:'owner-nested',tools:{orgtree:{inspection:false}}})
  const clamped=await rig.tool('child-nested','orgtree_chart',{})
  p.check('real agent permission clamps remain binding',!clamped.ok,clamped.text)

  // Revoked org-folder grants must not reappear on a top-level project agent.
  const dir=path.join(rig.data,'revoked-folder');fs.mkdirSync(dir,{recursive:true})
  const settings=s=>rig.api('POST',`/api/orgs/${rig.org}/settings`,s)
  await settings({dirs:[{path:dir,mode:'rw'}]})
  await rig.op({op:'retool',node:'owner-root',add_dirs:[{path:dir,mode:'rw'}]})
  await settings({dirs:[{path:dir,mode:'ro'}]})
  const ownDir=()=>rig.one(`SELECT scope FROM ot.agents WHERE id=${id('owner-root')}`).scope.add_dirs?.find(d=>d.path.replaceAll('\\','/').toLowerCase()===dir.replaceAll('\\','/').toLowerCase())
  p.check('root: org folder downgrade persists on the top agent',ownDir()?.mode==='ro',ownDir())
  await settings({dirs:[]});await settings({dirs:[{path:dir,mode:'rw'}]})
  p.check('root: removed org folder stays revoked when the org re-adds it',!ownDir(),ownDir())

  // Local synthetic org only: no real outside party or network traffic.
  const other=(await rig.api('POST','/api/orgs',{name:'Project Inbox Target',dirs:[],net_autoconnect:false})).slug
  await rig.op({op:'create_project',name:'root-inbox'},{org:other})
  await rig.op({op:'create_project',name:'nested-inbox',parent:'root-inbox'},{org:other})
  await rig.op({op:'hire',name:'receiver',parent:'nested-inbox',tier:'sol',grant:4},{org:other})
  const send=await rig.tool('owner-root','orgtree_message',{to:`@org:${other}`,body:'PROJECT-EXTERN-PROOF'})
  const received=rig.sql(`SELECT recipient_name FROM ot.mail WHERE body LIKE '%PROJECT-EXTERN-PROOF%' AND recipient_kind='agent'`)
  p.check('root: outbound auto-grant and inbound default routing select real top agents',send.ok&&received.some(m=>m.recipient_name==='receiver'),{send:send.text,received})
  p.keep(rig,{agents:['owner-nested','owner-root'],grep:/audience|watchdog|scope|org.inbox/})
  return p.summary()
}
