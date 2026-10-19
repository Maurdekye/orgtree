import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
const require=createRequire(process.env.ORGTREE_TEST_DEPS||import.meta.url),{buildSync,transformSync}=require('esbuild')
const scope=process.env.ORGTREE_TRAY_TEST_ROOT
assert.match(scope||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
fs.mkdirSync(scope,{recursive:true});const temp=fs.mkdtempSync(path.join(scope,'recent-'))
buildSync({entryPoints:['apps/desktop/main/traylist.ts','apps/desktop/main/org-placement.ts'],outdir:temp,entryNames:'[name]',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs'})
const tray=require(path.join(temp,'traylist.cjs')),{OrgPlacement,migratePlacementFile}=require(path.join(temp,'org-placement.cjs'))
test.after(()=>{assert.ok(fs.realpathSync(temp).toLowerCase().startsWith(fs.realpathSync(scope).toLowerCase()+path.sep));fs.rmSync(temp,{recursive:true,force:true})})
const rows=Array.from({length:15},(_,i)=>({slug:'org-'+i,name:'Organization '+i,working:i%3,live:20,attention:0}))

test('the tray viewport is capped at ten rows without dropping any organization',()=>{
 const bounds=tray.popupBounds({x:900,y:900,width:24,height:24},{x:0,y:0,width:1200,height:900},rows.length)
 assert.equal(bounds.height,10*tray.TRAY_ROW_H+12)
 assert.equal((tray.trayListHtml(rows).match(/<a class="row/g)||[]).length,15)
})

test('short and narrow work areas contain the popup with whole rows where space permits',()=>{
 const area={x:-128,y:20,width:128,height:140},bounds=tray.popupBounds({x:-20,y:160,width:20,height:20},area,30)
 assert.ok(bounds.width<=area.width)
 assert.ok(bounds.x>=area.x&&bounds.x+bounds.width<=area.x+area.width)
 assert.ok(bounds.y>=area.y&&bounds.y+bounds.height<=area.y+area.height)
 assert.equal((bounds.height-12)%tray.TRAY_ROW_H,0)
})

test('the capped list is a focusable native scroll region while remaining scriptless',()=>{
 const html=tray.trayListHtml(rows)
 assert.match(html,/class="list"[^>]*tabindex="0"/)
 assert.match(html,/overflow-y:auto/)
 assert.match(html,/autofocus/)
 assert.doesNotMatch(html,/<script|javascript:|onload=/i)
})

test('tray rows follow most recent opens, preserve unknown-org order and never mutate the source',()=>{
 assert.equal(typeof tray.sortTrayRows,'function')
 const recent=['org-12','missing','org-3','org-12']
 const sorted=tray.sortTrayRows(rows,recent)
 assert.deepEqual(sorted.map(r=>r.slug),['org-12','org-3',...rows.filter(r=>!['org-12','org-3'].includes(r.slug)).map(r=>r.slug)])
 assert.equal(rows[0].slug,'org-0')
 assert.equal(tray.sortTrayRows(null,recent),null)
})

test('last-opened org order survives restart and closing while remaining separate from restore membership',()=>{
 const file=path.join(temp,'window-state.json'),store=new OrgPlacement(file)
 assert.equal(typeof store.recordOrgOpen,'function')
 store.recordOrgOpen('alpha');store.recordOrgOpen('beta');store.recordOrgOpen('alpha')
 store.openedWindow('org:alpha');store.closedWindow('org:alpha')
 const restored=new OrgPlacement(file)
 assert.deepEqual(restored.recentOrgs(),['alpha','beta'])
 assert.deepEqual(restored.sessionWindows(),[])
 assert.deepEqual(restored.geometry(),[])
 const copy=restored.recentOrgs();copy.pop();assert.deepEqual(restored.recentOrgs(),['alpha','beta'])
 restored.forgetDeletedOrg('alpha');assert.deepEqual(new OrgPlacement(file).recentOrgs(),['beta'])
})

test('recency migration accepts only unique org slugs and ignores malformed history',()=>{
 const value=migratePlacementFile({version:2,geometry:[],session:[],recentOrgs:['alpha','../bad',null,'beta','alpha']})
 assert.deepEqual(value.recentOrgs,['alpha','beta'])
 const file=path.join(temp,'malformed.json');fs.writeFileSync(file,JSON.stringify({version:2,geometry:[],session:[],recentOrgs:'not a list'}))
 const store=new OrgPlacement(file);assert.equal(typeof store.recentOrgs,'function');assert.deepEqual(store.recentOrgs(),[])
 assert.equal(typeof store.recordOrgOpen,'function');store.recordOrgOpen('../bad');assert.deepEqual(store.recentOrgs(),[])
})

const source=fs.readFileSync('apps/desktop/main/index.ts','utf8')
function requestFixture(outcome){
 const start=source.indexOf('      requestOrgWindow = async'),end=source.indexOf('      /** WHAT AN ORDINARY LAUNCH',start)
 assert.ok(start>=0&&end>start)
 const opened=[],ctx=vm.createContext({console,requestOrgWindow:undefined,openOrg:async()=>outcome,windows:{},records:new Map(),rememberOrgOpen:org=>opened.push(org),revealWindow:()=>{},adoptIdentity:()=>{}})
 vm.runInContext(transformSync(source.slice(start,end)+'\nglobalThis.request=requestOrgWindow',{loader:'ts'}).code,ctx)
 return {opened,request:ctx.request}
}

test('successful native open focus and binding update the existing durable recency path',async()=>{
 for(const action of ['opened','focused','bound']){
  const f=requestFixture({action,org:'alpha',windowId:'w'});await f.request('alpha',null)
  assert.deepEqual(f.opened,['alpha'],action)
 }
})

test('pending and refused open requests do not promote an organization',async()=>{
 for(const action of ['pending','refused']){
  const f=requestFixture({action,org:'alpha',reason:'invalid-org'});await f.request('alpha',null)
  assert.deepEqual(f.opened,[])
 }
})

test('binding a newly created organization records it only after successful binding',()=>{
 const start=source.indexOf("    handle('desktop:bind-created-org'"),end=source.indexOf("    handle('desktop:set-unsaved-creation'",start)
 assert.ok(start>=0&&end>start)
 let handler;const opened=[],ctx=vm.createContext({handle:(_name,fn)=>{handler=fn},windows:{bindCreated:()=>({action:'bound',org:'created'})},adoptIdentity:()=>{},rememberOrgOpen:org=>opened.push(org)})
 vm.runInContext(transformSync(source.slice(start,end),{loader:'ts'}).code,ctx)
 handler({id:'w'},'created');assert.deepEqual(opened,['created'])
})
