import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppSettings,PanelSettings} from '../src/canvas/apps/settings'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {loadAppsMenu} from '../src/canvas/apps/store'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

// UX symmetry audit 2026-10-29 #25/#26/#27 (ux07 S1-S3): a readable list
// distinguishes loading, empty and failure, and a failed read offers an
// in-place Retry — on the first page as on later pages (agent History,
// the presentation gallery). #25 also carries USER 2026-10-29 m019c9500d23a:
// "custom apps should have logs that can be viewed somewhere in the
// settings, either a tab that shows them or a button that opens a file /
// directory" — the tab, matching panel settings' History tab.
const tick=async()=>{for(let i=0;i<8;i++)await flush()}
const t0=Date.UTC(2026,9,29,6,0,0),at=(seq:number)=>new Date(t0+seq*1000).toISOString()
const inputOf=(raw:unknown,init?:RequestInit)=>{const url=new URL(String(raw),'http://local');return init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}')}
const ok=(out:unknown)=>new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
const tabNamed=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent?.trim()===name)!
const shownPanel=()=>document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
const retryIn=(root:ParentNode)=>[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()==='Retry')
const app:CustomApp={id:'notes',name:'Notes',description:'',rev:1,width:360,height:280,capabilities:['events.fire'],events:[{name:'submitted'}],permissions:{},created_by:'maker',updated_at:''} as CustomApp
const panel=(id:string,label:string,used_at:string):CustomPanel=>({id,app:'notes',label,rev:1,open:true,running:true,placement:{mode:'float',x:0,y:0,width:360,height:280},used_at,event_seq:2,updated_at:''} as CustomPanel)
const firedRow=(seq:number,event:string)=>({seq,name:'event.fired',payload:{event,id:'fire-'+seq,subscribers:1},body:'{}',actor:'user',at:at(seq)})

test('#25 a History first load that fails shows its error with a Retry, and retrying loads the list in place',async t=>{
  const state={fail:true},calls:Record<string,any>[]=[],original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const input=inputOf(raw,init);calls.push(input)
    if(input.action==='events'){if(state.fail)throw Error('history read exploded');return ok({panel:'one',events:[firedRow(2,'submitted'),firedRow(1,'submitted')],next_cursor:null,oldest_retained:1})}
    if(input.action==='list')return ok({items:[],next_cursor:null})
    throw Error('Unexpected '+input.action)}
  t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<PanelSettings slug="loaderror-history" app={app} panel={panel('one','First',at(2))} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  await inAct(async()=>{tabNamed('History').click();await tick()})
  const body=shownPanel()
  const reads=()=>calls.filter(c=>c.action==='events')
  assert.deepEqual(reads(),[{action:'events',panel:'one',limit:50}],'one first read')
  assert.match(body.querySelector('[role="alert"]')?.textContent??'',/history read exploded/,'the failure is shown inline')
  assert.equal(body.querySelector('ol[aria-label="History"]'),null,'no list yet')
  const retry=retryIn(body);assert.ok(retry,'the first-page failure offers Retry, like a later page')
  state.fail=false
  await inAct(async()=>{retry!.click();await tick()})
  assert.deepEqual(reads(),[{action:'events',panel:'one',limit:50},{action:'events',panel:'one',limit:50}],'Retry repeats the initial read, not an older-page read')
  assert.equal(body.querySelector('[role="alert"]'),null,'a successful retry clears the error')
  const list=body.querySelector<HTMLElement>('ol[aria-label="History"]')!;assert.ok(list,'the list loads in place')
  assert.equal(list.querySelectorAll(':scope > li > button[aria-expanded]').length,2,'both rows show')
})

test('#25 Permission history first load fails the same way: inline error and Retry on its App settings tab',async t=>{
  const state={fail:true},calls:Record<string,any>[]=[],original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const input=inputOf(raw,init);calls.push(input)
    if(input.action==='permission_history'){if(state.fail)throw Error('permission read exploded');return ok({app:'notes',entries:[{seq:1,capability:'org.read',site:null,permission:'allow',via:'change',actor:'user',panel:null,at:at(1)}],next_cursor:null})}
    if(input.action==='list')return ok({items:[],next_cursor:null})
    throw Error('Unexpected '+input.action)}
  t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<AppSettings slug="loaderror-permissions" app={app} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  await inAct(async()=>{tabNamed('Permission history').click();await tick()})
  const body=shownPanel()
  assert.match(body.querySelector('[role="alert"]')?.textContent??'',/permission read exploded/)
  const retry=retryIn(body);assert.ok(retry,'Permission history offers Retry on its first page too')
  state.fail=false
  await inAct(async()=>{retry!.click();await tick()})
  assert.equal(calls.filter(c=>c.action==='permission_history').length,2,'the initial read repeats')
  assert.ok(body.querySelector('ol[aria-label="Permission history"]'),'the entries load in place')
  assert.equal(body.querySelector('[role="alert"]'),null)
})

test('#26 Connections: a failed first read offers Retry, and a failed later page keeps its rows and stops saying it is loading more',async t=>{
  // jsdom has no IntersectionObserver; stand in one that reports the end row seen at once.
  const hadIO='IntersectionObserver' in globalThis;if(!hadIO)(globalThis as Record<string,unknown>).IntersectionObserver=class{constructor(private cb:(es:{isIntersecting:boolean}[])=>void){}observe(){this.cb([{isIntersecting:true}])}disconnect(){}}
  t.after(()=>{if(!hadIO)delete (globalThis as Record<string,unknown>).IntersectionObserver})
  type Sub={id:string;owner:string;name:string;event_name:string;panel:string;state:string;once:boolean;notice:boolean;fired:number}
  const sub=(n:number):Sub=>({id:'worker/dog-'+n,owner:'worker',name:'dog-'+n,event_name:'submitted',panel:'one',state:'armed',once:false,notice:false,fired:0})
  const subs=[sub(1),sub(2),sub(3),sub(4)],state={failFirst:true,failMore:true},calls:Record<string,any>[]=[],original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const input=inputOf(raw,init);calls.push(input)
    if(input.action==='listeners'){
      if(input.after===undefined){if(state.failFirst)throw Error('connections read exploded');return ok({items:subs.slice(0,2),next_cursor:2})}
      if(state.failMore)throw Error('more connections exploded');return ok({items:subs.slice(2),next_cursor:null})}
    if(input.action==='refs')return ok({apps:[],panels:[]})
    if(input.action==='list')return ok({items:[],next_cursor:null})
    if(input.action==='events')return ok({panel:'one',events:[],next_cursor:null})
    throw Error('Unexpected '+input.action)}
  t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<PanelSettings slug="loaderror-connections" app={app} panel={panel('one','First',at(2))} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  await inAct(async()=>{tabNamed('Connections').click();await tick()})
  const body=shownPanel(),rows=()=>body.querySelectorAll('ul[aria-label="Connections"] > li:not(.custom-app-log-more)').length
  const endRow=()=>body.querySelector<HTMLElement>('li.custom-app-log-more')
  // First read failed: the error is inline with a Retry, and nothing claims to be loading.
  assert.equal(rows(),0)
  assert.match(body.querySelector('[role="alert"]')?.textContent??'',/connections read exploded/)
  assert.doesNotMatch(body.textContent??'',/Loading more connections/,'no stale loading-more after a failure')
  let retry=retryIn(body);assert.ok(retry,'the failed first read offers Retry')
  state.failFirst=false
  await inAct(async()=>{retry!.click();await tick()})
  // First page loaded; the end row came into view and its page failed too.
  assert.equal(rows(),2,'the loaded rows stay when a later page fails')
  assert.deepEqual(calls.filter(c=>c.action==='listeners').at(-1),{action:'listeners',app:'notes',panel:'one',limit:200,after:2},'the later page was the one that failed')
  assert.doesNotMatch(endRow()?.textContent??'',/Loading more connections as you scroll/,'the end row no longer says it is loading')
  retry=retryIn(endRow()??body);assert.ok(retry,'the failed later page offers its own Retry')
  state.failMore=false
  await inAct(async()=>{retry!.click();await tick()})
  assert.equal(rows(),4,'retrying the later page appends it, keeping the first page')
  assert.deepEqual(calls.filter(c=>c.action==='listeners').at(-1),{action:'listeners',app:'notes',panel:'one',limit:200,after:2},'the retry repeats the failed page, not the first')
  assert.equal(body.querySelector('[role="alert"]'),null,'the error clears')
})

test('#27 the Apps menu says "No apps yet" only after a successful empty read; a failed read shows its error with a Retry',async t=>{
  const state={fail:true},original=globalThis.fetch
  Object.defineProperty(document,'hidden',{configurable:true,value:false})
  globalThis.fetch=async(raw,init)=>{const input=inputOf(raw,init)
    if(state.fail)throw Error('catalog exploded')
    if(input.action==='list')return ok({items:[],next_cursor:null,new_count:0})
    if(input.action==='runtime')return ok({items:[],next_cursor:null})
    throw Error('Unexpected '+input.action)}
  t.after(()=>{globalThis.fetch=original;delete (document as unknown as Record<string,unknown>).hidden})
  const slug='loaderror-menu',view=await mountView(<><AppsButton slug={slug}/><AppsWorkspace slug={slug}/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})
  const menu=document.querySelector<HTMLElement>('.custom-apps-menu')!;assert.ok(menu,'the menu opens')
  assert.match(menu.querySelector('[role="alert"]')?.textContent??'',/catalog exploded/,'the failed read is shown inline')
  assert.doesNotMatch(menu.textContent??'',/No apps yet/,'a failed read never claims the catalog is empty')
  const retry=retryIn(menu);assert.ok(retry,'the failed read offers Retry')
  state.fail=false
  await inAct(async()=>{retry!.click();await tick()})
  assert.equal(menu.querySelector('[role="alert"]'),null,'a successful retry clears the error')
  assert.match(menu.textContent??'',/No apps yet\. Ask an agent to make an app for you, and it will appear here\./,'the ruled empty wording shows after the successful empty read')
})

test('#25 App settings has a History tab: pick a panel and read its log without opening that panel',async t=>{
  const slug='app-history-tab',p1=panel('one','First',at(3)),p2=panel('two','Second',at(9)),calls:Record<string,any>[]=[],original=globalThis.fetch
  const byCreated=[p1,p2]
  globalThis.fetch=async(raw,init)=>{const input=inputOf(raw,init);calls.push(input)
    if(input.action==='list'&&input.kind==='apps')return ok({kind:'apps',items:[app],next_cursor:null,new_count:0})
    if(input.action==='list'&&input.kind==='panels')return ok({kind:'panels',items:byCreated,next_cursor:null})
    if(input.action==='events')return ok({panel:input.panel,events:[firedRow(1,input.panel==='two'?'from-second':'from-first')],next_cursor:null,oldest_retained:1})
    throw Error('Unexpected '+input.action)}
  t.after(()=>{globalThis.fetch=original})
  await inAct(async()=>{await loadAppsMenu(slug);await tick()})
  const view=await mountView(<AppSettings slug={slug} app={app} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const tabs=[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map(b=>b.textContent?.trim())
  assert.deepEqual(tabs,['General','Events','Permissions','History','Permission history'],'History joins the App settings tabs, Permission history keeping its signed last place')
  await inAct(async()=>{tabNamed('History').click();await tick()})
  const body=shownPanel()
  const picker=body.querySelector<HTMLSelectElement>('select[aria-label="Panel"]')!;assert.ok(picker,'the tab chooses which panel\'s log to read')
  assert.deepEqual([...picker.options].map(o=>o.textContent),['First','Second'],'the app\'s panels, in creation order like the Apps menu')
  assert.equal(picker.value,'two','it opens on the most recently used panel, as opening the app does')
  const list=()=>body.querySelector<HTMLElement>('ol[aria-label="History"]')
  assert.ok(list(),'the panel\'s History list shows in App settings')
  assert.match(list()!.textContent??'',/from-second/)
  assert.deepEqual(calls.filter(c=>c.action==='events').at(-1),{action:'events',panel:'two',limit:50},'it reads that panel\'s own log')
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(picker),'value')!.set!.call(picker,'one')
  await inAct(async()=>{picker.dispatchEvent(new window.Event('change',{bubbles:true}));await tick()})
  assert.match(list()!.textContent??'',/from-first/,'choosing another panel reads its log instead')
  assert.deepEqual(calls.filter(c=>c.action==='events').at(-1),{action:'events',panel:'one',limit:50})
})

test('#25 App settings History tab with no panels says so, and reads nothing',async t=>{
  const calls:Record<string,any>[]=[],original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const input=inputOf(raw,init);calls.push(input)
    if(input.action==='list')return ok({items:[],next_cursor:null})
    throw Error('Unexpected '+input.action)}
  t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<AppSettings slug="app-history-empty" app={app} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  await inAct(async()=>{tabNamed('History').click();await tick()})
  const body=shownPanel()
  assert.match(body.textContent??'',/This app has no panels yet\./,'an app with no panels says so in one line')
  assert.equal(calls.some(c=>c.action==='events'),false,'no panel, no log read')
})
