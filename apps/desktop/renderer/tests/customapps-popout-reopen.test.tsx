import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import * as ui from '../src/canvas/apps/ui'
import {readPinSurfaces,removePinSurface} from '../src/canvas/pinspace'

// USER 2026-10-27 m1a23cd457070: "if i shut down a popped panel and reopen it, it doesnt appear as
// popped out, and is undraggable", and m4691725be7a7: "it appears as though pinned, but the pin button
// is unhighlighed". A popped-out panel that is powered off and opened again comes back popped out, in
// its own window at that window's last place and size. Until its window is open, or where none can
// open, it is the centered panel, never a box fixed at its record's x/y. Floating and window-pinned
// panels reopen where they were, and a pinned one still drags.
declare const __SRC_DIR__: string
const {AppsButton,AppsWorkspace}=ui
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
// longer than the zoom-out (about 180 ms) and the cleanup after it
const wait=(ms=450)=>inAct(async()=>{await new Promise(r=>setTimeout(r,ms));await tick()})
type Placement={mode:string;x:number;y:number;width:number;height:number}
type Panel={id:string;app:string;label:string;rev:number;open:boolean;running:boolean;run_generation:number;state:Record<string,unknown>;event_seq:number;placement:Placement;created_at:string;used_at:string;updated_at:string}
const floating=():Placement=>({mode:'float',x:40,y:40,width:360,height:280})
const copy=(id:string,label:string,placement:Placement):Panel=>({id,app:'clock',label,rev:1,open:true,running:true,run_generation:1,state:{},event_seq:0,placement,created_at:'2026-10-27T07:00:00Z',used_at:'2026-10-27T07:00:00Z',updated_at:''})
const box=(x:number,y:number,width:number,height:number)=>()=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height,toJSON(){return this}}) as DOMRect
// reads, not panel changes (the host's runtime and bridge calls are not recorded)
const READS=['list','app_get','panel_get','events']
function fixture(t:test.TestContext,slug:string,panels:Panel[]){
 const app={id:'clock',name:'Clock',description:'A clock',rev:1,permission_rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',created_at:'2026-10-20T08:00:00Z',updated_at:'',definition:{name:'Clock',description:'',html:'<p>Clock</p>',initial_state:{},capabilities:[],width:360,height:280}}
 const calls:Record<string,any>[]=[],original=globalThis.fetch
 // hold(): panel updates wait until released, to see a panel before its record follows
 let held:Promise<void>|null=null
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');let out:unknown
  const one=()=>{const p=panels.find(p=>p.id===input.panel);if(!p)throw Error('Unknown panel '+String(input.panel));return p}
  if(input.action==='panel_update'&&held)await held
  if(url.pathname.endsWith('/apps/runtime'))out=input.action==='heartbeat'?{stop:[],sample_epoch:0}:{}
  else if(url.pathname.endsWith('/apps/bridge'))out={closed:true}
  else if(calls.push(input)&&input.action==='list')out={items:input.kind==='apps'?[app]:panels.filter(p=>(input.open===undefined||p.open===input.open)&&(input.running===undefined||p.running===input.running)),next_cursor:null,new_count:0}
  else if(input.action==='app_get')out=app
  else if(input.action==='panel_get')out=one()
  else if(input.action==='events')out={events:[],next_cursor:null,oldest_retained:null}
  // Like the engine: opening starts a stopped copy and never moves one; Power off keeps the placement.
  else if(input.action==='panel_open'){const p=one();if(!p.running)p.run_generation++;p.open=true;p.running=true;p.rev++;out=p}
  else if(input.action==='panel_update'){const p=one();assert.equal(input.expected_rev,p.rev);for(const k of ['label','open','placement'])if(k in input)(p as Record<string,unknown>)[k]=input[k];p.rev++;out=p}
  else if(input.action==='panel_stop'){const p=one();p.running=false;p.open=false;p.run_generation++;p.rev++;out=p}
  else throw Error('Unexpected '+input.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 }
 // The org's canvas area as OrgCanvas's viewport publishes it (jsdom lays out nothing).
 const area=document.createElement('div');area.dataset.pinOrg=slug;area.style.border='0';area.getBoundingClientRect=box(0,40,1600,900);document.body.appendChild(area)
 const proto=HTMLElement.prototype as unknown as Record<string,unknown>,had={s:proto.setPointerCapture,r:proto.releasePointerCapture}
 proto.setPointerCapture=()=>{};proto.releasePointerCapture=()=>{}
 t.after(()=>{globalThis.fetch=original;delete (document as unknown as Record<string,unknown>).hidden;area.remove();proto.setPointerCapture=had.s;proto.releasePointerCapture=had.r;for(const s of readPinSurfaces().filter(s=>s.org===slug))removePinSurface(s.key)})
 return{calls,panels,hold:()=>{let release=()=>{};held=new Promise<void>(r=>{release=()=>{held=null;r()}});return release}}
}
/** A pop-out window, as the desktop's window.open answers: its own document, at the place and size it was asked for. */
interface Child {document:Document;closed:boolean;screenX:number;screenY:number;outerWidth:number;outerHeight:number;focus():void;close():void;addEventListener():void;removeEventListener():void;requestAnimationFrame(cb:(at:number)=>void):number;cancelAnimationFrame(id:number):void}
function windows(t:test.TestContext,bridge:Record<string,unknown>={}){
 const realOpen=window.open,host=window as Window&{orgtreeDesktop?:unknown},realBridge=host.orgtreeDesktop
 const g=globalThis as Record<string,unknown>,realObserver=g.MutationObserver
 g.MutationObserver=(window as unknown as Record<string,unknown>).MutationObserver
 const opened:{features:string;child:Child|null}[]=[]
 let blocked=false
 const asked=(features:string,name:string,fallback:number)=>Number(features.match(new RegExp('(?:^|,)'+name+'=(-?\\d+)'))?.[1]??fallback)
 const make=(features:string):Child=>{
  const doc=document.implementation.createHTMLDocument('panel window'),noop=()=>{}
  const child:Child={document:doc,closed:false,screenX:asked(features,'left',200),screenY:asked(features,'top',120),outerWidth:asked(features,'width',900),outerHeight:asked(features,'height',760),
   focus:noop,close(){child.closed=true},addEventListener:noop,removeEventListener:noop,
   requestAnimationFrame:cb=>setTimeout(()=>cb(0),0) as unknown as number,cancelAnimationFrame:id=>clearTimeout(id)}
  Object.defineProperty(doc,'defaultView',{value:child,configurable:true});return child}
 window.open=((_url?:string|URL,_name?:string,features?:string)=>{const child=blocked?null:make(String(features??''));opened.push({features:String(features??''),child});return child as unknown as Window}) as typeof window.open
 host.orgtreeDesktop={focusPopout:()=>Promise.resolve(),hidePopout:()=>Promise.resolve(),...bridge}
 t.after(()=>{window.open=realOpen;if(realBridge===undefined)delete host.orgtreeDesktop;else host.orgtreeDesktop=realBridge;if(realObserver===undefined)delete g.MutationObserver;else g.MutationObserver=realObserver})
 return{opened,block:(on:boolean)=>{blocked=on}}
}
async function workspace(t:test.TestContext,slug:string,panels:Panel[]){
 const f=fixture(t,slug,panels),view=await mountView(<><AppsButton slug={slug}/><AppsWorkspace slug={slug}/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 const menu=()=>document.querySelector<HTMLElement>('.custom-apps-menu')
 return{...f,
  toggle:()=>inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()}),
  row:(label:string)=>menu()!.querySelector<HTMLButtonElement>(`.custom-apps-saved[aria-label^="${label},"]`)!,
  click:(e:HTMLElement|null|undefined,what:string)=>{assert.ok(e,what+' is missing');return inAct(async()=>{e.click();await tick()})},
  // engine writes since a mark: reads (list, app_get...) are not changes
  writes:(from:number)=>f.calls.slice(from).filter(c=>!READS.includes(c.action))}
}
/** The panel's window wherever it is: the main window or a pop-out that is still open. */
const find=(id:string,w?:{opened:{child:Child|null}[]})=>[document,...(w?.opened??[]).flatMap(o=>o.child&&!o.child.closed?[o.child.document]:[])]
 .map(d=>d.querySelector<HTMLElement>(`section[data-custom-panel="${id}"]`)).find(Boolean)??null
const button=(section:HTMLElement|null,label:string)=>section?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
const pointer=(type:string,x:number,y:number)=>new window.PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:type==='pointermove'?-1:0,buttons:1,clientX:x,clientY:y})

test('a popped-out panel powered off and opened again comes back popped out, at its window\'s last place and size',async t=>{
 const w=windows(t),slug='reopen-popout',f=await workspace(t,slug,[copy('clock','Clock',floating())])
 await f.click(button(find('clock'),'Open in new window'),'the pop-out button')
 assert.equal(w.opened.length,1,'the panel popped out');assert.equal(f.panels[0]!.placement.mode,'popout')
 const first=w.opened[0]!.child!
 assert.equal(find('clock',w)?.ownerDocument,first.document,'in its own window')
 // the user moves and resizes that window, then powers the panel off from it
 Object.assign(first,{screenX:520,screenY:310,outerWidth:640,outerHeight:480})
 await f.click(button(find('clock',w),'Power off Clock'),'the header Power off')
 await wait()
 assert.equal(first.closed,true,'Power off closes its window');assert.equal(find('clock',w),null)
 assert.equal(f.panels[0]!.placement.mode,'popout','the record still says popped out')
 await f.toggle();const mark=f.calls.length
 await f.click(f.row('Clock'),'the saved row of the off panel')
 assert.equal(w.opened.length,2,'opening it again opens its own window again')
 const again=w.opened[1]!
 assert.match(again.features,/(?:^|,)left=520,top=310,width=640,height=480(?:,|$)/,'at that window\'s last place and size')
 const section=find('clock',w);assert.ok(section)
 assert.equal(section.ownerDocument,again.child!.document,'the panel is in that window, not in the main window')
 assert.equal(section.dataset.detached,'true','its title bar drags that window (the pop-out drag region)')
 assert.equal(section.dataset.motion,'start','it zooms in there, as a start')
 assert.equal(document.querySelector('[data-custom-panel="clock"]'),null,'nothing of it shows in the main window')
 assert.deepEqual(f.writes(mark),[{action:'panel_open',panel:'clock'}],'only the open is written: the record already says popped out')
 // Return to main window still restores the placement it had before it first popped out.
 await f.click(button(section,'Return to main window'),'Return to main window')
 assert.equal(again.child!.closed,true,'its window closes')
 assert.equal(f.panels[0]!.placement.mode,'float','its earlier placement comes back')
 assert.ok(find('clock')?.hasAttribute('data-centered'),'as the centered panel in the main window')
})

test('a desktop that answers its window state late still reopens the pop-out as the panel mounts',async t=>{
 // as the preload's IPC does; the panel restored at launch has heard the answer by then
 const w=windows(t,{getWindowState:()=>new Promise(r=>setTimeout(()=>r({visible:true,restoreWindows:true}),250)),onEvent:()=>()=>{}})
 const slug='reopen-late-state',f=await workspace(t,slug,[copy('clock','Clock',floating())])
 await wait(320)
 await f.click(button(find('clock'),'Open in new window'),'the pop-out button')
 await f.click(button(find('clock',w),'Power off Clock'),'the header Power off')
 await wait()
 await f.toggle();await f.click(f.row('Clock'),'the saved row of the off panel')
 assert.equal(w.opened.length,2,'its window opens as it mounts, not a window-state answer later')
 assert.equal(find('clock',w)?.ownerDocument,w.opened[1]!.child!.document,'and it is in that window')
 assert.equal(document.querySelector('[data-custom-panel="clock"]'),null,'not in the main window meanwhile')
})

test('a popped-out panel whose window cannot open again is the centered panel, saying why, not a box that looks pinned',async t=>{
 const w=windows(t),slug='reopen-blocked',f=await workspace(t,slug,[copy('clock','Clock',floating())])
 await f.click(button(find('clock'),'Open in new window'),'the pop-out button')
 await f.click(button(find('clock',w),'Power off Clock'),'the header Power off')
 await wait()
 w.block(true)
 await f.toggle();await f.click(f.row('Clock'),'the saved row of the off panel')
 const section=find('clock',w);assert.ok(section,'it opens in the main window')
 assert.equal(section.closest('.custom-app-placeholder'),null,'not in a box fixed at its record\'s x/y')
 assert.ok(section.hasAttribute('data-centered'),'as the centered panel')
 assert.ok(section.closest('.overlay.custom-app-centered'),'with the centered panel\'s backdrop')
 assert.equal(w.opened.length,2,'it did try to open its window again')
 assert.match(document.body.textContent??'',/The browser blocked this window/,'it says why it is not in its own window')
 assert.equal(f.panels[0]!.placement.mode,'float','its record follows: centered')
 const pin=button(section,'Pin to window');assert.equal(pin?.getAttribute('aria-pressed'),'false','its pin is unlit because it is not pinned')
 section.getBoundingClientRect=box(620,300,360,280)
 await f.click(pin,'the pin')
 assert.equal(f.panels[0]!.placement.mode,'window','and the pin pins it, as for any centered panel')
})

test('where no window can open (no desktop), a panel whose record says popped out is the centered panel',async t=>{
 const slug='reopen-browser',f=await workspace(t,slug,[copy('clock','Clock',{mode:'popout',x:40,y:40,width:360,height:280})])
 const section=find('clock');assert.ok(section,'it shows in the main window')
 assert.equal(section.closest('.custom-app-placeholder'),null,'not in a box fixed at its record\'s x/y')
 assert.ok(section.hasAttribute('data-centered'),'as the centered panel, with its backdrop')
 assert.equal(button(section,'Pin to window')?.getAttribute('aria-pressed'),'false')
 const mark=f.calls.length
 await inAct(async()=>{window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick()})
 assert.deepEqual(f.writes(mark).map(c=>[c.action,c.open]),[['panel_update',false]],'Esc hides it, as any centered panel')
})

test('Return from a pop-out shows the panel at its earlier place at once, before its record follows',async t=>{
 const w=windows(t),slug='reopen-return',f=await workspace(t,slug,[copy('pin','Pinned',{mode:'window',x:120,y:80,width:400,height:300})])
 await f.click(button(find('pin'),'Open in new window'),'the pop-out button')
 assert.equal(find('pin',w)?.ownerDocument,w.opened[0]!.child!.document,'popped out')
 const release=f.hold()
 await f.click(button(find('pin',w),'Return to main window'),'Return to main window')
 const back=find('pin');assert.ok(back,'back in the main window')
 assert.equal(f.panels[0]!.placement.mode,'popout','its record has not followed yet')
 assert.equal(back.hasAttribute('data-centered'),false,'not the centered panel first')
 assert.ok(document.querySelector(`[data-pin-layer="${slug}"]`)?.contains(back),'already the window pin')
 assert.deepEqual([back.style.left,back.style.top,back.style.width,back.style.height],['120px','80px','400px','300px'],'at its spot and size')
 assert.equal(button(back,'Unpin')?.getAttribute('aria-pressed'),'true','with its pin lit')
 await inAct(async()=>{release();await tick()})
 assert.equal(f.panels[0]!.placement.mode,'window','then its record follows')
 assert.ok(document.querySelector(`[data-pin-layer="${slug}"]`)?.contains(find('pin')),'and it stays there')
})

test('a popped-out panel leaves no box in the main window',async t=>{
 const w=windows(t),slug='reopen-placeholder',f=await workspace(t,slug,[copy('clock','Clock',floating())])
 await f.click(button(find('clock'),'Open in new window'),'the pop-out button')
 assert.equal(find('clock',w)?.ownerDocument,w.opened[0]!.child!.document,'popped out')
 const left=document.querySelector<HTMLElement>('.custom-app-placeholder');assert.ok(left,'its placeholder stays in the main window')
 assert.equal(left.style.position,'','the placeholder is not a fixed box')
 assert.equal(left.style.width+left.style.height,'','and has no size')
 assert.ok(left.classList.contains('popped-out'))
 const css=readFileSync(path.join(__SRC_DIR__,'canvas','apps','apps.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'')
 assert.match(css,/\.custom-app-placeholder\.popped-out[^{]*\{[^}]*display:\s*contents/,'it takes no space')
})

test('floating and window-pinned panels reopen where they were after Power off, and the pinned one still drags',async t=>{
 const slug='reopen-docked',f=await workspace(t,slug,[copy('float','Floater',floating()),copy('pin','Pinned',{mode:'window',x:120,y:80,width:400,height:300})])
 for(const [id,label] of [['float','Floater'],['pin','Pinned']]){
  await f.click(button(find(id),'Power off '+label),label+'\'s Power off')
  await wait();assert.equal(find(id),null,label+' is off')
  await f.toggle();await f.click(f.row(label),label+'\'s saved row')
  // its zoom-in ends before the next zoom-out begins: inside act, the motion
  // timer after a first one is only set once the wait has ended
  await wait()
 }
 const floater=find('float');assert.ok(floater?.hasAttribute('data-centered'),'the floating panel reopens centered')
 assert.ok(floater.closest('.overlay.custom-app-centered'))
 const pinned=find('pin');assert.ok(pinned,'the pinned panel reopens')
 assert.ok(document.querySelector(`[data-pin-layer="${slug}"]`)?.contains(pinned),'in the pin layer')
 assert.deepEqual([pinned.style.left,pinned.style.top,pinned.style.width,pinned.style.height],['120px','80px','400px','300px'],'at its spot and size')
 assert.equal(button(pinned,'Unpin')?.getAttribute('aria-pressed'),'true','its pin is lit')
 const bar=pinned.querySelector<HTMLElement>('.custom-app-title')!,mark=f.calls.length
 await inAct(async()=>{bar.dispatchEvent(pointer('pointerdown',200,135));bar.dispatchEvent(pointer('pointermove',300,185));await tick()})
 assert.deepEqual([pinned.style.left,pinned.style.top],['220px','130px'],'its title bar drags it')
 await inAct(async()=>{bar.dispatchEvent(pointer('pointerup',300,185));await tick()})
 const moved=f.writes(mark).find(c=>c.action==='panel_update')?.placement
 assert.deepEqual([moved?.mode,moved?.x,moved?.y],['window',220,130],'the drag is saved')
})
