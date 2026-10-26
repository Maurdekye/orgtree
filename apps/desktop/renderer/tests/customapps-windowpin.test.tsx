import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as ui from '../src/canvas/apps/ui'
import {pinSurfaceKey,removePinSurface,updatePinSurface} from '../src/canvas/pinspace'

// User 2026-10-26: "i meant pin it to the window like other pinned panels" and
// "Remove canvas pinning". The panel pin pins the panel to the window at its
// current spot and size, sharing the pin layer, coordinates and stacking of
// pinned desks; placements are floating, window-pinned, popped out, hidden, off.
const {AppsButton,AppsWorkspace}=ui
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
type Placement={mode:string;x:number;y:number;width:number;height:number;anchor?:string|null}
type Panel={id:string;app:string;label:string;rev:number;open:boolean;running?:boolean;state:Record<string,unknown>;event_seq:number;placement:Placement;used_at:string;updated_at:string}
const copy=(id:string,placement:Placement={mode:'float',x:40,y:40,width:360,height:280}):Panel=>({id,app:'notes',label:'Panel 1',rev:1,open:true,running:true,state:{},event_seq:0,placement,used_at:'2026-10-26',updated_at:''})
const box=(x:number,y:number,width:number,height:number)=>()=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height,toJSON(){return this}}) as DOMRect
function fixture(t:test.TestContext,slug:string,panels:Panel[]){
 const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',updated_at:'',definition:{name:'Notes',description:'',html:'<p>Notes</p>',initial_state:{},capabilities:[],width:360,height:280}}
 const calls:Record<string,any>[]=[],original=globalThis.fetch
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
  if(input.action==='list')out={items:input.kind==='apps'?[app]:panels,next_cursor:null,new_count:0}
  else if(input.action==='app_get')out=app
  else if(input.action==='panel_get')out=panels.find(p=>p.id===input.panel)
  else if(input.action==='events')out={events:[],next_cursor:null,oldest_retained:null}
  else if(input.action==='session_close'||input.action==='runtime')out={items:[],next_cursor:null}
  else if(input.action==='panel_update'){const p=panels.find(p=>p.id===input.panel)!;assert.equal(input.expected_rev,p.rev);for(const k of ['label','open','placement'])if(k in input)(p as Record<string,unknown>)[k]=input[k];p.rev++;out=p}
  else throw Error('Unexpected '+input.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 };t.after(()=>{globalThis.fetch=original})
 // The org's canvas area as OrgCanvas's viewport publishes it; jsdom lays out nothing
 // and reports a 16px border on an unstyled element, so the border is explicit.
 const area=document.createElement('div');area.dataset.pinOrg=slug;area.style.border='0';area.getBoundingClientRect=box(0,40,1600,900);document.body.appendChild(area);t.after(()=>area.remove())
 const proto=HTMLElement.prototype as unknown as Record<string,unknown>,had={s:proto.setPointerCapture,r:proto.releasePointerCapture}
 proto.setPointerCapture=()=>{};proto.releasePointerCapture=()=>{};t.after(()=>{proto.setPointerCapture=had.s;proto.releasePointerCapture=had.r})
 return {calls,panels}
}
const frame=(id='one')=>document.querySelector<HTMLElement>(`[data-custom-panel="${id}"]`)!
const layer=(slug:string)=>document.querySelector<HTMLElement>(`[data-pin-layer="${slug}"]`)
const rectOf=(e:HTMLElement)=>[e.style.left,e.style.top,e.style.width,e.style.height]
const pointer=(type:string,x:number,y:number)=>new window.PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:type==='pointermove'?-1:0,buttons:1,clientX:x,clientY:y})
const lastPlacement=(calls:Record<string,any>[])=>calls.filter(c=>c.action==='panel_update'&&c.placement).at(-1)?.placement

test('the panel pin pins a floating panel to the window at its spot and size, in the shared pin layer, and unpins to the centered window',async t=>{
 const slug='windowpin-case',{calls,panels}=fixture(t,slug,[copy('one')])
 const view=await mountView(<AppsWorkspace slug={slug}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 for(const name of ['Pin to screen','Pin to canvas','Unpin from canvas'])assert.equal(!!document.querySelector(`[aria-label="${name}"]`),false,`no "${name}" control remains`)
 assert.ok(frame().hasAttribute('data-centered'),'a floating panel is the centered window')
 const pin=frame().querySelector<HTMLButtonElement>('[aria-label="Pin to window"]');assert.ok(pin,'the title bar pins to the window');assert.equal(pin!.getAttribute('aria-pressed'),'false')
 frame().getBoundingClientRect=box(300,200,360,280)
 await inAct(async()=>{pin!.click();await tick()})
 const placed=lastPlacement(calls)
 assert.deepEqual({mode:placed?.mode,x:placed?.x,y:placed?.y,width:placed?.width,height:placed?.height},{mode:'window',x:300,y:160,width:360,height:280},'pinned where it was, at its size, in canvas-area pixels like pinned desks')
 assert.equal(placed?.anchor??null,null,'a window pin attaches to no node')
 assert.equal(panels[0]!.placement.mode,'window')
 assert.ok(layer(slug)?.contains(frame()),'the pinned panel lives in the org pin layer with pinned desks')
 assert.deepEqual(rectOf(frame()),['300px','160px','360px','280px'],'it stays at the same spot and size')
 assert.equal(frame().style.position,'absolute');assert.equal(frame().hasAttribute('data-centered'),false)
 assert.ok(!document.querySelector('.overlay.custom-app-centered [data-custom-panel="one"]'),'a pinned panel is not a modal over the canvas')
 const unpin=frame().querySelector<HTMLButtonElement>('[aria-label="Unpin"]');assert.ok(unpin,'a pinned panel offers Unpin');assert.equal(unpin!.getAttribute('aria-pressed'),'true')
 await inAct(async()=>{unpin!.click();await tick()})
 assert.equal(lastPlacement(calls)?.mode,'float','unpinning returns to the centered window')
 assert.equal(layer(slug)?.contains(frame())??false,false);assert.ok(frame().hasAttribute('data-centered'))
})

test('a window-pinned panel restores pinned at its saved spot, stacks with pinned desks and drags within the canvas area',async t=>{
 const slug='windowpin-restore',{calls}=fixture(t,slug,[copy('one',{mode:'window',x:120,y:80,width:400,height:300})])
 const view=await mountView(<AppsWorkspace slug={slug}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 assert.ok(layer(slug)?.contains(frame()),'restored into the pin layer');assert.deepEqual(rectOf(frame()),['120px','80px','400px','300px'],'restored at its saved spot and size')
 // A pinned desk registered after the panel stacks above it; a press on the panel raises it.
 const desk=pinSurfaceKey(slug,'worker');t.after(()=>removePinSurface(desk))
 await inAct(async()=>{updatePinSurface(desk,slug,{x:900,y:500,w:320,h:240},false);await tick()})
 assert.equal(frame().style.zIndex,'0','a later pinned desk is above the panel')
 await inAct(async()=>{frame().dispatchEvent(pointer('pointerdown',600,400));frame().dispatchEvent(pointer('pointerup',600,400));await tick()})
 assert.equal(frame().style.zIndex,'1','pressing the panel raises it above the desk, as pinned desks raise each other')
 const bar=frame().querySelector<HTMLElement>('.custom-app-title')!
 await inAct(async()=>{bar.dispatchEvent(pointer('pointerdown',200,135));bar.dispatchEvent(pointer('pointermove',300,185));await tick()})
 assert.deepEqual(rectOf(frame()),['220px','130px','400px','300px'],'the title bar drags a window pin')
 await inAct(async()=>{bar.dispatchEvent(pointer('pointerup',300,185));await tick()})
 assert.deepEqual([lastPlacement(calls)?.mode,lastPlacement(calls)?.x,lastPlacement(calls)?.y],['window',220,130],'a drag commits canvas-area coordinates once')
 await inAct(async()=>{bar.dispatchEvent(pointer('pointerdown',300,185));bar.dispatchEvent(pointer('pointermove',5300,185));bar.dispatchEvent(pointer('pointerup',5300,185));await tick()})
 assert.deepEqual([lastPlacement(calls)?.x,lastPlacement(calls)?.y],[1200,130],'a drag past the edge stays inside the canvas area, like pinned desks')
})

test('no canvas placement remains: the Apps module has no canvas layer and the menu opens without showing the canvas',async t=>{
 assert.equal('AppsCanvasLayer' in ui,false,'the canvas layer for panels is gone')
 const slug='windowpin-menu';fixture(t,slug,[{...copy('one'),open:false,running:false}])
 const view=await mountView(<><AppsButton slug={slug}/><AppsWorkspace slug={slug}/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})
 const menu=document.querySelector<HTMLElement>('.custom-apps-menu')!
 assert.equal([...menu.querySelectorAll('button,[role="menuitem"]')].some(b=>/canvas/i.test((b.getAttribute('aria-label')??'')+(b.getAttribute('title')??'')+(b.textContent??''))),false,'the Apps list offers no canvas placement')
})
