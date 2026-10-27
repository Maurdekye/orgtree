// Real PG engine, then the real renderer: a copy's History holds only fired
// events agents can listen to and the copy starting and stopping (USER
// 2026-10-26 md6edfebc1975 "make it only for fired events agents can listen to
// and starting / stopping, dont record anything else"; answers mcbcd7b3cb6c0:
// delete old rows on upgrade, keep messages working apart, opening a stopped
// copy is a start). The upgrade is staged by SQL on the rig's own cluster (the
// kind column removed, old rows inserted, migration 0071 unrecorded) and the
// engine restarted so its migration runner applies 0071.
// USER 2026-10-27 md2006b10cf40 ("reload in realtime, be more list like wity
// expandable rows, and lazily losd as you sfrollcdown") and m838e66af753b ("ssme for
// permission history, and put tgat on i6s own tab"): both logs page newest first
// with before, follow new rows with after and refuse both, through the route and
// the agent tool; an app's own fire reaches an open History tab live.
// tools/rig/desktop/app-history.cjs then captures both tabs, muted. Build first
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
const NOTE=`<style>body{font:14px system-ui;margin:12px;color:#d8dee9;background:#1f2430}</style><p id="history-capture-app"><b>Synthetic notes</b></p><script>window.fireNow=n=>orgtree.events.fire('submitted',{n})</script>`
const FEED=`<p>Synthetic feed</p>`
const desc=seqs=>seqs.every((s,i)=>!i||seqs[i-1]>s),asc=seqs=>seqs.every((s,i)=>!i||seqs[i-1]<s)

export default async function(rig){
  const p=new Proof('app-history'),root='/api/orgs/'+rig.org
  const apps=async input=>{const r=await rig.api('POST',root+'/apps',input);assert(!r?.detail&&!r?.error,JSON.stringify(r).slice(0,300));return r}
  const tool=async input=>{const r=await rig.tool('boss','orgtree_apps',input);assert(r.ok,r.text);return r.json}
  // after:0 reads oldest first, so these compare whole logs in order.
  const history=async id=>(await apps({action:'events',panel:id,after:0,limit:200})).events.map(e=>[e.name,e.payload?.reason??e.payload?.event??null,e.actor])
  const messages=async id=>(await apps({action:'events',panel:id,after:0,limit:200,messages:true})).events.map(e=>[e.name,e.actor])
  const refused=async input=>{try{await rig.api('POST',root+'/apps',input);return null}catch(e){return e.status===400?String(e.message):'status '+e.status}}
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
  const fireRow=(await apps({action:'events',panel:copy.id,after:0,limit:200})).events.find(e=>e.name==='event.fired')
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

  // Paging (USER 2026-10-27 md2006b10cf40): newest first, before walks back, after
  // follows newer rows; rows written between pages are neither repeated nor skipped.
  // Starts and stops are not app actions, so the 60 fires a minute per app do not hold them up.
  for(let i=0;i<30;i++){await apps({action:'panel_stop',panel:copy.id});await apps({action:'panel_start',panel:copy.id})}
  const stored=(await apps({action:'events',panel:copy.id,after:0,limit:200})).events.map(e=>e.seq)
  const first=await apps({action:'events',panel:copy.id,limit:50}),seqs=page=>page.events.map(e=>e.seq)
  p.check('events reads the newest 50 first, newest first, next_cursor at its oldest',first.events.length===50&&first.events[0].seq===stored.at(-1)&&desc(seqs(first))&&first.next_cursor===first.events.at(-1).seq,{first:seqs(first),next:first.next_cursor,newest:stored.at(-1)})
  for(let n=1;n<=2;n++)await apps({action:'fire_event',panel:copy.id,name:'submitted',payload:{n}})
  const older=await apps({action:'events',panel:copy.id,limit:50,before:first.next_cursor})
  const newer=await apps({action:'events',panel:copy.id,limit:50,after:first.events[0].seq})
  p.check('before continues with older rows only; after reads just the two rows written since, oldest first',older.events.length===stored.length-50&&older.next_cursor===null&&desc(seqs(older))&&seqs(older)[0]<first.next_cursor&&newer.events.length===2&&asc(seqs(newer))&&newer.next_cursor===null,{older:seqs(older),newer:seqs(newer)})
  const union=[...seqs(newer),...seqs(first),...seqs(older)],now=(await apps({action:'events',panel:copy.id,after:0,limit:200})).events.map(e=>e.seq)
  p.check('the pages and the live read hold every stored row exactly once',new Set(union).size===union.length&&JSON.stringify([...union].sort((a,b)=>a-b))===JSON.stringify(now),{union:union.length,stored:now.length})
  const agentPage=await tool({action:'events',panel:copy.id,limit:50})
  p.check("an agent's events page is the same newest-first page",JSON.stringify(seqs(agentPage))===JSON.stringify([...seqs(newer)].reverse().concat(seqs(first)).slice(0,50)),seqs(agentPage))
  const both=await refused({action:'events',panel:copy.id,after:1,before:9})
  p.check('after and before together are refused',/not both/.test(both??''),both)

  // Permission history pages the same way (USER m838e66af753b): 60 changes by the user.
  let feed=await tool({action:'app_create',definition:{name:'Feed',description:'Synthetic permissions',html:FEED,initial_state:{},capabilities:['net.fetch'],sites:['api.example.com'],width:420,height:260}})
  for(let i=0;i<60;i++)feed=await apps({action:'permission_set',app:feed.id,expected_rev:feed.rev,expected_permission_rev:feed.permission_rev,capability:'net.fetch',permission:i%2?'ask':'deny'})
  const entrySeqs=page=>page.entries.map(e=>e.seq)
  const h1=await apps({action:'permission_history',app:feed.id,limit:50})
  feed=await apps({action:'permission_set',app:feed.id,expected_rev:feed.rev,expected_permission_rev:feed.permission_rev,capability:'net.fetch',permission:'deny'})
  const h2=await apps({action:'permission_history',app:feed.id,limit:50,before:h1.next_cursor}),hn=await apps({action:'permission_history',app:feed.id,after:h1.entries[0].seq})
  const hall=[...entrySeqs(hn),...entrySeqs(h1),...entrySeqs(h2)]
  p.check('permission_history pages newest first with before and follows with after, every entry once',h1.entries.length===50&&desc(entrySeqs(h1))&&h1.next_cursor===h1.entries.at(-1).seq&&h2.entries.length===10&&h2.next_cursor===null&&hn.entries.length===1&&hall.length===61&&new Set(hall).size===61,{h1:entrySeqs(h1).length,h2:entrySeqs(h2),hn:entrySeqs(hn)})
  const agentHistory=await tool({action:'permission_history',app:feed.id,limit:50})
  p.check("an agent's permission_history page matches, and both cursors together are refused",JSON.stringify(entrySeqs(agentHistory))===JSON.stringify(hall.slice(0,50))&&/not both/.test(await refused({action:'permission_history',app:feed.id,after:1,before:9})??''),entrySeqs(agentHistory).slice(0,3))

  // Both tabs in the real renderer, muted; the copy keeps running hidden so its own fire is live.
  const before=(await apps({action:'events',panel:copy.id,after:0,limit:200})).events.length
  const run=await runDesktop(rig,path.join(REPO,'tools','rig','desktop','app-history.cjs'),{preset:'wide',out:path.join(p.dir,'desktop'),timeout:240000,args:{label:'Notes copy',app:'Feed'}})
  p.file('desktop-history.json',run)
  if(!p.check('the capture ran in Session 0, muted',run.ok&&run.value?.session?.sessionId===0&&run.value?.muted===true,{error:run.error,session:run.value?.session,muted:run.value?.muted,output:run.electronOutput?.slice(-600)}))return p.summary()
  const R=run.value,H=R.history,P=R.permissions
  p.check('clipboard isolated: every page clipboard path refused, none used, no permission granted',R.installed.clipboardStub&&R.clipboard.calls.length===0&&R.clipboard.requests.length===0,R.clipboard)
  p.check('History is the last Panel settings tab, says what it records and has no Refresh button',R.panelTabs.at(-1)==='History'&&/^Fired events agents can listen to, and this copy starting and stopping, newest first\./.test(H.lead??'')&&H.refresh===false,{tabs:R.panelTabs,lead:H.lead,refresh:H.refresh})
  p.check('History shows its newest 50 as one-line rows in its own scrolling list, collapsed',H.first.rows===50&&H.first.more&&H.first.scrolls&&H.first.maxRow<34&&H.first.expanded===0&&/Fired submitted.*You/.test(H.first.top??''),H.first)
  p.check('a row expands to its details and metadata payload (never the fired data) and collapses again',H.expanded.state==='true'&&/"event": "submitted"/.test(H.expanded.text??'')&&!/"n"/.test(H.expanded.text??'')&&/Listeners/.test(H.expanded.text??'')&&H.collapsed==='false',{expanded:H.expanded,collapsed:H.collapsed})
  const latest=(await apps({action:'events',panel:copy.id,limit:1})).events[0]
  p.check("the app's own fire appears at the top of the open tab without a click, and is the app's",H.live.ok&&/Fired submitted.*app/.test(H.live.top??'')&&latest?.actor==='app'&&latest?.payload?.event==='submitted',{live:H.live,latest})
  const total=(await apps({action:'events',panel:copy.id,after:0,limit:200})).events.length
  p.check('scrolling down loads the older pages until the list ends at the oldest stored row, each row once',H.scrolled.rows===total&&total===before+1&&!H.scrolled.more&&H.scrolled.pages>=1&&H.scrolled.gap<=1&&/Started.*Opened.*You/.test(H.scrolled.last??''),{scrolled:H.scrolled,total,before})
  p.check('App settings tabs are General, Permissions, Permission history, and Permissions holds no history',JSON.stringify(R.appTabs)===JSON.stringify(['General','Permissions','Permission history'])&&P.inPermissions===false,{tabs:R.appTabs,inPermissions:P.inPermissions})
  const retained=(await apps({action:'permission_history',app:feed.id,after:0,limit:200})).entries.length
  p.check('Permission history shows the newest 50 one-line rows, expands a row to its details, and lists the change made meanwhile on top',P.first.rows===50&&P.first.more&&P.first.maxRow<34&&P.refresh===false&&P.expanded.state==='true'&&/net\.fetch/.test(P.expanded.text??'')&&/Changed in Permissions/.test(P.expanded.text??'')&&P.live.ok&&P.live.kept==='true'&&P.scrolled.rows===retained&&!P.scrolled.more&&P.scrolled.gap<=1&&/Internet access: denied/.test(P.scrolled.last??''),{first:P.first,expanded:P.expanded,live:P.live,scrolled:P.scrolled,retained})
  return p.summary()
}
