import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as ui from '../src/canvas/apps/ui'
import {pinSurfaceKey,readPinSurfaces,removePinSurface,updatePinSurface} from '../src/canvas/pinspace'

// USER 2026-10-27 mffd8da23dc8f (via @liaison-opus m38b636345303): "also clicking on an existing open
// app / panel thats visivle brings it to the front". The row of a panel that is open and visible, or an
// app row that resolves to one, raises it and focuses it: a window pin above the other pinned windows,
// a centered panel above the other centered panels, a pop-out's own window restored and focused; the panel's
// window takes the focus, so Esc still hides a centered one. Nothing
// closes, reopens, moves, resizes or changes state; hidden and stopped panels open as before.
// a namespace import, so the red control still bundles before the shared entry point exists
const {AppsButton,AppsWorkspace}=ui,openAppPanel=(ui as unknown as Record<string,unknown>).openAppPanel as ((slug:string,target:{panel:string}|{app:string})=>Promise<{id:string}>)|undefined
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
type Placement={mode:string;x:number;y:number;width:number;height:number}
type Panel={id:string;app:string;label:string;rev:number;open:boolean;running:boolean;run_generation:number;state:Record<string,unknown>;event_seq:number;placement:Placement;linked_agents:string[];created_at:string;used_at:string;updated_at:string}
const pinned=(x:number,y:number):Placement=>({mode:'window',x,y,width:400,height:300})
const centered=():Placement=>({mode:'float',x:40,y:40,width:360,height:280})
const copy=(id:string,label:string,placement:Placement,used_at:string,open=true,running=true):Panel=>({id,app:'notes',label,rev:1,open,running,run_generation:1,state:{},event_seq:0,placement,linked_agents:[],created_at:used_at,used_at,updated_at:''})
const box=(x:number,y:number,width:number,height:number)=>()=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height,toJSON(){return this}}) as DOMRect
// reads and runtime bookkeeping (a started copy's host lease heartbeat), not panel changes
const READS=['list','app_get','panel_get','events','runtime','session_close','heartbeat']
function fixture(t:test.TestContext,slug:string,panels:Panel[]){
 const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',created_at:'2026-10-20T08:00:00Z',updated_at:'',definition:{name:'Notes',description:'',html:'<p>Notes</p>',initial_state:{},capabilities:[],width:360,height:280}}
 const calls:Record<string,any>[]=[],original=globalThis.fetch
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
  const one=()=>panels.find(p=>p.id===input.panel)!
  if(input.action==='list')out={items:input.kind==='apps'?[app]:panels.filter(p=>(input.open===undefined||p.open===input.open)&&(input.running===undefined||p.running===input.running)),next_cursor:null,new_count:0}
  else if(input.action==='app_get')out=app
  else if(input.action==='panel_get')out=one()
  else if(input.action==='events')out={events:[],next_cursor:null,oldest_retained:null}
  else if(input.action==='runtime'||input.action==='session_close')out={items:[],next_cursor:null}
  else if(input.action==='heartbeat')out={stop:[],sample_epoch:0}
  // Like the engine: opening is a use (used_at) and starts a stopped copy; it never moves one.
  // with only the app, the engine picks its most recently used copy (used_at, then ID)
  else if(input.action==='panel_open'){const p=input.panel?one():panels.filter(x=>x.app===input.app).sort((a,b)=>b.used_at.localeCompare(a.used_at)||(a.id<b.id?1:-1))[0]!;p.open=true;p.running=true;p.used_at='2026-10-27T08:00:00Z';p.rev++;out=p}
  else if(input.action==='panel_update'){const p=one();assert.equal(input.expected_rev,p.rev);for(const k of ['label','open','placement'])if(k in input)(p as Record<string,unknown>)[k]=input[k];p.rev++;out=p}
  else throw Error('Unexpected '+input.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 }
 // The org's canvas area as OrgCanvas's viewport publishes it (jsdom lays out nothing).
 const area=document.createElement('div');area.dataset.pinOrg=slug;area.style.border='0';area.getBoundingClientRect=box(0,40,1600,900);document.body.appendChild(area)
 t.after(()=>{globalThis.fetch=original;delete (document as unknown as Record<string,unknown>).hidden;area.remove();for(const s of readPinSurfaces().filter(s=>s.org===slug))removePinSurface(s.key)})
 return{calls,panels}
}
async function workspace(t:test.TestContext,slug:string,panels:Panel[]){
 const f=fixture(t,slug,panels),view=await mountView(<><AppsButton slug={slug}/><AppsWorkspace slug={slug}/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 const menu=()=>document.querySelector<HTMLElement>('.custom-apps-menu')
 return{...f,menu,
  toggle:()=>inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()}),
  row:(label:string)=>menu()!.querySelector<HTMLButtonElement>(`.custom-apps-saved[aria-label^="${label},"]`)!,
  appRow:()=>menu()!.querySelector<HTMLElement>('.custom-apps-menu-app')!,
  click:(e:HTMLElement)=>inAct(async()=>{e.click();await tick()}),
  // engine writes since a mark: reads (list, app_get...) are not changes
  writes:(from:number)=>f.calls.slice(from).filter(c=>!READS.includes(c.action))}
}
const frame=(id:string)=>document.querySelector<HTMLElement>(`[data-custom-panel="${id}"]`)!
const content=(id:string)=>frame(id).querySelector('iframe')
const top=(slug:string)=>[...readPinSurfaces()].filter(s=>s.org===slug).sort((a,b)=>b.order-a.order)[0]?.key

test('the row of a visible window-pinned panel brings it in front of the other pinned windows and focuses it, moving nothing',async t=>{
 const slug='raise-pinned',w=await workspace(t,slug,[copy('one','Panel 1',pinned(100,80),'2026-10-26T10:00:00Z'),copy('two','Panel 2',pinned(200,150),'2026-10-26T11:00:00Z')])
 // a pinned desk registered after both panels stacks above them
 const desk=pinSurfaceKey(slug,'worker')
 await inAct(async()=>{updatePinSurface(desk,slug,{x:150,y:120,w:320,h:240},false);await tick()})
 assert.ok(content('one'),'Panel 1 runs its HTML');assert.equal(top(slug),desk,'the desk is in front')
 assert.ok(Number(frame('one').style.zIndex)<Number(frame('two').style.zIndex),'Panel 1 is buried under Panel 2')
 await w.toggle();const mark=w.calls.length
 await w.click(w.row('Panel 1'))
 assert.equal(w.menu(),null,'the list closes')
 assert.equal(top(slug),pinSurfaceKey(slug,'custom-app:one',true),'Panel 1 is now in front of the desk and Panel 2')
 assert.ok(Number(frame('one').style.zIndex)>Number(frame('two').style.zIndex),'Panel 1 stacks above Panel 2')
 assert.equal(document.activeElement,frame('one'),'its window has the focus')
 assert.deepEqual(w.writes(mark),[{action:'panel_open',panel:'one'}],'the click records the use and nothing else')
 assert.deepEqual([w.panels[0]!.placement,w.panels[0]!.open,w.panels[0]!.running],[pinned(100,80),true,true],'not moved, resized, hidden or stopped')
 assert.deepEqual([frame('one').style.left,frame('one').style.top,frame('one').style.width,frame('one').style.height],['100px','80px','400px','300px'])
 // focusable only for the raise: once the window loses the focus, a click on its chrome works as before
 await inAct(async()=>{frame('one').blur();await tick()})
 assert.equal(frame('one').hasAttribute('tabindex'),false,'no tabindex is left behind')
})

test('the row of a visible centered panel under another centered panel brings it in front, and Esc then hides that one',async t=>{
 const slug='raise-centered',w=await workspace(t,slug,[copy('one','Panel 1',centered(),'2026-10-26T10:00:00Z'),copy('two','Panel 2',centered(),'2026-10-26T11:00:00Z')])
 const overlay=(id:string)=>frame(id).closest<HTMLElement>('.overlay.custom-app-centered')!
 assert.ok(overlay('one')&&overlay('two'),'both panels are centered windows')
 assert.ok(content('one'),'Panel 1 runs its HTML')
 await w.toggle();const mark=w.calls.length
 await w.click(w.row('Panel 1'))
 assert.equal(w.menu(),null,'the list closes')
 assert.deepEqual([overlay('one').classList.contains('custom-app-behind'),overlay('two').classList.contains('custom-app-behind')],[false,true],'Panel 1 is in front, Panel 2 just under it')
 assert.equal(document.activeElement,frame('one'),'its window has the focus')
 assert.deepEqual(w.writes(mark),[{action:'panel_open',panel:'one'}],'the click records the use and nothing else')
 // Esc acts on what is in front: Panel 1 hides, Panel 2 stays and comes back in front.
 await inAct(async()=>{window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick()})
 assert.deepEqual(w.writes(mark).filter(c=>c.action==='panel_update').map(c=>[c.panel,c.open]),[['one',false]],'Esc hides the panel in front')
 assert.equal(overlay('two').classList.contains('custom-app-behind'),false,'Panel 2 is in front again')
})

test('the app row raises its most recently used panel when that panel is visible',async t=>{
 const slug='raise-app-row',w=await workspace(t,slug,[copy('one','Panel 1',pinned(100,80),'2026-10-26T12:00:00Z'),copy('two','Panel 2',pinned(200,150),'2026-10-26T11:00:00Z')])
 assert.equal(top(slug),pinSurfaceKey(slug,'custom-app:two',true),'Panel 2 is in front; Panel 1 was used last')
 await w.toggle();const mark=w.calls.length
 await w.click(w.appRow())
 assert.equal(top(slug),pinSurfaceKey(slug,'custom-app:one',true),'the app row brought Panel 1 to the front')
 assert.equal(document.activeElement,frame('one'),'its window has the focus')
 assert.deepEqual(w.writes(mark),[{action:'panel_open',panel:'one'}])
})

test('the row of a visible popped-out panel restores and focuses its own window without reopening it',async t=>{
 const realOpen=window.open,host=window as Window&{orgtreeDesktop?:unknown},realBridge=host.orgtreeDesktop
 const g=globalThis as Record<string,unknown>,realObserver=g.MutationObserver
 g.MutationObserver=(window as unknown as Record<string,unknown>).MutationObserver
 const doc=document.implementation.createHTMLDocument('synthetic panel window'),commands:string[]=[]
 let opened=0,focused=0
 const noop=()=>{}
 const child={document:doc,closed:false,focus:()=>{focused++},close:noop,screenX:0,screenY:0,outerWidth:900,outerHeight:700,
  addEventListener:noop,removeEventListener:noop,requestAnimationFrame:(cb:(at:number)=>void)=>setTimeout(()=>cb(0),0),cancelAnimationFrame:clearTimeout}
 Object.defineProperty(doc,'defaultView',{value:child,configurable:true})
 window.open=(()=>{opened++;return child as unknown as Window}) as typeof window.open
 host.orgtreeDesktop={focusPopout:(name:string)=>{commands.push(name);return Promise.resolve()}}
 t.after(()=>{window.open=realOpen;if(realBridge===undefined)delete host.orgtreeDesktop;else host.orgtreeDesktop=realBridge;if(realObserver===undefined)delete g.MutationObserver;else g.MutationObserver=realObserver})
 const slug='raise-popout',w=await workspace(t,slug,[copy('one','Panel 1',centered(),'2026-10-26T10:00:00Z')])
 await w.click(frame('one').querySelector<HTMLButtonElement>('[aria-label="Open in new window"]')!)
 assert.equal(opened,1,'the panel popped out');assert.equal(w.panels[0]!.placement.mode,'popout')
 const before={focused,commands:commands.length}
 await w.toggle();const mark=w.calls.length
 await w.click(w.row('Panel 1'))
 assert.equal(w.menu(),null,'the list closes')
 assert.equal(opened,1,'no second window')
 assert.ok(focused>before.focused,'its window is focused')
 assert.equal(commands.length,before.commands+1,'the native restore-and-focus is asked once');assert.match(commands.at(-1)!,/^orgtree-popout-\d+$/)
 assert.deepEqual(w.writes(mark),[{action:'panel_open',panel:'one'}],'the click records the use and nothing else')
})

test('rows of hidden and stopped panels open them as before',async t=>{
 const slug='raise-hidden',w=await workspace(t,slug,[copy('one','Panel 1',pinned(100,80),'2026-10-26T10:00:00Z',false,true),copy('two','Panel 2',pinned(200,150),'2026-10-26T11:00:00Z'),copy('three','Panel 3',centered(),'2026-10-26T09:00:00Z',false,false)])
 await w.toggle();let mark=w.calls.length
 await w.click(w.row('Panel 1'))
 assert.deepEqual(w.writes(mark),[{action:'panel_open',panel:'one'}],'a hidden running panel is shown by panel_open')
 assert.equal(w.panels[0]!.open,true)
 assert.equal(top(slug),pinSurfaceKey(slug,'custom-app:one',true),'a window pin shown again comes in front, as before')
 await w.toggle();mark=w.calls.length
 await w.click(w.row('Panel 3'))
 assert.deepEqual(w.writes(mark),[{action:'panel_open',panel:'three'}],'a stopped panel is started and shown by panel_open')
 assert.deepEqual([w.panels[2]!.open,w.panels[2]!.running],[true,true])
})

test('openAppPanel, the entry point mentions share, raises the copy the engine picks for an app only when it was already visible',async t=>{
 const slug='raise-entry',w=await workspace(t,slug,[copy('one','Panel 1',pinned(100,80),'2026-10-26T12:00:00Z'),copy('two','Panel 2',pinned(200,150),'2026-10-26T11:00:00Z'),copy('three','Panel 3',pinned(300,200),'2026-10-26T09:00:00Z',false,true)])
 assert.equal(top(slug),pinSurfaceKey(slug,'custom-app:two',true),'Panel 2 is in front; Panel 1 was used last')
 assert.equal(typeof openAppPanel,'function','the Apps module exports openAppPanel')
 let opened:{id:string}|undefined,mark=w.calls.length
 await inAct(async()=>{opened=await openAppPanel!(slug,{app:'notes'});await tick()})
 assert.equal(opened?.id,'one','the engine picked the most recently used copy')
 assert.deepEqual(w.writes(mark),[{action:'panel_open',app:'notes'}],'one panel_open with only the app')
 assert.equal(top(slug),pinSurfaceKey(slug,'custom-app:one',true),'that visible copy came to the front')
 assert.equal(document.activeElement,frame('one'),'its window has the focus')
 // A hidden copy the engine picks just opens, as it always did: shown in front, no focus taken.
 w.panels[2]!.used_at='2026-10-27T09:00:00Z';(document.activeElement as HTMLElement|null)?.blur?.();mark=w.calls.length
 await inAct(async()=>{opened=await openAppPanel!(slug,{app:'notes'});await tick()})
 assert.equal(opened?.id,'three');assert.deepEqual(w.writes(mark),[{action:'panel_open',app:'notes'}])
 assert.equal(top(slug),pinSurfaceKey(slug,'custom-app:three',true),'a window pin shown again comes in front, as before')
 assert.notEqual(document.activeElement,frame('three'),'opening a hidden copy takes no focus, as before')
})
