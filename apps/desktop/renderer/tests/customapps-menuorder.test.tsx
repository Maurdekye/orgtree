import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {customAppsFeed,invalidateCustomApps} from '../src/canvas/apps/store'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

declare const __SRC_DIR__:string
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
const byId=<T extends {id:string}>(items:T[])=>[...items].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
// The engine lists apps and panels by ID; created_at makes Alpha the newest app, then Clock, then Beta.
// Beta runs hidden. Clock's Panel 1 was created first but Panel 2 was used last, and their IDs sort the
// other way round, so creation, use and ID order all differ.
function fixture(t:test.TestContext){
 const app=(id:string,name:string,created_at:string)=>({id,name,description:name+' app',rev:1,permission_rev:1,width:320,height:240,capabilities:[],permissions:{},created_by:'maker',created_at,updated_at:'',definition:{name,description:'',html:'<p>panel</p>',initial_state:{},capabilities:[],width:320,height:240}}) as unknown as CustomApp
 const panel=(id:string,owner:string,label:string,open:boolean,running:boolean,created_at:string,used_at:string)=>({id,app:owner,label,rev:1,open,running,run_generation:1,state:{},event_seq:0,placement:{mode:'float',x:40,y:40,width:320,height:240},linked_agents:[],created_at,used_at,updated_at:''}) as CustomPanel&{running:boolean;run_generation:number}
 const apps=[app('app1alpha','Alpha','2026-10-26T08:00:00Z'),app('app2beta','Beta','2026-10-20T09:00:00Z'),app('app3clock','Clock','2026-10-23T12:00:00Z')]
 const panels=[panel('pa1','app1alpha','Notes',false,false,'2026-10-26T08:05:00Z','2026-10-26T08:05:00Z'),
  panel('pb1','app2beta','Runner',false,true,'2026-10-20T09:05:00Z','2026-10-26T10:30:00Z'),
  panel('pc9','app3clock','Panel 1',false,false,'2026-10-23T12:05:00Z','2026-10-26T11:00:00Z'),
  panel('pc2','app3clock','Panel 2',true,true,'2026-10-24T10:00:00Z','2026-10-26T12:00:00Z')]
 const original=globalThis.fetch,calls:Record<string,any>[]=[]
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
  const one=()=>panels.find(p=>p.id===input.panel)!
  if(input.action==='list')out={items:input.kind==='apps'?byId(apps):byId(panels).filter(p=>(input.open===undefined||p.open===input.open)&&(input.running===undefined||p.running===input.running)),next_cursor:null,new_count:0}
  else if(input.action==='app_get')out=apps.find(a=>a.id===input.app)
  else if(input.action==='panel_get')out=one()
  else if(input.action==='events')out={events:[],next_cursor:null}
  // Like the engine: opening is a use (used_at), power changes and Hide are not.
  else if(input.action==='panel_open'){const p=one();p.open=true;p.running=true;p.used_at='2026-10-26T13:00:00Z';p.rev++;out=p}
  else if(input.action==='panel_update'){const p=one();Object.assign(p,input);p.rev++;out=p}
  else if(input.action==='panel_start'){const p=one();p.running=true;p.rev++;out=p}
  else if(input.action==='panel_stop'){const p=one();p.running=false;p.open=false;p.run_generation++;p.rev++;out=p}
  else if(input.action==='runtime')out={items:[],next_cursor:null}
  else if(input.action==='session_close')out={closed:true}
  else throw Error('Unexpected fixture operation '+input.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 };t.after(()=>{globalThis.fetch=original;delete (document as unknown as Record<string,unknown>).hidden})
 return{app,panel,apps,panels,calls}
}
async function workspace(t:test.TestContext,slug:string){
 const f=fixture(t),view=await mountView(<><AppsButton slug={slug}/><AppsWorkspace slug={slug}/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 const menu=()=>document.querySelector<HTMLElement>('.custom-apps-menu')!
 const group=(app:string)=>[...menu().querySelectorAll<HTMLElement>('.custom-apps-menu-group')].find(g=>g.querySelector('.custom-apps-open b')?.textContent===app)!
 return{...f,menu,group,
  toggle:()=>inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()}),
  order:()=>[...menu().querySelectorAll('.custom-apps-menu-group .custom-apps-open b')].map(e=>e.textContent),
  rows:(app:string)=>[...group(app).querySelectorAll('.custom-apps-saved span:nth-child(2)')].map(e=>e.textContent),
  opener:(app:string)=>group(app).querySelector('.custom-apps-open')!.getAttribute('title'),
  // what the engine's custom_apps_changed event does after every change
  changed:()=>inAct(async()=>{invalidateCustomApps(slug);await tick()}),
  feed:()=>inAct(async()=>{assert.equal(customAppsFeed(slug,{type:'custom_apps_changed'}),true);await tick()})}
}

// USER 2026-10-26 mf87be90ee3c8: "the ordering of the apps in the list shouldnt change as panels are turned onca or off";
// m1e0117740c5f: apps "newest first", panels "Fixed order". The app row opening the most recently used panel,
// now independent of the list order, is @coordinator-opus's provisional call.
test('apps stay newest first and panels in creation order while panels are opened, powered off and on',async t=>{
 const f=await workspace(t,'menu-order'),apps=['Alpha','Clock','Beta'],clock=['Panel 1','Panel 2']
 await f.toggle()
 assert.deepEqual(f.order(),apps,'newest app first, whichever apps have running panels')
 assert.deepEqual(f.rows('Clock'),clock,'panels in creation order, not by use or ID')
 assert.equal(f.opener('Clock'),'Open Panel 2','the app row opens the most recently used panel')
 await inAct(async()=>{f.menu().querySelector<HTMLButtonElement>('[aria-label="Power off Runner"]')!.click();await tick()})
 assert.equal(f.panels[1].running,false);await f.changed()
 assert.deepEqual(f.order(),apps,'powering a panel off does not move its app')
 await f.toggle();await f.toggle()
 assert.deepEqual(f.order(),apps,'nor does reopening the list')
 const row=[...f.group('Alpha').querySelectorAll<HTMLElement>('.custom-apps-saved-row')].find(r=>r.textContent?.includes('Notes'))!
 await inAct(async()=>{row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:50}));await tick()})
 const start=[...document.querySelectorAll<HTMLElement>('[role="menuitem"],button')].find(b=>b.textContent?.trim().startsWith('Start running'))!
 await inAct(async()=>{start.click();await tick()})
 assert.equal(f.panels[0].running,true);await f.changed()
 assert.deepEqual(f.order(),apps,'powering a panel on does not move its app')
 await f.toggle();await f.toggle()
 assert.deepEqual(f.order(),apps,'nor does reopening the list')
 // Opening Clock's Panel 1 from its row is a use; the list closes, and nothing moves when it reopens.
 await inAct(async()=>{[...f.group('Clock').querySelectorAll<HTMLButtonElement>('.custom-apps-saved')].find(b=>b.textContent?.includes('Panel 1'))!.click();await tick()})
 assert.equal(f.panels[2].open,true);await f.changed();await f.toggle()
 assert.deepEqual(f.order(),apps,'opening a panel does not move its app')
 assert.deepEqual(f.rows('Clock'),clock,'nor the panel')
 assert.equal(f.opener('Clock'),'Open Panel 1','the app row now opens Panel 1, the most recently used')
 await inAct(async()=>{f.group('Clock').querySelector<HTMLButtonElement>('.custom-apps-open')!.click();await tick()})
 assert.deepEqual(f.calls.filter(c=>c.action==='panel_open').at(-1),{action:'panel_open',panel:'pc9'},'by its ID, wherever it is listed')
})

// USER 2026-10-26 m68e69e302bc4: "add more visual delineation between apps w/ panel groups and between individual panels under an app".
test('each app and its panels form one block, and its panel rows sit in their own ruled group',async t=>{
 const f=await workspace(t,'menu-blocks');await f.toggle()
 const groups=[...f.menu().querySelectorAll<HTMLElement>('section.custom-apps-menu-group')]
 assert.equal(groups.length,3)
 for(const g of groups){
  const name=g.querySelector('.custom-apps-open b')!.textContent,list=g.querySelector<HTMLElement>(':scope>.custom-apps-menu-panels')
  assert.ok(list,`${name}: its panel rows have their own group`)
  assert.equal(list.getAttribute('role'),'group');assert.equal(list.getAttribute('aria-label'),`Panels of ${name}`)
  assert.equal(list.querySelectorAll(':scope>.custom-apps-saved-row').length,g.querySelectorAll('.custom-apps-saved-row').length,`${name}: every panel row is in it`)
 }
 const css=readFileSync(path.join(__SRC_DIR__,'canvas','apps','apps.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'')
 assert.match(css,/\.custom-apps-menu-group\s*\{[^}]*border:\s*1px solid var\(--line\)/,'each app is a bordered block')
 assert.match(css,/\.custom-apps-menu-panels\s*>\s*\.custom-apps-saved-row\s*\+\s*\.custom-apps-saved-row\s*\{[^}]*border-top:\s*1px solid var\(--line\)/,'each panel row is ruled off from the one above')
 // No theme defines --border, --muted, --hover or --text, so a menu rule using them silently loses that colour.
 const menuRules=css.match(/[^{}]+\{[^{}]*\}/g)!.filter(r=>/^\s*\.custom-(apps-(menu|saved|open|new)|app-(dot|cpu))/.test(r))
 assert.ok(menuRules.length>10)
 for(const rule of menuRules)assert.doesNotMatch(rule,/var\(--(border|muted|hover|text)\)/,`undefined theme colour in ${rule.split('{')[0].trim()}`)
})

// USER 2026-10-27 m45499a3c150f, on the in-app note "Panels are custom views; they run only while Orgtree is open, tray
// included.": "remove this annotation". The fact stays in the agent tool text, the glossary and the user docs.
test('the Apps list carries no annotation about when panels run',async t=>{
 const f=await workspace(t,'menu-no-note');await f.toggle()
 assert.ok(f.menu().querySelectorAll('.custom-apps-saved-row').length>0,'panels are listed, the case that showed the note')
 assert.equal(f.menu().querySelectorAll('.custom-apps-note').length,0,'no note element')
 assert.equal(/run only while|custom views|tray included/i.test(f.menu().textContent??''),false,'no wording about when panels run')
})

// USER 2026-10-27 m4dcfc15be8e3: "remove the refresh button here, new or removed apps / panels should appear in realtime";
// mcc0591ec051b: "replace it with the import button right-aligned in its place".
test('the Apps header right-aligns Import app with no Refresh button, and app and panel changes appear live in stable order',async t=>{
 const f=await workspace(t,'menu-live');await f.toggle()
 const header=f.menu().querySelector<HTMLElement>(':scope>header')!
 assert.equal([...f.menu().querySelectorAll('button')].some(b=>/refresh/i.test((b.textContent??'')+(b.getAttribute('aria-label')??'')+(b.title??''))),false,'no Refresh button in the Apps menu')
 assert.deepEqual([...header.children].map(e=>[e.tagName,e.className,e.textContent?.trim()]),[['STRONG','','Apps'],['LABEL','custom-app-import-file','Import app']],'Import app sits at the right end of the Apps header where Refresh was')
 // External creates (e.g. an agent's app_create/app_import and closed panel_open) arrive through custom_apps_changed while the menu is open.
 f.apps.push(f.app('app0delta','Delta','2026-10-27T09:00:00Z'))
 f.panels.push(f.panel('pc1','app3clock','Panel 3',false,false,'2026-10-25T10:00:00Z','2026-10-25T10:00:00Z'))
 await f.feed()
 assert.deepEqual(f.order(),['Delta','Alpha','Clock','Beta'],'new app appears live at the top (newest first)')
 assert.deepEqual(f.rows('Clock'),['Panel 1','Panel 2','Panel 3'],'new stopped panel appears live in creation order without Refresh')
 // External rename and external power-off (e.g. an agent's panel_update/panel_stop or Stop all) update in place without dropping or moving the row.
 Object.assign(f.panels.find(p=>p.id==='pc1')!,{label:'Summary',rev:2})
 Object.assign(f.panels.find(p=>p.id==='pc2')!,{open:false,running:false,rev:2,run_generation:2})
 await f.feed()
 assert.deepEqual(f.rows('Clock'),['Panel 1','Panel 2','Summary'],'renamed stopped panel updates in place and powered-off panel stays listed')
 assert.equal(f.group('Clock').querySelectorAll('.custom-apps-saved')[1]!.getAttribute('title'),'Off','powered-off panel light updates live to Off')
 // External deletes of a stopped panel and an app remove them live.
 f.panels.splice(f.panels.findIndex(p=>p.id==='pc9'),1)
 f.apps.splice(f.apps.findIndex(a=>a.id==='app0delta'),1)
 await f.feed()
 assert.deepEqual(f.order(),['Alpha','Clock','Beta'],'deleted app disappears live')
 assert.deepEqual(f.rows('Clock'),['Panel 2','Summary'],'deleted stopped panel disappears live')
})
