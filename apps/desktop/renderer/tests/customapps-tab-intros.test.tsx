import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type {ReactElement} from 'react'
import {AppSettings,PanelSettings} from '../src/canvas/apps/settings'
import type {PermissionHistoryEntry} from '../src/canvas/apps/types'

// USER 2026-10-28 on 4.5.0-alpha.8, of the intro paragraph at the top of a settings tab:
// m967c09464607 "remove this blurb" (Connections), mbba17a6166d1 "remove this blurb too
// actually" (State), m1ebf5e3194c8 "and this one" (History), m420ce21a63f4 "and this one"
// (Permission history), then md0c3fe54b8d0 "Remove all of them": no App settings or Panel
// settings tab opens with an intro paragraph; the user guide and glossary keep the
// explanations. What stays: the app's own description above the tabs, an event's declared
// description, row hints, section notes, the Fire event list caption and empty-state lines.
const INTROS=['Agents subscribe with an app_listener watchdog','Each panel keeps its own JSON data','Fired events agents can listen to','Permission changes and prompt answers','Changes save immediately']
const tick=async()=>{for(let i=0;i<8;i++)await flush()}
const capabilities=['events.fire','files.read']
const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities,events:[{name:'submitted',description:'A note was submitted.'}],permissions:{},created_by:'maker',updated_at:'',definition:{name:'Notes',description:'Saved notes',html:'<p>Notes</p>',initial_state:{},capabilities,width:360,height:280}}
const panel={id:'first',app:'notes',label:'First notes',rev:1,open:false,running:false,state:{note:'first'},event_seq:0,placement:{mode:'float' as const,x:40,y:40,width:360,height:280},used_at:'',updated_at:''}
const at='2026-10-28T09:00:00.000Z'
const listener={id:'worker/notes',owner:'worker',name:'notes',event_name:'submitted',panel:panel.id,all_panels:false,state:'armed',once:false,notice:false,fired:1}
const fired={seq:1,name:'event.fired',payload:{event:'submitted',subscribers:1,id:'app-event-1'},body:'{}',actor:'user',at}
const change:PermissionHistoryEntry={seq:1,capability:'events.fire',site:null,permission:'allow',via:'change',actor:'user',panel:null,at}

/** The engine as these windows read it; with empty, every list is empty. */
function serve(t:test.TestContext,empty=false){
  const original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');let out:unknown
    if(url.pathname.endsWith('/files'))out=input.action==='permissions'?{rev:1,permission_rev:1,grants:[]}:input.action==='confirmations'?{items:[]}:undefined
    else if(input.action==='listeners')out={items:empty?[]:[listener],next_cursor:null}
    else if(input.action==='events')out={panel:input.panel,events:empty?[]:[fired],next_cursor:null}
    else if(input.action==='panel_get')out=panel
    else if(input.action==='permission_history')out={app:app.id,entries:empty?[]:[change],next_cursor:null}
    else if(input.action==='list')out={items:[],next_cursor:null,new_count:0}
    else if(input.action==='refs')out={apps:[],panels:[]}
    if(out===undefined)throw Error('Unexpected '+url.pathname+' '+input.action)
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  };t.after(()=>{globalThis.fetch=original})
}
const dialog=(name:string)=>{const found=document.querySelector<HTMLElement>('[role="dialog"][aria-label="'+name+'"]');assert.ok(found,name+' is open');return found!}
async function open(root:HTMLElement,name:string){
  const tab=[...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent?.trim()===name);assert.ok(tab,'a '+name+' tab')
  await inAct(async()=>{tab!.click();await tick()})
  return root.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
}
/** What a tab shows first, below its group wrappers, as tag.classes. */
function lead(tab:HTMLElement){
  let e=tab.firstElementChild
  while(e?.matches('.set-group,section')&&e.firstElementChild)e=e.firstElementChild
  return e?e.tagName+[...e.classList].map(c=>'.'+c).join(''):'nothing'
}
/** The tabs that open on a paragraph, each with what it shows first. */
async function paragraphLeads(root:HTMLElement,tabs:string[]){
  const leads:Record<string,string>={}
  for(const name of tabs)leads[name]=lead(await open(root,name))
  return Object.fromEntries(Object.entries(leads).filter(([,first])=>first.startsWith('P')))
}
const paragraphs=(root:Element)=>[...root.querySelectorAll('p')].map(p=>p.textContent)
/** Mounts one window, checks it, and unmounts it even when a check fails. */
async function mounted(node:ReactElement,check:()=>Promise<void>){
  const view=await mountView(node,e=>e)
  try{await inAct(tick);await check()}finally{view.unmount()}
}

test('no Panel settings tab opens with an intro paragraph',async t=>{
  serve(t)
  await mounted(<PanelSettings slug="tab-intros" app={app} panel={panel} close={()=>{}}/>,async()=>{
    const settings=dialog('Panel settings')
    assert.deepEqual(await paragraphLeads(settings,['General','State','Connections','Fire event','History']),{},'tabs that open on a paragraph')
    // Every visited tab stays mounted, so the window's text covers them all.
    assert.deepEqual(INTROS.filter(s=>settings.textContent!.includes(s)),[],'no intro text anywhere in the window')
    const fire=await open(settings,'Fire event')
    assert.ok(fire.textContent!.includes('A note was submitted.'),"an event's declared description stays")
    assert.equal(fire.querySelector('.custom-app-fire-caption')?.textContent,'Fires from this panel','the caption of the list of fires stays: it is not at the top of the tab')
  })
})

test('no App settings tab opens with an intro paragraph, and the app description stays above the tabs',async t=>{
  serve(t)
  await mounted(<AppSettings slug="tab-intros-app" app={app} close={()=>{}}/>,async()=>{
    const settings=dialog('App settings')
    const description=settings.querySelector('p.dim'),tabs=settings.querySelector('[role="tablist"]')!
    assert.equal(description?.textContent,'Saved notes',"the app's own description stays")
    assert.ok(description!.compareDocumentPosition(tabs)&Node.DOCUMENT_POSITION_FOLLOWING,'above the tabs')
    assert.deepEqual(await paragraphLeads(settings,['General','Events','Permissions','Permission history']),{},'tabs that open on a paragraph')
    assert.deepEqual(INTROS.filter(s=>settings.textContent!.includes(s)),[],'no intro text anywhere in the window')
  })
})

test('an empty Connections, History or Permission history shows only its one line',async t=>{
  serve(t,true)
  await mounted(<PanelSettings slug="tab-intros-empty" app={app} panel={panel} close={()=>{}}/>,async()=>{
    const settings=dialog('Panel settings')
    assert.deepEqual(paragraphs(await open(settings,'Connections')),['No connected listeners for this panel.'])
    assert.deepEqual(paragraphs(await open(settings,'History')),['Nothing has fired, started or stopped in this panel yet.'])
  })
  await mounted(<AppSettings slug="tab-intros-app-empty" app={app} close={()=>{}}/>,async()=>{
    assert.deepEqual(paragraphs(await open(dialog('App settings'),'Permission history')),['No permission changes yet.'])
  })
})
