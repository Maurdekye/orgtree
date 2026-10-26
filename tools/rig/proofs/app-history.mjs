// Real PG engine, then the real renderer: a copy's History holds only fired
// events agents can listen to and the copy starting and stopping (USER
// 2026-10-26 md6edfebc1975 "make it only for fired events agents can listen to
// and starting / stopping, dont record anything else"; answers mcbcd7b3cb6c0:
// delete old rows on upgrade, keep messages working apart, opening a stopped
// copy is a start). The upgrade is staged by SQL on the rig's own cluster (the
// kind column removed, old rows inserted, migration 0071 unrecorded) and the
// engine restarted so its migration runner applies 0071.
// tools/rig/desktop/app-history.cjs then captures the History tab. Build first
// with tools/rig/app-background-ui.mjs and pass its folder in
// APP_BACKGROUND_BUILD. Session 0 only; fake CLIs; synthetic org only.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'
import {runDesktop} from '../desktop.mjs'
import {REPO} from '../lib.mjs'

const built=process.env.APP_BACKGROUND_BUILD?path.resolve(process.env.APP_BACKGROUND_BUILD):''
export function setup(){
  if(!built||!fs.existsSync(path.join(built,'ui','index.html')))throw Error('set APP_BACKGROUND_BUILD to the output of tools/rig/app-background-ui.mjs')
  return{ui:path.join(built,'ui'),fixture:{org:{name:'Panel history capture'},agents:[{name:'boss',tier:'sol',grant:50,charter:'Synthetic panel history capture only.'}]}}
}
const NOTE=`<style>body{font:14px system-ui;margin:12px;color:#d8dee9;background:#1f2430}</style><p><b>Synthetic notes</b></p>`

export default async function(rig){
  const p=new Proof('app-history'),root='/api/orgs/'+rig.org
  const apps=async input=>{const r=await rig.api('POST',root+'/apps',input);assert(!r?.detail&&!r?.error,JSON.stringify(r).slice(0,300));return r}
  const tool=async input=>{const r=await rig.tool('boss','orgtree_apps',input);assert(r.ok,r.text);return r.json}
  const history=async id=>(await apps({action:'events',panel:id,limit:200})).events.map(e=>[e.name,e.payload?.reason??e.payload?.event??null,e.actor])
  const messages=async id=>(await apps({action:'events',panel:id,limit:200,messages:true})).events.map(e=>[e.name,e.actor])
  p.check("the rig serves this worktree's renderer build",path.resolve(rig.run.ui??'')===path.join(built,'ui'),{ui:rig.run.ui})
  const app=await tool({action:'app_create',definition:{name:'Notes',description:'Synthetic history',html:NOTE,initial_state:{},capabilities:['events.fire'],events:[{name:'submitted',description:'Notes ready'}],width:420,height:260}})

  // Lifecycle that records nothing: an agent's closed copy, renames, state saves, hide.
  let copy=await tool({action:'panel_open',app:app.id,new:true,label:'Notes copy'})
  p.check("an agent's closed copy records nothing",(await history(copy.id)).length===0,await history(copy.id))
  copy=await apps({action:'panel_open',panel:copy.id})
  p.check('opening the stopped copy records panel.started, cause opened',JSON.stringify(await history(copy.id))===JSON.stringify([['panel.started','opened','user']]),await history(copy.id))
  copy=await apps({action:'panel_update',panel:copy.id,expected_rev:copy.rev,label:'Notes copy'})
  copy=await apps({action:'state_set',panel:copy.id,expected_rev:copy.rev,state:{note:'saved'}})
  copy=await apps({action:'panel_update',panel:copy.id,expected_rev:copy.rev,open:false})
  copy=await apps({action:'panel_update',panel:copy.id,expected_rev:copy.rev,open:true})
  p.check('rename, state save, hide and showing a running copy record nothing',(await history(copy.id)).length===1,await history(copy.id))
  // Messages keep working, apart from History; a fire, Power off and Start running are History.
  const sent=await tool({action:'event',panel:copy.id,name:'ping',payload:{n:1}})
  const seq=(await apps({action:'panel_get',panel:copy.id})).event_seq
  p.check("an agent's message is listed with messages:true, never in History, and advances event_seq",JSON.stringify(await messages(copy.id))===JSON.stringify([['ping','boss']])&&(await history(copy.id)).length===1&&seq>=sent.seq,{messages:await messages(copy.id),seq,sent})
  const fired=await apps({action:'fire_event',panel:copy.id,name:'submitted',payload:{note:'private'}})
  copy=await apps({action:'panel_stop',panel:copy.id})
  copy=await tool({action:'panel_start',panel:copy.id})
  copy=await apps({action:'panel_stop',panel:copy.id})
  copy=await apps({action:'panel_update',panel:copy.id,expected_rev:copy.rev,open:true})
  const expected=[['panel.started','opened','user'],['event.fired','submitted','user'],['panel.stopped',null,'user'],['panel.started',null,'boss'],['panel.stopped',null,'user'],['panel.started','opened','user']]
  p.check('History holds exactly the fire, the starts (opened, Start running) and the stops (Power off)',fired.accepted&&JSON.stringify(await history(copy.id))===JSON.stringify(expected),{history:await history(copy.id),expected})
  const fireRow=(await apps({action:'events',panel:copy.id,limit:200})).events.find(e=>e.name==='event.fired')
  p.check("a fire's History row is metadata only",JSON.stringify(fireRow?.payload??{}).includes('private')===false&&fireRow?.payload?.subscribers===0,fireRow)
  const twin=await apps({action:'panel_duplicate',panel:copy.id,expected_rev:copy.rev})
  p.check("the user's duplicate starts running and records panel.started, cause opened",JSON.stringify(await history(twin.id))===JSON.stringify([['panel.started','opened','user']]),await history(twin.id))
  await apps({action:'panel_stop',panel:twin.id})
  // Hidden, still running: no centered window covers the Apps button in the capture.
  copy=await apps({action:'panel_update',panel:copy.id,expected_rev:copy.rev,open:false})
  p.check('hiding a running copy records nothing',JSON.stringify(await history(copy.id))===JSON.stringify(expected),await history(copy.id))

  // Stage the upgrade: the old engine's store, with lifecycle rows and a message.
  rig.exec(`DROP INDEX ot.custom_panel_events_kind_page;
ALTER TABLE ot.custom_panel_events DROP COLUMN kind;
INSERT INTO ot.custom_panel_events(org_id,panel_id,name,payload,actor) SELECT org_id,id,x.name,x.payload::jsonb,'user' FROM ot.custom_panels, (VALUES ('panel.opened','{}'),('panel.changed','{}'),('state.changed','{"rev":7}'),('panel.created','{}'),('panel.duplicated','{"source":"x"}'),('legacy-ping','{"n":2}')) AS x(name,payload) WHERE id='${copy.id}';
DELETE FROM public.ot_migrations WHERE name='0071_custom_panel_history';`)
  await rig.restart()
  const upgraded=await history(copy.id),kept=await messages(copy.id)
  p.check('the engine applied migration 0071 at start: old lifecycle rows are gone, History is unchanged',JSON.stringify(upgraded)===JSON.stringify(expected),{upgraded,expected})
  p.check('old messages became messages and still list apart',JSON.stringify(kept)===JSON.stringify([['ping','boss'],['legacy-ping','user']]),kept)

  // The History tab, captured in the real renderer.
  const run=await runDesktop(rig,path.join(REPO,'tools','rig','desktop','app-history.cjs'),{preset:'wide',out:path.join(p.dir,'desktop'),timeout:180000,args:{label:'Notes copy'}})
  p.file('desktop-history.json',run)
  if(!p.check('the History capture ran in Session 0',run.ok&&run.value?.session?.sessionId===0,{error:run.error,session:run.value?.session,output:run.electronOutput?.slice(-600)}))return p.summary()
  const R=run.value
  p.check('clipboard isolated: every page clipboard path refused, none used, no permission granted',R.installed.clipboardStub&&R.clipboard.calls.length===0&&R.clipboard.requests.length===0,R.clipboard)
  p.check('History is its own tab and its lead line says what it records',R.tabs.includes('History')&&/^Fired events agents can listen to, and this copy starting and stopping/.test(R.lead??''),{tabs:R.tabs,lead:R.lead})
  const rows=(R.entries??[]).map(e=>e.replace(/^.*?(user|boss): /,'$1: '))
  const want=['user: started (opened)','user: stopped (Power off)','boss: started (Start running)','user: stopped (Power off)','user: fired submitted · 0 subscribed listeners','user: started (opened)']
  p.check('the tab lists the six History rows newest first with their causes, and nothing else',JSON.stringify(rows)===JSON.stringify(want),{rows,want})
  return p.summary()
}
