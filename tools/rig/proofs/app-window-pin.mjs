// Real renderer against the isolated PG engine: the panel pin pins to the
// window like pinned desks, and canvas pins are retired (USER 2026-10-26
// m5bf326d39c4b "i meant pin it to the window like other pinned panels",
// m2b682426170d "Remove canvas pinning"). An alpha.3 database is staged by SQL
// on the rig's own cluster (canvas pins stored, migration 0069 not yet applied)
// and the engine is restarted, so its migration runner applies 0069 as an
// upgrade does. tools/rig/desktop/app-window-pin.cjs then drives the window.
// Build first with tools/rig/app-background-ui.mjs and pass its output folder
// in APP_BACKGROUND_BUILD. Session 0 only; fake CLIs; synthetic org only.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'
import {runDesktop} from '../desktop.mjs'
import {REPO} from '../lib.mjs'

const built=process.env.APP_BACKGROUND_BUILD?path.resolve(process.env.APP_BACKGROUND_BUILD):''
export function setup(){
  if(!built||!fs.existsSync(path.join(built,'ui','index.html')))throw Error('set APP_BACKGROUND_BUILD to the output of tools/rig/app-background-ui.mjs')
  return{ui:path.join(built,'ui'),fixture:{org:{name:'Window pin capture'},agents:[{name:'boss',tier:'sol',grant:50,charter:'Synthetic window pin capture only.'}]}}
}
const NOTE=`<style>body{font:14px system-ui;margin:12px;color:#d8dee9;background:#1f2430}</style><p><b>Synthetic panel</b></p><p id="n">ticks 0</p><script>let n=0;setInterval(()=>{document.getElementById('n').textContent='ticks '+(++n)},500)</script>`
const near=(a,b,limit=1)=>typeof a==='number'&&typeof b==='number'&&Math.abs(a-b)<=limit
const same=(a,b,limit=1)=>!!a&&!!b&&['x','y','w','h'].every(k=>near(a[k],b[k],limit))

export default async function(rig){
  const p=new Proof('app-window-pin'),root='/api/orgs/'+rig.org
  const apps=input=>rig.api('POST',root+'/apps',input)
  const tool=async input=>{const r=await rig.tool('boss','orgtree_apps',input);assert(r.ok,r.text);return r.json}
  p.check("the rig serves this worktree's renderer build",path.resolve(rig.run.ui??'')===path.join(built,'ui'),{ui:rig.run.ui})
  const app=await tool({action:'app_create',definition:{name:'Pin check',description:'Synthetic window pin',html:NOTE,initial_state:{},capabilities:[],width:420,height:260}})
  const shown=await apps({action:'panel_open',app:app.id,new:true,label:'Shown'})
  const closed=await tool({action:'panel_open',app:app.id,new:true,label:'Anchored'})

  // Tool parity: the agent-facing placement modes match the window's controls.
  const place=placement=>rig.tool('boss','orgtree_apps',{action:'panel_update',panel:closed.id,expected_rev:closed.rev,placement})
  const canvas=await place({mode:'canvas',x:0,y:0,width:420,height:260})
  p.check('orgtree_apps refuses mode canvas and names window instead',!canvas.ok&&/canvas pins were removed/.test(canvas.text)&&/window/.test(canvas.text),canvas.text)
  const anchored=await place({mode:'window',x:0,y:0,width:420,height:260,anchor:'boss'})
  p.check('orgtree_apps refuses a node anchor',!anchored.ok&&/no longer attach/.test(anchored.text),anchored.text)
  const windowed=await place({mode:'window',x:30,y:40,width:420,height:260})
  p.check('an agent may give a closed copy a window placement',windowed.ok&&windowed.json?.placement?.mode==='window',windowed.text)

  // Stage alpha.3: both copies stored as canvas pins, one attached to a node,
  // and migration 0069 not yet recorded as applied.
  rig.exec(`UPDATE ot.custom_panels SET placement=jsonb_build_object('mode','canvas','x',1234,'y',-567,'width',420,'height',260,'anchor',NULL) WHERE id='${shown.id}';
UPDATE ot.custom_panels SET placement=jsonb_build_object('mode','canvas','x',10,'y',20,'width',420,'height',260,'anchor','boss') WHERE id='${closed.id}';
DELETE FROM public.ot_migrations WHERE name='0069_custom_panel_window_pins';`)
  const staged=await apps({action:'panel_get',panel:shown.id}),stagedClosed=await apps({action:'panel_get',panel:closed.id})
  p.check('staged an alpha.3 database: two canvas pins, one attached to a node',staged.placement?.mode==='canvas'&&stagedClosed.placement?.anchor==='boss',{shown:staged.placement,closed:stagedClosed.placement})
  await rig.restart()
  const upgraded=await apps({action:'panel_get',panel:shown.id}),upgradedClosed=await apps({action:'panel_get',panel:closed.id})
  p.check('the engine applied migration 0069 at start: canvas pins reopen floating, the node anchor is gone and the revision moved',upgraded.placement?.mode==='float'&&upgradedClosed.placement?.mode==='float'&&upgradedClosed.placement?.anchor==null&&upgraded.rev===staged.rev+1,{shown:upgraded.placement,closed:upgradedClosed.placement,revs:[staged.rev,upgraded.rev]})
  p.check('the upgraded copy is still open and running',upgraded.open===true&&upgraded.running===true,{open:upgraded.open,running:upgraded.running})

  // The window: opens floating, pins in place, stays fixed while the canvas moves.
  const run=await runDesktop(rig,path.join(REPO,'tools','rig','desktop','app-window-pin.cjs'),{preset:'wide',out:path.join(p.dir,'desktop-pin'),timeout:240000,args:{phase:'pin',panel:{id:shown.id,label:'Shown'}}})
  p.file('desktop-pin.json',run)
  if(!p.check('the pin capture ran in Session 0',run.ok&&run.value?.session?.sessionId===0,{error:run.error,session:run.value?.session,output:run.electronOutput?.slice(-600)}))return p.summary()
  const R=run.value
  p.check('clipboard isolated: every page clipboard path refused, none used, no permission granted',R.installed.clipboardStub&&R.clipboard.calls.length===0&&R.clipboard.requests.length===0,R.clipboard)
  const centre=R.before&&{x:R.before.x+R.before.w/2,y:R.before.y+R.before.h/2}
  p.check('the upgraded canvas pin opens as the centered window',!!R.before&&R.before.centered&&!R.before.inLayer&&near(centre.x,R.window.w/2,2)&&near(centre.y,R.window.h/2,2),{before:R.before,window:R.window})
  p.check('no pin-to-canvas control anywhere: panel header, Apps list or saved-row menu',R.panelOffers.length===0&&R.menuOffers?.length===0&&(R.rowMenuOffers??[]).length===0,{panel:R.panelOffers,menu:R.menuOffers,row:R.rowMenu})
  p.check('Pin to window keeps the panel at the same spot and size',same(R.before,R.pinned),{before:R.before,pinned:R.pinned})
  p.check('the pinned panel joins the pin layer of pinned desks and shows Unpin pressed',R.pinned.inLayer&&R.pinned.pinned&&!R.pinned.centered&&R.pinned.pin==='Unpin',R.pinned)
  p.check('the saved placement is mode window in canvas-area pixels at that size',R.saved?.mode==='window'&&near(R.saved.x,R.pinned.x-R.area.x)&&near(R.saved.y,R.pinned.y-R.area.y)&&R.saved.width===R.pinned.w&&R.saved.height===R.pinned.h&&R.saved.anchor==null,{saved:R.saved,pinned:R.pinned,area:R.area})
  const moved=(a,b)=>!!a&&!!b&&Math.hypot(a.x-b.x,a.y-b.y)>=100
  p.check('the canvas pans under it while the panel stays put',moved(R.nodeBefore,R.nodeAfterPan)&&same(R.pinned,R.afterPan),{node:[R.nodeBefore,R.nodeAfterPan],panel:[R.pinned,R.afterPan],from:R.emptyPoint})
  p.check('the canvas zooms under it while the panel stays put',!!R.nodeAfterZoom&&!near(R.nodeAfterZoom.w,R.nodeAfterPan.w,2)&&same(R.pinned,R.afterZoom),{node:[R.nodeAfterPan,R.nodeAfterZoom],panel:[R.pinned,R.afterZoom]})
  p.check("a wheel over the pinned panel's title bar leaves the canvas alone",same(R.nodeAfterZoom,R.nodeAfterTitleWheel,0),{node:[R.nodeAfterZoom,R.nodeAfterTitleWheel]})

  // A restart: the engine and a fresh renderer (new process and profile).
  await rig.restart()
  const kept=await apps({action:'panel_get',panel:shown.id})
  p.check('the window pin survives an engine restart unchanged',kept.placement?.mode==='window'&&kept.placement.x===R.saved.x&&kept.placement.y===R.saved.y&&kept.open===true&&kept.running===true,{kept:kept.placement,saved:R.saved})
  const again=await runDesktop(rig,path.join(REPO,'tools','rig','desktop','app-window-pin.cjs'),{preset:'wide',out:path.join(p.dir,'desktop-restored'),timeout:180000,args:{phase:'restored',panel:{id:shown.id,label:'Shown'}}})
  p.file('desktop-restored.json',again)
  if(!p.check('the restore capture ran in Session 0',again.ok&&again.value?.session?.sessionId===0,{error:again.error,session:again.value?.session,output:again.electronOutput?.slice(-600)}))return p.summary()
  const S=again.value
  p.check('clipboard isolated in the restored window too',S.installed.clipboardStub&&S.clipboard.calls.length===0&&S.clipboard.requests.length===0,S.clipboard)
  p.check('after the restart the panel is restored pinned to the window at the same spot and size',S.restored?.inLayer&&S.restored.pinned&&same(S.restored,R.afterZoom)&&same(S.area,R.area,0),{restored:S.restored,before:R.afterZoom,area:[R.area,S.area]})
  return p.summary()
}
