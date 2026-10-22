// Node-generic placement, with agent-only seat swapping and runtime controls.
import {isDeepStrictEqual as same} from 'node:util'
import {Proof} from '../proof.mjs'

export async function setup(){
  return {fixture:{org:{name:'Node placement'},agents:[{name:'boss',tier:'sol',grant:300}]}}
}
export default async function(rig){
  const p=new Proof('node-placement')
  rig.scenario({default:{turns:[{steps:[{text:'OK.'}]}]}})
  const org=rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const node=name=>rig.one(`SELECT a.id,a.name,a.kind,a.state,a.parent_id,a.sibling_order,
    a.seat::float8 AS seat,a.grant_credits::float8 AS grant,a.scope,a.charter,a.team_charter,
    a.halt,a.frozen,a.limit_locked FROM ot.agents a WHERE a.org_id=${org} AND a.name='${name}'`)
  const parent=name=>rig.one(`SELECT p.name FROM ot.agents a LEFT JOIN ot.agents p ON p.id=a.parent_id
    WHERE a.org_id=${org} AND a.name='${name}'`)?.name??null
  const free=name=>rig.one(`SELECT (a.grant_credits-coalesce((SELECT sum(c.seat+c.grant_credits)
    FROM ot.agents c WHERE c.id IN(SELECT ot.reports_of(${org},a.id)) AND c.state='live'),0))::float8 AS n
    FROM ot.agents a WHERE a.org_id=${org} AND a.name='${name}'`).n
  const hire=(name,parent,grant=0)=>rig.op({op:'hire',name,parent,tier:'sol',grant,org_visibility:'full'})
  const project=async(name,parent)=>{await rig.op({op:'create_project',name,parent,description:`Summary ${name}`});await rig.op({op:'configure_project',node:name,settings:{peer_mail:false,slots:2,mail_queue:'ack'}})}
  const attempt=async(fn)=>{try{return {ok:true,value:await fn()}}catch(e){return {ok:false,error:e.message}}}
  const valid=()=>rig.sql(`SELECT a.name FROM ot.agents a WHERE a.org_id=${org} AND a.state='live' AND (
    (a.kind='project' AND (a.seat<>0 OR a.grant_credits<>coalesce((SELECT sum(c.seat+c.grant_credits)
      FROM ot.agents c WHERE c.id IN(SELECT ot.reports_of(${org},a.id)) AND c.state='live'),0))) OR
    (a.kind='agent' AND a.grant_credits<coalesce((SELECT sum(c.seat+c.grant_credits)
      FROM ot.agents c WHERE c.id IN(SELECT ot.reports_of(${org},a.id)) AND c.state='live'),0)))`)

  for(const nested of [false,true]){
    const suffix=nested?'nested':'direct',caller=`caller-${suffix}`,target=`promoted-${suffix}`
    await hire(caller,'boss',35)
    let at=caller
    if(nested){at=`middle-${suffix}`;await hire(at,caller,10)}
    await project(target,at);await hire(`member-${suffix}`,target);await hire(`kept-${suffix}`,caller)
    const setup=node(target),callerFree=free(caller),middleFree=nested?free(at):null,bossFree=free('boss')
    const listener=await rig.tool('boss','orgtree_watchdog',{action:'create',name:`keep-${suffix}`,kind:'project_listener',target,notice:true})
    const listening=node(target)
    p.check(`${suffix}: listener registration enables events without changing other policy`,listener.ok&&setup.scope.event_listeners!==true&&listening.scope.event_listeners===true&&same(listening.scope,{...setup.scope,event_listeners:true}),listening.scope)
    const claim=await rig.tool(`member-${suffix}`,'orgtree_watchdog',{action:'create',name:`hold-${suffix}`,kind:'slot',target,once:true,notice:true})
    const resources=()=>({listeners:rig.sql(`SELECT uid,owner_agent_id,kind,memo->>'target_id' AS target FROM ot.watchdogs WHERE name='keep-${suffix}' AND org_id=${org}`),leases:rig.sql(`SELECT uid,project_id,holder_agent_id FROM ot.slot_leases WHERE project_id=${setup.id} AND ended_at IS NULL`)})
    const owned=resources()
    await rig.userMail(target,'Project queue survives promotion',{notice:true})
    const queue=()=>rig.sql(`SELECT uid,state,recipient_agent_id FROM ot.mail WHERE recipient_agent_id=${setup.id} AND body='Project queue survives promotion'`)
    // Listener registration deliberately enables events. Compare promotion only
    // after all listener, slot and queued-mail fixture setup has completed.
    const before=node(target),queued=queue(),r=await rig.tool(caller,'orgtree_self_subjugate',{target})
    p.check(`${suffix}: a descendant container can take the caller's structural position`,r.ok&&parent(target)==='boss'&&parent(caller)===target,r.text)
    const after=node(target)
    p.check(`${suffix}: promotion retains project identity, policy, Summary and queued mail`,r.ok&&before.id===after.id&&same(before.scope,after.scope)&&before.charter===after.charter&&same(queued,queue()),after)
    p.check(`${suffix}: listeners and held slots keep their project identity`,r.ok&&listener.ok&&claim.ok&&owned.listeners.length===1&&owned.leases.length===1&&same(owned,resources()),owned)
    if(owned.leases[0])await rig.tool(`member-${suffix}`,'orgtree_project',{action:'release_slot',lease:owned.leases[0].uid})
    p.check(`${suffix}: member and caller team identities retain their own branches`,r.ok&&parent(`member-${suffix}`)===target&&parent(`kept-${suffix}`)===caller)
    p.check(`${suffix}: project seat stays zero, mirrors settle and every agent's free credits survive`,r.ok&&after.seat===0&&free(caller)===callerFree&&free('boss')===bossFree&&(!nested||free(at)===middleFree)&&valid().length===0,{invalid:valid(),callerFree:free(caller),middleFree:nested?free(at):null})
  }
  await hire('agent-caller','boss',15);await hire('agent-target','agent-caller',4)
  const agentFree=free('agent-caller'),targetFree=free('agent-target'),agentPromotion=await rig.tool('agent-caller','orgtree_self_subjugate',{target:'agent-target'})
  p.check('agent descendant promotion retains existing seat and free-credit behaviour',agentPromotion.ok&&parent('agent-target')==='boss'&&parent('agent-caller')==='agent-target'&&free('agent-caller')===agentFree&&free('agent-target')===targetFree&&valid().length===0,agentPromotion.text)
  await project('unrelated','boss')
  const beforeOut=node('unrelated'),outside=await rig.tool('caller-direct','orgtree_self_subjugate',{target:'unrelated'})
  p.check('promotion cannot pull an unrelated container into the caller chain',!outside.ok&&same(node('unrelated'),beforeOut),outside.text)

  await hire('restorer','boss',45);await project('old-place','restorer');await project('new-place','restorer')
  for(const mode of ['parent','target','superior','root']){
    const name=`restore-${mode}`;await project(name,'old-place');await hire(`archived-${mode}`,name)
    await rig.op({op:'dissolve',node:name});const before=node(name)
    const request={node:name,...(mode==='superior'?{hire_type:'superior',target:'new-place'}:mode==='root'?{parent:'@user'}:{[mode]:'new-place'})}
    const r=mode==='root'?await attempt(()=>rig.op({op:'rehire',...request})):await rig.tool('restorer','orgtree_rehire',request)
    const expected=mode==='superior'?'restorer':mode==='root'?null:'new-place'
    p.check(`${mode}: project restoration honours requested placement`,r.ok&&node(name).state==='live'&&parent(name)===expected,r.text??r.error??r.value)
    p.check(`${mode}: restored project keeps policy and leaves its old retired agents retired`,r.ok&&same(node(name).scope,before.scope)&&node(name).charter===before.charter&&node(`archived-${mode}`).state==='archived'&&valid().length===0)
    if(mode==='superior')p.check('restoring above a live container inserts it without moving the bottom member group',r.ok&&parent('new-place')===name)
  }
  await project('restore-invalid','old-place');await rig.op({op:'retire',node:'restore-invalid'})
  const invalidBefore=node('restore-invalid')
  const denied=await rig.tool('caller-direct','orgtree_rehire',{node:'restore-invalid',parent:'new-place'})
  const cycle=await attempt(()=>rig.op({op:'rehire',node:'restore-invalid',parent:'restore-invalid'}))
  const meaningless=await attempt(()=>rig.op({op:'rehire',node:'restore-invalid',tier:'sol'}))
  p.check('restore authority and cycle errors are atomic',!denied.ok&&!cycle.ok&&same(node('restore-invalid'),invalidBefore),{denied:denied.text,cycle})
  p.check('restoring a project refuses model fields instead of silently ignoring them',!meaningless.ok&&/project/i.test(meaningless.error??'')&&same(node('restore-invalid'),invalidBefore),meaningless)
  const liveRelocate=await attempt(()=>rig.op({op:'rehire',node:'new-place',parent:'old-place'}))
  p.check('already-live project restoration does not silently ignore placement',!liveRelocate.ok&&/live|move/i.test(liveRelocate.error??''),liveRelocate)
  await hire('restore-agent','old-place');await rig.op({op:'retire',node:'restore-agent'})
  const agentRestore=await rig.tool('restorer','orgtree_rehire',{node:'restore-agent',parent:'new-place'})
  p.check('agent restoration retains explicit-parent placement through the shared validator',agentRestore.ok&&parent('restore-agent')==='new-place'&&valid().length===0,agentRestore.text)

  await project('control-container','boss');await hire('control-agent','boss')
  const original=node('control-container'),originalAgent=node('control-agent')
  for(const tool of ['orgtree_interrupt','orgtree_halt','orgtree_unhalt','orgtree_unstick','orgtree_continue_on','orgtree_compact','orgtree_cheap_compact']){
    const r=await rig.tool('boss',tool,{node:'control-container',account:'openai/primary'})
    p.check(`${tool}: clear refusal for a container with no turns`,!r.ok&&/project|no runtime|no.*turn|not an agent/i.test(r.text)&&!/did not answer|runtime is stopping/i.test(r.text),r.text)
  }
  const mixed=await rig.tool('boss','orgtree_halt',{nodes:['control-agent','control-container']})
  p.check('mixed halt validates every node capability before any agent is halted',!mixed.ok&&same(node('control-agent').halt,originalAgent.halt),mixed.text)
  const apiBase=`/api/orgs/${rig.org}/nodes/control-container`
  for(const [route,body] of [['interrupt',{}],['halt',{}],['unhalt',{}],['compact',{}],['process',{action:'start'}],['process',{action:'stop'}],['unstick',{}],['continue-on',{account:'openai/primary'}]]){
    const r=await attempt(()=>rig.api('POST',`${apiBase}/${route}`,body))
    p.check(`HTTP ${route}${body.action?'/'+body.action:''}: clear project runtime refusal`,!r.ok&&/project|no runtime|no.*turn|not an agent/i.test(r.error??'')&&!/did not answer|runtime is stopping/i.test(r.error??''),r)
  }
  p.check('rejected runtime controls do not mutate project policy or runtime state',same(node('control-container'),original))
  const swap=await attempt(()=>rig.op({op:'swap',a:'control-container',b:'new-place'}))
  p.check('signed exception: seat swap remains agent-only',!swap.ok&&/project|agent/i.test(swap.error??''),swap)
  await rig.op({op:'move',node:'unrelated',new_parent:'restorer'})
  await rig.op({op:'reorder',node:'unrelated',index:0})
  p.check('existing generic move and sibling reorder remain available for containers',parent('unrelated')==='restorer'&&valid().length===0)
  p.keep(rig,{agents:[],grep:/self_subjugate|rehire|project.*actor|error/})
  p.file('placement-snapshot.json',rig.sql(`SELECT a.name,a.kind,p.name AS parent,a.scope,a.charter,a.seat::float8,a.grant_credits::float8 FROM ot.agents a LEFT JOIN ot.agents p ON p.id=a.parent_id WHERE a.org_id=${org} AND a.state='live' ORDER BY a.id`))
  return p.summary()
}
