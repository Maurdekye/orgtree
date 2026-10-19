// User 2026-10-19: policy changes from above/user; member operations retain reach.
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual as same } from 'node:util'
import { Proof } from '../proof.mjs'

export async function setup() {
  return {recover:true,fixture:{org:{name:'Project policy authority'},agents:[{name:'boss',tier:'sol',grant:100}]}}
}
export default async function(rig) {
  const p=new Proof('project-policy-authority')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  const org=rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const id=n=>rig.agentRow(n).id
  const project=(name,parent)=>rig.op({op:'create_project',name,...(parent?{parent}:{})})
  const hire=(name,parent,grant=0)=>rig.op({op:'hire',name,parent,tier:'sol',grant,org_visibility:'full'})
  const call=(who,args)=>rig.tool(who,'orgtree_project',{name:'policy',...args})
  const dog=(who,args)=>rig.tool(who,'orgtree_watchdog',args)
  const base={name:'policy',description:'Original Summary.',peer_mail:false,slots:1,mail_queue:'round_robin',exclude_sender:false,
    ack_timeout:true,max_attempts:3,ack_reminders:3,turn_end_reminder:true}
  await hire('manager','boss',30);await project('policy','manager');await project('sibling','manager')
  await hire('member','policy');await project('nested','policy');await hire('nested-member','nested')
  await hire('outsider','boss')
  await rig.op({op:'configure_project',node:'policy',settings:base})
  const pid=id('policy')
  const row=()=>rig.one(`SELECT name,charter,scope,sibling_order,row_version FROM ot.agents WHERE id=${pid}`)
  const pending=()=>rig.sql(`SELECT uid,state,extra FROM ot.mail WHERE recipient_agent_id=${pid} ORDER BY id`)
  const restore=async()=>{
    await rig.op({op:'configure_project',node:row().name,settings:base})
    await rig.op({op:'reorder',node:'policy',index:0})
  }
  const patches={description:'Member changed Summary',peer_mail:true,slots:7,mail_queue:'ack',exclude_sender:true,
    ack_timeout:false,max_attempts:7,ack_reminders:7,turn_end_reminder:false,name:'member-renamed'}
  for(const who of ['member','nested-member']) {
    for(const [field,value] of Object.entries(patches)) {
      const before=row()
      const r=await call(who,{action:'configure',settings:{[field]:value}})
      p.check(`${who}: ${field} patch is refused without changing the project`,!r.ok&&same(row(),before),r.json??r.text)
      if(r.ok) await restore()
    }
    for(const [label,fn] of [
      ['describe write',()=>call(who,{action:'describe',description:'Member wrote directly'})],
      ['describe clear',()=>call(who,{action:'describe',description:''})],
      ['rename tool',()=>rig.tool(who,'orgtree_rename',{node:'policy',name:'member-renamed'})],
      ['reorder tool',()=>rig.tool(who,'orgtree_reorder',{node:'policy',index:1})],
    ]) {
      const before=row(),r=await fn()
      p.check(`${who}: ${label} is refused atomically`,!r.ok&&same(row(),before),r.json??r.text)
      if(r.ok) await restore()
    }
    await rig.userMail('policy',`Waiting mail for ${who}`,{notice:true})
    const before=pending(),r=await call(who,{action:'purge_waiting'})
    p.check(`${who}: purge waiting mail is refused without changing mail`,!r.ok&&same(pending(),before),r.json??r.text)
  }
  const outsider=await call('outsider',{action:'configure',settings:{slots:2}})
  p.check('unrelated agents remain outside project policy authority',!outsider.ok,outsider.text)

  for(const who of ['manager','boss']) {
    const changed={...base,description:`Allowed ${who} Summary.`,slots:2,mail_queue:'ack',max_attempts:5,ack_reminders:4,peer_mail:true}
    const r=await call(who,{action:'configure',settings:changed})
    const order=await rig.tool(who,'orgtree_reorder',{node:'policy',index:1})
    const rename=await rig.tool(who,'orgtree_rename',{node:'policy',name:'ancestor-renamed'})
    const purge=await call(who,{action:'purge_waiting',name:row().name})
    p.check(`${who}: nearest and farther ancestors retain policy, rename, order and purge authority`,r.ok&&order.ok&&rename.ok&&purge.ok,{r:r.json??r.text,order:order.text,rename:rename.text,purge:purge.text})
    await restore()
  }
  await project('root-policy');await hire('root-member','root-policy')
  const root=await call('root-member',{action:'configure',name:'root-policy',settings:{slots:2}})
  p.check('a root-project member has top-level agent rights but cannot edit its project policy',!root.ok,root.text)
  const user=await rig.op({op:'configure_project',node:'root-policy',settings:{description:'User policy.',slots:2,peer_mail:false}})
  p.check('the user can edit root project policy',user.settings?.description==='User policy.'&&user.settings?.slots===2,user)

  // Operational controls still work for direct and nested members without a user audience.
  for(const who of ['member','nested-member']) {
    const settings=await call(who,{action:'settings'}),description=await call(who,{action:'describe'})
    p.check(`${who}: settings and Summary remain readable`,settings.ok&&settings.json.settings.description===base.description&&description.ok&&description.json.description===base.description)
    const sent=await rig.tool(who,'orgtree_message',{metadata:{to:'policy',notice:true},body:`Operational mail ${who}`})
    const inbox=await rig.tool(who,'orgtree_inbox',{action:'list',project:'policy'})
    p.check(`${who}: project mail and inbox remain usable`,sent.ok&&inbox.ok,{sent:sent.text,inbox:inbox.text})
    const fq=await dog(who,{action:'create',kind:'fair_queue',name:'policy-queue',target:'policy',once:true,notice:true})
    p.check(`${who}: fair-queue claims remain usable`,fq.ok,fq.text)
    if(fq.ok) await dog(who,{action:'remove',id:'policy-queue'})
    const claim=await dog(who,{action:'create',kind:'slot',name:'policy-slot',target:'policy',once:true,notice:true})
    const lease=rig.one(`SELECT uid FROM ot.slot_leases WHERE project_id=${pid} AND holder_agent_id=${id(who)} AND ended_at IS NULL`)
    const released=lease?await call(who,{action:'release_slot',lease:lease.uid}):{ok:false,text:'No lease'}
    p.check(`${who}: own slot claim and release remain usable`,claim.ok&&released.ok,{claim:claim.text,release:released.text})
    const listener=await dog(who,{action:'create',kind:'project_listener',name:'policy-event',target:'policy',once:true,notice:true})
    const listed=await call(who,{action:'listeners'})
    const fire=await call(who,{action:'fire_event',body:'Member operational event.'})
    p.check(`${who}: event listening, listing and firing remain usable`,listener.ok&&listed.ok&&fire.ok&&fire.json.delivered_to.includes(who),{listener:listener.text,fire:fire.json??fire.text})
    const folder=path.join(rig.data,'scratch',rig.org,'_teams',String(pid));fs.mkdirSync(folder,{recursive:true})
    const file=path.join(folder,`${who}.md`);fs.writeFileSync(file,'Member project presentation.\n')
    const present=await rig.tool(who,'orgtree_present',{project:'policy',title:`Presentation ${who}`,path:file})
    const gallery=await call(who,{action:'presentations'})
    p.check(`${who}: project folder and presentations remain usable`,present.ok&&gallery.ok,{present:present.text,gallery:gallery.text})
    const uids=[`${who}-retry`,`${who}-drop`]
    for(const uid of uids) rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,recipient_kind,recipient_agent_id,recipient_name,body,notice,state,extra)
      VALUES('${uid}',${org},'@user','agent',${pid},'policy','Synthetic dead letter',true,'read','{"dead_letter":{"why":"fixture","attempts":3}}')`)
    const letters=await call(who,{action:'dead_letters'})
    const retry=await call(who,{action:'retry_dead_letter',id:uids[0]})
    const drop=await call(who,{action:'drop_dead_letter',id:uids[1],reason:'Synthetic obsolete job.'})
    p.check(`${who}: dead-letter list, retry and drop remain usable`,letters.ok&&retry.ok&&drop.ok,{letters:letters.text,retry:retry.text,drop:drop.text})
  }
  p.keep(rig,{agents:[],grep:/project|Forbidden|configure/})
  return p.summary()
}
