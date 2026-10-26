// Explicit narrow real-PG author proof for background panels (USER 2026-10-26):
// persisted execution intent across an engine restart, Hide/Show/Start/Power off,
// generation-fenced host sessions, Stop all, the provisional code-change rule and
// the desktop runtime listing. Fake CLIs, isolated data; no desktop window runs.
import assert from 'node:assert/strict'
import {isDeepStrictEqual} from 'node:util'
import {Proof} from '../proof.mjs'

export function setup(){return{fixture:{org:{name:'Background panels proof'},agents:[
  {name:'boss',tier:'sol',grant:50,charter:'Synthetic background panels proof only.'},
]}}}
export default async function(rig){
  const p=new Proof('app-background'),same=isDeepStrictEqual,org=rig.org,root='/api/orgs/'+org
  const apps=input=>rig.api('POST',root+'/apps',input),bridge=input=>rig.api('POST',root+'/apps/bridge',input)
  const native=input=>rig.api('POST',root+'/apps/runtime',input)
  const tool=async input=>{const r=await rig.tool('boss','orgtree_apps',input);assert(r.ok,r.text);return r.json}
  const refusal=async fn=>{try{await fn();return{status:200}}catch(e){if(!e.status)throw e;return{status:e.status,detail:String(e.body?.detail??e.body).slice(0,200)}}}
  const panel=id=>apps({action:'panel_get',panel:id})
  const flags=x=>({open:x.open,running:x.running,run_generation:x.run_generation})
  const power=async id=>(await apps({action:'events',panel:id})).events.filter(e=>/^panel\.(started|stopped)$/.test(e.name)).map(e=>({name:e.name,reason:e.payload?.reason??null,actor:e.actor}))
  const orgId=rig.one(`SELECT id FROM ot.orgs WHERE slug='${org}'`).id
  const schema=rig.one(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='ot' AND table_name='custom_panels' AND column_name='is_running') AS running,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='ot' AND table_name='custom_panels' AND column_name='run_generation') AS generation,EXISTS(SELECT 1 FROM pg_constraint WHERE conname='custom_panel_visible_running') AS invariant`)
  p.check('migration 0067 adds execution intent, generation and the visible-implies-running CHECK',Object.values(schema).every(Boolean),schema)

  const definition={name:'Background clock',description:'Synthetic background proof',html:'<p>Clock</p>',initial_state:{ticks:0},events:[{name:'tick'}],capabilities:['org.read','events.fire'],width:320,height:240}
  const app=await tool({action:'app_create',definition});assert(app?.id)
  const allow=async(cap,permission)=>{const a=await apps({action:'app_get',app:app.id});return apps({action:'permission_set',app:a.id,expected_rev:a.rev,expected_permission_rev:a.permission_rev,capability:cap,permission})}
  await allow('org.read','allow');await allow('events.fire','ask')

  // Open and Hide: the user's open starts a visible copy; Hide keeps its runtime.
  let v=await panel((await apps({action:'panel_open',app:app.id,new:true,label:'Visible'})).id)
  const g1=v.run_generation
  p.check('user open starts a visible running copy',v.open===true&&v.running===true&&g1>=1,flags(v))
  const host=await bridge({action:'session_open',panel:v.id,generation:g1})
  v=await apps({action:'panel_update',panel:v.id,expected_rev:v.rev,open:false})
  const read=await bridge({action:'call',session:host.session,request:{action:'org.read',limit:1}})
  p.check('Hide keeps the copy running with the same generation and host session',v.open===false&&v.running===true&&v.run_generation===g1&&host.run_generation===g1&&read.items?.length===1,flags(v))
  const hiddenAsk=await refusal(()=>bridge({action:'call',session:host.session,request:{action:'events.fire',name:'tick',payload:{n:1}}}))
  p.check('a hidden copy never raises a permission prompt (409 interaction_required)',hiddenAsk.status===409&&/interaction_required/.test(hiddenAsk.detail),hiddenAsk)
  await apps({action:'panel_open',panel:v.id});v=await panel(v.id)
  const shownAsk=await bridge({action:'call',session:host.session,request:{action:'events.fire',name:'tick',payload:{n:2}}})
  p.check('Show reveals the same runtime: generation and session survive, and the visible copy may prompt',v.open&&v.running&&v.run_generation===g1&&!!shownAsk.permission_required,flags(v))
  let invariant={refused:false}
  try{rig.exec(`UPDATE ot.custom_panels SET is_running=false WHERE org_id=${orgId} AND id='${v.id}'`)}catch(e){invariant={refused:/custom_panel_visible_running/.test(e.message),message:e.message.slice(0,240)}}
  p.check('the database refuses a visible copy that is not running',invariant.refused&&(await panel(v.id)).running===true,invariant)

  // Agents start any copy hidden and power copies off, but never show one.
  let h=await tool({action:'panel_open',app:app.id,new:true,label:'Hidden'})
  const h0=h.run_generation
  p.check('agent-created copies stay closed and off',h.open===false&&h.running===false,flags(h))
  h=await tool({action:'panel_start',panel:h.id,expected_rev:h.rev})
  p.check('agent panel_start runs a copy hidden with a new generation',h.open===false&&h.running===true&&h.run_generation===h0+1,flags(h))
  const again=await tool({action:'panel_start',panel:h.id,expected_rev:h.rev})
  p.check('starting a running copy changes nothing',again.rev===h.rev&&again.run_generation===h.run_generation)
  const show=await rig.tool('boss','orgtree_apps',{action:'panel_open',panel:h.id}),showUpdate=await rig.tool('boss','orgtree_apps',{action:'panel_update',panel:h.id,expected_rev:h.rev,open:true})
  p.check('agents cannot show a window',!show.ok&&!showUpdate.ok&&!(await panel(h.id)).open,{show:show.text?.slice(0,160),update:showUpdate.text?.slice(0,160)})
  const hs=await bridge({action:'session_open',panel:h.id})
  const staleOpen=await refusal(()=>bridge({action:'session_open',panel:h.id,generation:h.run_generation-1}))
  p.check('session_open binds the current generation and refuses a stale one (409)',hs.run_generation===h.run_generation&&staleOpen.status===409,staleOpen)
  h=await tool({action:'panel_stop',panel:h.id,expected_rev:h.rev})
  const late=await refusal(()=>bridge({action:'call',session:hs.session,request:{action:'org.read',limit:1}})),stoppedOpen=await refusal(()=>bridge({action:'session_open',panel:h.id}))
  p.check('agent panel_stop powers off, hides, bumps the generation and ends host sessions',!h.open&&!h.running&&h.run_generation===h0+2&&late.status===403&&stoppedOpen.status===409,{flags:flags(h),late,stoppedOpen})
  h=await tool({action:'panel_start',panel:h.id,expected_rev:h.rev})
  const restartedLate=await refusal(()=>bridge({action:'call',session:hs.session,request:{action:'org.read',limit:1}}))
  p.check('a copy started again keeps refusing its earlier session',h.running&&h.run_generation===h0+3&&restartedLate.status===403,restartedLate)
  // Power changes carry no data; a running copy's own saves keep bumping its revision.
  const seen=await panel(h.id);await apps({action:'state_patch',panel:h.id,expected_rev:seen.rev,patch:{ticks:1}})
  const staleStop=await rig.tool('boss','orgtree_apps',{action:'panel_stop',panel:h.id,expected_rev:seen.rev})
  const unrevStop=await tool({action:'panel_stop',panel:h.id});h=await tool({action:'panel_start',panel:h.id})
  p.check('after a state save a stale expected_rev refuses, while power changes without one apply',!staleStop.ok&&/revision/.test(staleStop.text)&&!unrevStop.running&&h.running&&!h.open&&h.run_generation===h0+5,{stale:staleStop.text?.slice(0,160),stopped:flags(unrevStop),started:flags(h)})
  const userCopy=await panel((await apps({action:'panel_duplicate',panel:v.id,expected_rev:(await panel(v.id)).rev})).id)
  const agentCopy=await panel((await tool({action:'panel_duplicate',panel:v.id,expected_rev:(await panel(v.id)).rev})).id)
  p.check('user duplicates open and run; agent duplicates stay closed and off',userCopy.open&&userCopy.running&&!agentCopy.open&&!agentCopy.running,{user:flags(userCopy),agent:flags(agentCopy)})
  const runningList=await apps({action:'list',kind:'panels',running:true}),offList=await apps({action:'list',kind:'panels',running:false})
  p.check('list kind:panels filters running and powered-off copies',same(runningList.items.map(x=>x.id).sort(),[v.id,h.id,userCopy.id].sort())&&offList.items.some(x=>x.id===agentCopy.id)&&offList.items.every(x=>!x.running))

  // Restart: saved intent survives exactly; leases do not.
  const watched={Visible:v.id,Hidden:h.id,Off:agentCopy.id}
  const snapshot=async()=>Object.fromEntries(await Promise.all(Object.entries(watched).map(async([k,id])=>[k,flags(await panel(id))])))
  const before=await snapshot();await rig.restart();const after=await snapshot()
  p.file('restart-states.json',{before,after})
  p.check('engine restart restores each copy exactly: visible running, hidden running, off',same(before,after)&&before.Visible.open&&before.Visible.running&&!before.Hidden.open&&before.Hidden.running&&!before.Off.open&&!before.Off.running,{before,after})
  let rt=await tool({action:'runtime'});let by=Object.fromEntries(rt.items.map(i=>[i.panel,i]))
  p.check('after a restart running copies list as not hosted until a desktop window heartbeats',by[v.id]?.status==='not hosted'&&by[h.id]?.status==='not hosted'&&!by[agentCopy.id],rt.items)

  // Desktop leases and on-demand CPU.
  v=await panel(v.id);h=await panel(h.id)
  const owner='window-proof-0001',other='window-proof-0002'
  const bearer=await fetch(rig.url+root+'/apps/runtime',{method:'POST',headers:{authorization:'Bearer '+rig.token,'Content-Type':'application/json'},body:JSON.stringify({action:'heartbeat',owner,hosts:[]})})
  p.check('the runtime route refuses the root bearer without the desktop header',bearer.status===403,{status:bearer.status})
  let hb=await native({action:'heartbeat',owner,hosts:[{panel:v.id,generation:v.run_generation},{panel:h.id,generation:h.run_generation-1}]})
  p.check('a heartbeat leases the current generation and returns a stale one to stop',hb.lease_ms===20000&&same(hb.stop,[h.id]),hb)
  const dup=await native({action:'heartbeat',owner:other,hosts:[{panel:v.id,generation:v.run_generation}]})
  p.check('a second window hosting the same generation is told to stop',same(dup.stop,[v.id]),dup)
  hb=await native({action:'heartbeat',owner,hosts:[{panel:v.id,generation:v.run_generation},{panel:h.id,generation:h.run_generation,error:'synthetic host error'}]})
  rt=await tool({action:'runtime'});by=Object.fromEntries(rt.items.map(i=>[i.panel,i]))
  p.check('agent runtime listing reports hosted, error and visibility per copy',same(hb.stop,[])&&by[v.id]?.status==='running'&&by[v.id]?.visible===true&&by[h.id]?.status==='error'&&by[h.id]?.error==='synthetic host error'&&by[h.id]?.visible===false&&by[v.id]?.cpu_percent==null,rt.items)
  const hosts=[{panel:v.id,generation:v.run_generation},{panel:h.id,generation:h.run_generation}]
  const pending=tool({action:'runtime',sample:true})
  const epoch=await rig.waitFor(async()=>{const r=await native({action:'heartbeat',owner,hosts});return r.sample_epoch>hb.sample_epoch?r.sample_epoch:null},{what:'the sample request epoch',timeout:2500,every:50})
  const foreign=await native({action:'report',owner:other,epoch,samples:[{panel:v.id,generation:v.run_generation,cpu_percent:99,method:'sampled CPU'}]})
  const reported=await native({action:'report',owner,epoch,samples:[{panel:v.id,generation:v.run_generation,cpu_percent:12.5,method:'sampled CPU'},{panel:h.id,generation:h.run_generation,cpu_percent:40,method:'shared process CPU'}]})
  const sampled=await pending;by=Object.fromEntries(sampled.items.map(i=>[i.panel,i]))
  p.file('runtime-sample.json',sampled)
  p.check('sample:true waits for the owning window and returns per-copy CPU with its method',sampled.sampled===true&&foreign.reported===0&&reported.reported===2&&by[v.id]?.cpu_percent===12.5&&by[v.id]?.cpu_method==='sampled CPU'&&by[h.id]?.cpu_percent===40&&by[h.id]?.cpu_method==='shared process CPU'&&!!by[v.id]?.measured_at,{sampled:sampled.sampled,foreign,reported})
  const badMethod=await refusal(()=>native({action:'report',owner,epoch,samples:[{panel:v.id,generation:v.run_generation,cpu_percent:1,method:'guessed'}]}))
  p.check('reports with an unknown CPU method refuse (400)',badMethod.status===400,badMethod)
  await native({action:'release',owner,panels:[v.id]})
  rt=await tool({action:'runtime'});by=Object.fromEntries(rt.items.map(i=>[i.panel,i]))
  p.check('release ends the lease without stopping the copy',by[v.id]?.status==='not hosted'&&(await panel(v.id)).running===true)

  // PROVISIONAL (not a user ruling): new code reloads visible copies and powers off hidden ones.
  const [vb,hb2]=[await panel(v.id),await panel(h.id)];const a=await apps({action:'app_get',app:app.id})
  await apps({action:'app_update',app:app.id,expected_rev:a.rev,definition:{...definition,description:'Updated code'}})
  const [va,ha]=[await panel(v.id),await panel(h.id)]
  p.check('PROVISIONAL code change: visible copies run the new code, hidden running copies power off',va.open&&va.running&&va.run_generation===vb.run_generation+1&&!ha.open&&!ha.running&&ha.run_generation===hb2.run_generation+1,{visible:[flags(vb),flags(va)],hidden:[flags(hb2),flags(ha)]})

  // Stop all powers off every copy, hidden ones included; release starts nothing.
  h=await tool({action:'panel_start',panel:h.id,expected_rev:ha.rev})
  const live=rig.one(`SELECT count(*)::int AS n FROM ot.custom_panels WHERE org_id=${orgId} AND (is_running OR is_open)`).n
  const ks=await rig.api('POST',root+'/killswitch')
  const rows=rig.sql(`SELECT id,is_open,is_running FROM ot.custom_panels WHERE org_id=${orgId} ORDER BY id`)
  p.check('Stop all powers off every copy, hidden ones included',live>=3&&ks.panels_stopped===live&&rows.every(r=>!r.is_open&&!r.is_running),{live,ks,rows})
  const latchedStart=await rig.tool('boss','orgtree_apps',{action:'panel_start',panel:h.id,expected_rev:(await panel(h.id)).rev})
  const latchedOpen=await refusal(()=>apps({action:'panel_open',panel:v.id}))
  p.check('while Stop all is latched, starting and opening refuse',!latchedStart.ok&&/Stop all/.test(latchedStart.text)&&latchedOpen.status===409,{start:latchedStart.text?.slice(0,160),open:latchedOpen})
  const released=await rig.api('POST',root+'/killswitch/release')
  const runningAfter=rig.one(`SELECT count(*)::int AS n FROM ot.custom_panels WHERE org_id=${orgId} AND is_running`).n
  p.check('releasing Stop all starts nothing',released.released===true&&runningAfter===0,{released,runningAfter})
  const history=await power(h.id);p.file('hidden-copy-history.json',history)
  const reasons=history.filter(e=>e.name==='panel.stopped').map(e=>e.reason)
  p.check('History records panel.started/panel.stopped with code-change and Stop all reasons',history.some(e=>e.name==='panel.started')&&reasons.includes('code changed')&&reasons.includes('stop all')&&reasons.includes(null),history)
  return p.summary()
}
