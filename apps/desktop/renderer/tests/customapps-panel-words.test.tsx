import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type {ReactElement} from 'react'
import {AppSettings,PanelSettings} from '../src/canvas/apps/settings'
import {AppPermissionPrompt} from '../src/canvas/apps/permissions'
import {AppFilePermissionPrompt} from '../src/canvas/apps/files-ui'
import {AppImport} from '../src/canvas/apps/portable'
import {appLinkMenu,panelLinkMenu} from '../src/canvas/apps/links'
import {AppDogFields,appDogSummary,appDogTitle} from '../src/canvas/appdog'
import {DeskDogsProvider} from '../src/canvas/watchdogroute'
import type {FilePrompt} from '../src/canvas/apps/files'
import type {Watchdog} from '../src/types'

// USER 2026-10-27 22:32:48Z m55abf5a34460, answering whether a panel's Connections row for a
// listener on every panel should keep saying "All copies": "use panel nomenclature
// everywhere; say "all panels"." A saved instance of an app is a panel in every word the
// user reads: text, hover text, labels and placeholders. (A duplicate's default name, "<name>
// copy", names a duplicate and is the engine's; no fixture here duplicates.)
const COPY=new RegExp('(^|[^a-z])cop(y|ies)([^a-z]|$)','i')
const ATTRS=['title','aria-label','aria-description','placeholder']
/** Each matching text with 40 characters around the match, so a failure shows where it is. */
const hits=(texts:string[])=>texts.flatMap(s=>{const m=COPY.exec(s);return m?[s.slice(Math.max(0,m.index-40),m.index+m[0].length+40)]:[]})
/** Everything a person reads in root: its text, and the hover, label and placeholder text of it and its descendants. */
const words=(root:Element)=>[root.textContent??'',...[root,...root.querySelectorAll('*')].flatMap(e=>ATTRS.map(a=>e.getAttribute(a)??''))].filter(Boolean)
const noCopy=(root:Element,where:string)=>assert.deepEqual(hits(words(root)),[],where+' calls a panel a copy')

const tick=async()=>{for(let i=0;i<8;i++)await flush()}
const capabilities=['events.fire','net.fetch','files.read','files.write']
const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities,events:[{name:'submitted'}],permissions:{},created_by:'maker',updated_at:'',definition:{name:'Notes',description:'Saved notes',html:'<p>Notes</p>',initial_state:{},capabilities,width:360,height:280}}
const saved=(id:string,label:string)=>({id,app:'notes',label,rev:1,open:false,running:false,state:{note:id},event_seq:0,placement:{mode:'float' as const,x:40,y:40,width:360,height:280},used_at:'',updated_at:''})
const first=saved('first','First notes'),second=saved('second','Second notes')
type Sub={id:string;owner:string;name:string;event_name:string;panel:string|null;all_panels:boolean;state:string;once:boolean;notice:boolean;fired:number}
const everywhere:Sub={id:'worker/all-notes',owner:'worker',name:'all-notes',event_name:'submitted',panel:null,all_panels:true,state:'armed',once:false,notice:false,fired:0}
const here:Sub={id:'worker/first-notes',owner:'worker',name:'first-notes',event_name:'submitted',panel:first.id,all_panels:false,state:'armed',once:false,notice:false,fired:0}
const dog=(s:Sub)=>({id:s.id,owner:s.owner,name:s.name,kind:'app_listener',target:app.id,state:s.state,interval_s:0,fired:0,once:false,spent:false,at:'2026-10-27T07:00:00Z',events:[],event_name:s.event_name,...(s.panel?{panel:s.panel,panel_name:first.label}:{}),all_panels:s.all_panels,app_name:app.name}) as unknown as Watchdog

/** The engine as these windows read it: only the first panel has listeners, one of them on every panel. */
function serve(t:test.TestContext){
  const original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');let out:unknown
    if(url.pathname.endsWith('/files'))out=input.action==='permissions'?{rev:1,permission_rev:1,grants:[]}:input.action==='confirmations'?{items:[]}:undefined
    else if(input.action==='listeners')out={items:input.panel===first.id?[everywhere,here]:[],next_cursor:null}
    else if(input.action==='events')out={panel:input.panel,events:[],next_cursor:null}
    else if(input.action==='panel_get')out=[first,second].find(p=>p.id===input.panel)
    else if(input.action==='permission_history')out={entries:[],next_cursor:null}
    else if(input.action==='list')out={items:[],next_cursor:null,new_count:0}
    else if(input.action==='refs')out={apps:[],panels:[]}
    if(out===undefined)throw Error('Unexpected '+url.pathname+' '+input.action)
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  };t.after(()=>{globalThis.fetch=original})
}
const dialog=(name:string)=>{const found=document.querySelector<HTMLElement>('[role="dialog"][aria-label="'+name+'"]');assert.ok(found,name+' is open');return found!}
const shown=(root:HTMLElement)=>root.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
async function visit(root:HTMLElement,names:string[]){
  for(const name of names){const tab=[...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent?.trim()===name);assert.ok(tab,'a '+name+' tab');await inAct(async()=>{tab!.click();await tick()})}
}
/** Mounts one surface, checks it, and unmounts it even when a check fails. */
async function mounted(node:ReactElement,check:(root:HTMLElement)=>void){
  const view=await mountView(node,e=>e)
  try{await inAct(tick);check(view.el)}finally{view.unmount()}
}

test('Panel settings says panel on every tab, and a listener on every panel says all panels',async t=>{
  serve(t)
  const dogs={org:'panel-words',dogs:[dog(everywhere),dog(here)],open:()=>{}}
  const view=await mountView(<DeskDogsProvider value={dogs}><PanelSettings slug="panel-words" app={app} panel={first} close={()=>{}}/></DeskDogsProvider>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const settings=dialog('Panel settings')
  assert.ok(settings.textContent!.includes('Removes this panel and its saved data.'),'Delete panel says what it removes')
  await visit(settings,['Connections'])
  const connections=shown(settings)
  assert.equal(connections.querySelectorAll('ul[aria-label="Connections"] > li').length,2,'both listeners are listed')
  assert.deepEqual([...connections.querySelectorAll('.custom-app-connection-all')].map(e=>e.textContent),['all panels'],'only the listener on every panel is marked, and it says all panels')
  await visit(settings,['Fire event'])
  assert.equal(shown(settings).querySelector('.custom-app-fire-caption')?.textContent,'Fires from this panel')
  await visit(settings,['History'])
  assert.ok(shown(settings).textContent!.includes('Nothing has fired, started or stopped in this panel yet.'),'the empty History')
  // Every tab has now rendered and stays mounted, so the window's text covers them all.
  await visit(settings,['State','General'])
  noCopy(settings,'Panel settings')
})

test('a panel with no listeners says so in panel words',async t=>{
  serve(t)
  const view=await mountView(<PanelSettings slug="panel-words-empty" app={app} panel={second} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const settings=dialog('Panel settings')
  await visit(settings,['Connections'])
  assert.ok(shown(settings).textContent!.includes('No connected listeners for this panel.'),'the empty Connections tab')
  noCopy(settings,'An empty Connections tab')
})

test('App settings says panel on every tab',async t=>{
  serve(t)
  const view=await mountView(<AppSettings slug="panel-words-app" app={app} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const settings=dialog('App settings')
  assert.ok(settings.textContent!.includes('Maximum 16 MiB and 16 saved panels'),'the export limit counts saved panels')
  await visit(settings,['Events','Permissions','Permission history','General'])
  const text=settings.textContent!
  assert.ok(text.includes("Broadcasts declared events to each panel's subscribed agents."),'the events.fire permission says whose agents hear it')
  noCopy(settings,'App settings')
})

test('the permission and file prompts say every panel of this app',async()=>{
  const finish=()=>{}
  const net={request:{name:'Notes',label:'First notes',app:'notes',panel:'first',capability:'net.fetch',site:'example.test',host:'example.test',request:{method:'GET',url:'https://example.test/feed'},challenge:'net'},finish}
  await mounted(<AppPermissionPrompt prompt={net as never} owner={document}/>,()=>{
    const prompt=dialog('App permission')
    assert.ok(prompt.textContent!.includes('for every panel of this app. Allow once lasts until this panel is hidden or stopped.'),'the internet prompt')
    noCopy(prompt,'The internet prompt')
  })
  const fire={request:{name:'Notes',label:'First notes',app:'notes',panel:'first',capability:'events.fire',request:{action:'events.fire',name:'submitted',payload:{}},challenge:'fire'},finish}
  await mounted(<AppPermissionPrompt prompt={fire as never} owner={document}/>,()=>{
    const prompt=dialog('App permission')
    assert.ok(prompt.textContent!.includes('broadcasts a declared event from this saved panel to every eligible subscribed agent'),'the events.fire prompt')
    assert.ok(prompt.textContent!.includes('Always allow and Deny apply to every panel of this app.'),'the remembered choice')
    noCopy(prompt,'The app action prompt')
  })
  const file:FilePrompt={session:'native-only',request:{app:'notes',panel:'first',name:'Notes',label:'First notes',capability:'files.read',challenge:'scope',request:{action:'open',root:'orgtree',path:'notes.txt'}} as never,finish:()=>{}}
  await mounted(<AppFilePermissionPrompt slug="panel-words-files" prompt={file} owner={document}/>,()=>{
    const prompt=dialog('App file permission')
    assert.ok(prompt.textContent!.includes('Always allow remembers this scope for every panel of this app.'),'the file prompt')
    noCopy(prompt,'The file prompt')
  })
})

test('the import preview, the app and panel menus and an app event watchdog say panel',async()=>{
  const definition={name:'Notes',description:'',html:'<p>Notes</p>',initial_state:{},capabilities:[],width:400,height:300}
  const cases:[{label:string;state:Record<string,unknown>}[],string][]=[[[],'No saved panels.'],[[{label:'Draft',state:{}}],'1 saved panel.'],[[{label:'Draft',state:{}},{label:'Final',state:{}}],'2 saved panels.']]
  for(const [panels,count] of cases)await mounted(<AppImport slug="panel-words-import" bundle={{format:'orgtree-app',version:1,definition,panels}} close={()=>{}}/>,root=>{
    assert.ok(root.textContent!.includes(count),'the preview counts: '+count)
    assert.ok(root.textContent!.includes('Saved panels stay closed until you open them.'),'the preview says saved panels stay closed')
    noCopy(root,'The import preview')
  })
  const anchor=document.body
  const menu=[...appLinkMenu('panel-words','notes',anchor),...panelLinkMenu('panel-words',{id:'first',open:false,running:false},anchor),...panelLinkMenu('panel-words',{id:'second',open:true,running:true},anchor)].flatMap(e=>typeof e==='string'?[]:[e.label,e.description??''])
  assert.ok(menu.includes('Creates a powered-off panel without opening it'),'New panel says what it creates')
  // the entry Copy mention copies a mention token (USER 2026-10-27), not a panel, so it is the one "copy" these menus may say
  assert.deepEqual(hits(menu.filter(label=>label!=='Copy mention')),[],'the app and panel menus call a panel a copy')
  const all=dog(everywhere)
  await mounted(<div><AppDogFields dog={all}/></div>,root=>{
    assert.ok(root.textContent!.includes('all panels'),'the panel field says all panels')
    assert.ok(root.textContent!.includes('every panel, including later ones'),'and what that covers')
    noCopy(root,'The watchdog fields')
  })
  assert.deepEqual(hits([appDogTitle(all),appDogSummary(all,'wakes its agent')]),[],'the watchdog tooltip and sentence call a panel a copy')
})
