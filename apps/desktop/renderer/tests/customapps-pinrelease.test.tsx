import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppsWorkspace} from '../src/canvas/apps/ui'
import {invalidateCustomApps} from '../src/canvas/apps/store'
import {resizePlacement} from '../src/canvas/apps/placement'

// USER 2026-10-27 m061e2860fd9b: "when i drag and release a pinned app panel, it
// briefly flickers back to its initial pre-drag positon for 1 frame before
// settling in the new location" (@item:orgtree/4-5-0-bug-pinning-a-floating-open-panel-makes-it).
// A released window pin stays at its drop on every frame: while the drop is
// being saved, once it is saved, and when a list read begun before the drop
// answers after it. A refused drop goes back to the committed place.
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
type Placement={mode:string;x:number;y:number;width:number;height:number;anchor?:string|null}
type Panel={id:string;app:string;label:string;rev:number;open:boolean;running?:boolean;state:Record<string,unknown>;event_seq:number;placement:Placement;used_at:string;updated_at:string;created_at:string}
const pinned=(id:string):Panel=>({id,app:'notes',label:'Panel 1',rev:1,open:true,running:true,state:{},event_seq:0,
 placement:{mode:'window',x:120,y:80,width:400,height:300},used_at:'2026-10-27',updated_at:'',created_at:'2026-10-27T09:00:00Z'})
const box=(x:number,y:number,width:number,height:number)=>()=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height,toJSON(){return this}}) as DOMRect
const gate=()=>{let open!:()=>void;const p=new Promise<void>(r=>{open=r});return{p,open}}
function fixture(t:test.TestContext,slug:string,panels:Panel[]){
 const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities:[],permissions:{},created_by:'maker',updated_at:'',definition:{name:'Notes',description:'',html:'<p>Notes</p>',initial_state:{},capabilities:[],width:360,height:280}}
 const calls:Record<string,any>[]=[],original=globalThis.fetch
 const s={calls,panels,saving:null as Promise<void>|null,reading:null as Promise<void>|null,refuse:false}
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
  if(input.action==='list'){
   // what the read finds when it is made, answered whenever its gate opens
   const items=input.kind==='apps'?[app]:JSON.parse(JSON.stringify(panels))
   if(input.kind!=='apps'&&s.reading)await s.reading
   out={items,next_cursor:null,new_count:0}}
  else if(input.action==='app_get')out=app
  else if(input.action==='panel_get')out=panels.find(p=>p.id===input.panel)
  else if(input.action==='events')out={events:[],next_cursor:null,oldest_retained:null}
  else if(input.action==='session_close'||input.action==='runtime')out={items:[],next_cursor:null}
  else if(input.action==='panel_update'){
   if(s.saving)await s.saving
   if(s.refuse)return new Response(JSON.stringify({detail:'that panel changed since you read it'}),{status:409,headers:{'Content-Type':'application/json'}})
   const p=panels.find(p=>p.id===input.panel)!;assert.equal(input.expected_rev,p.rev);for(const k of ['label','open','placement'])if(k in input)(p as Record<string,unknown>)[k]=input[k];p.rev++;out=p}
  else throw Error('Unexpected '+input.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 };t.after(()=>{globalThis.fetch=original})
 // the org's canvas area as OrgCanvas's viewport publishes it (customapps-windowpin.test)
 const area=document.createElement('div');area.dataset.pinOrg=slug;area.style.border='0';area.getBoundingClientRect=box(0,40,1600,900);document.body.appendChild(area);t.after(()=>area.remove())
 const proto=HTMLElement.prototype as unknown as Record<string,unknown>,had={s:proto.setPointerCapture,r:proto.releasePointerCapture}
 proto.setPointerCapture=()=>{};proto.releasePointerCapture=()=>{};t.after(()=>{proto.setPointerCapture=had.s;proto.releasePointerCapture=had.r})
 return s
}
const frame=(id='one')=>document.querySelector<HTMLElement>(`[data-custom-panel="${id}"]`)!
const rectOf=(e:HTMLElement)=>[e.style.left,e.style.top,e.style.width,e.style.height]
const pointer=(type:string,x:number,y:number)=>new window.PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:type==='pointermove'?-1:0,buttons:1,clientX:x,clientY:y})
const FROM=['120px','80px','400px','300px'],DROP=['220px','130px','400px','300px']
async function dragTo(slug:string){
 const view=await mountView(<AppsWorkspace slug={slug}/>,e=>e);await inAct(tick)
 assert.deepEqual(rectOf(frame()),FROM,'restored pinned at its saved place')
 const bar=frame().querySelector<HTMLElement>('.custom-app-title')!
 await inAct(async()=>{bar.dispatchEvent(pointer('pointerdown',200,135));bar.dispatchEvent(pointer('pointermove',300,185));await tick()})
 assert.deepEqual(rectOf(frame()),DROP,'dragging')
 return{view,bar,release:()=>inAct(async()=>{bar.dispatchEvent(pointer('pointerup',300,185));await tick()})}
}

test('a released window pin stays at its drop while the drop is saved, and once it is',async t=>{
 const slug='pinrelease-hold',f=fixture(t,slug,[pinned('one')])
 const{view,release}=await dragTo(slug);t.after(()=>view.unmount())
 const saving=gate();f.saving=saving.p
 await release()
 assert.equal(f.calls.filter(c=>c.action==='panel_update').length,1,'the drop is being saved')
 assert.deepEqual(rectOf(frame()),DROP,'while the save is in flight it stays at the drop, never back where the drag began')
 await inAct(async()=>{saving.open();await tick()})
 assert.equal(f.panels[0]!.rev,2,'saved')
 assert.deepEqual(rectOf(frame()),DROP,'and stays there at the committed placement')
})

test('a list read begun before the drop and answered after it cannot put the panel back',async t=>{
 const slug='pinrelease-stale',f=fixture(t,slug,[pinned('one')])
 const{view,release}=await dragTo(slug);t.after(()=>view.unmount())
 // a change elsewhere in the org starts a list read; it finds the panel where the drag began
 const reading=gate();f.reading=reading.p
 await inAct(async()=>{invalidateCustomApps(slug);await tick()})
 assert.ok(f.calls.some(c=>c.action==='list'&&c.kind==='panels'),'the read is out')
 await release()
 assert.equal(f.panels[0]!.rev,2,'the drop is saved first')
 assert.deepEqual(rectOf(frame()),DROP)
 await inAct(async()=>{reading.open();await tick()})
 assert.deepEqual(rectOf(frame()),DROP,'an older revision of the panel never replaces the committed drop')
})

test('a refused drop goes back to the committed place and says why (control)',async t=>{
 const slug='pinrelease-refused',f=fixture(t,slug,[pinned('one')])
 const{view,release}=await dragTo(slug);t.after(()=>view.unmount())
 f.refuse=true
 await release()
 assert.deepEqual(rectOf(frame()),FROM,'nothing was saved, so it is where it was')
 assert.match(frame().querySelector('[role="alert"]')?.textContent??'',/changed since you read it/)
})

test('Escape cancels a pinned app drag and a later release saves nothing',async t=>{
 const slug='pincancel-escape',f=fixture(t,slug,[pinned('one')])
 const{view,bar,release}=await dragTo(slug);t.after(()=>view.unmount())
 await inAct(async()=>{window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick()})
 assert.deepEqual(rectOf(frame()),FROM,'Escape restores the committed placement')
 await release()
 assert.equal(f.calls.filter(c=>c.action==='panel_update'&&c.placement).length,0,'the cancelled gesture never commits')
})

for(const kind of ['move','size'] as const)test(`lost pointer capture cancels a pinned app ${kind} gesture`,async t=>{
 const slug=`pincancel-lost-${kind}`,f=fixture(t,slug,[pinned('one')])
 const view=await mountView(<AppsWorkspace slug={slug}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 const handle=frame().querySelector<HTMLElement>(kind==='move'?'.custom-app-title':'.custom-app-resize')!
 await inAct(async()=>{handle.dispatchEvent(pointer('pointerdown',200,135));handle.dispatchEvent(pointer('pointermove',300,185));await tick()})
 assert.notDeepEqual(rectOf(frame()),FROM,'the gesture has a live preview')
 await inAct(async()=>{handle.dispatchEvent(new window.PointerEvent('lostpointercapture',{bubbles:true,pointerId:1}));await tick()})
 assert.deepEqual(rectOf(frame()),FROM,'losing capture restores the committed placement')
 await inAct(async()=>{handle.dispatchEvent(pointer('pointerup',300,185));await tick()})
 assert.equal(f.calls.filter(c=>c.action==='panel_update'&&c.placement).length,0,'the cancelled gesture never commits')
})

// EVERY EDGE AND CORNER RESIZES (@item:orgtree/app-panels-can-t-be-resized-by-dragging-their-ed, USER 2026-11-05 14:20:45Z
// mc2f4ccd62129: "i cant drag from the edges of app panels to resize them"): the panel had one 15px grip at its south-east
// corner; the pinned desks and settings have eight handles. Drag by (+30,+20) from pinned 120,80 400x300.
const EXPECT:Record<string,[string,string,string,string]>={
 e:['120px','80px','430px','300px'], w:['150px','80px','370px','300px'],
 s:['120px','80px','400px','320px'], n:['120px','100px','400px','280px'],
 se:['120px','80px','430px','320px'], ne:['120px','100px','430px','280px'],
 nw:['150px','100px','370px','280px'], sw:['150px','80px','370px','320px']}
for(const edge of Object.keys(EXPECT))test(`dragging the ${edge} handle of a pinned app panel resizes it and saves the size`,async t=>{
 const slug='resize-edge-'+edge,f=fixture(t,slug,[pinned('one')])
 const view=await mountView(<AppsWorkspace slug={slug}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 const h=frame().querySelector<HTMLElement>(`[data-resize-edge="${edge}"]`)
 assert.ok(h,`the ${edge} handle exists`)
 await inAct(async()=>{h.dispatchEvent(pointer('pointerdown',500,400));h.dispatchEvent(pointer('pointermove',530,420));await tick()})
 assert.deepEqual(rectOf(frame()),EXPECT[edge],'previewing')
 await inAct(async()=>{h.dispatchEvent(pointer('pointerup',530,420));await tick()})
 const saved=f.calls.filter(c=>c.action==='panel_update'&&c.placement)
 assert.equal(saved.length,1,'one save')
 const[x,y,w,hh]=EXPECT[edge].map(v=>parseInt(v))
 assert.deepEqual([saved[0]!.placement.x,saved[0]!.placement.y,saved[0]!.placement.width,saved[0]!.placement.height],[x,y,w,hh])
})

test('the resize rule: the dragged side follows the pointer, the minimum pins the opposite side, a centered panel grows both ways',()=>{
 const p={x:120,y:80,width:400,height:300}
 assert.deepEqual(resizePlacement(p,'w',500,0,false),{x:360,y:80,width:160,height:300},'shrunk to the minimum from the west: the east edge stays at 520')
 assert.deepEqual(resizePlacement(p,'n',0,500,false),{x:120,y:260,width:400,height:120},'and from the north: the south edge stays at 380')
 assert.deepEqual(resizePlacement(p,'e',9999,0,false).width,4096,'capped')
 assert.deepEqual(resizePlacement(p,'e',30,0,true),{x:120,y:80,width:460,height:300},'centered: twice the pointer, x untouched')
 assert.deepEqual(resizePlacement(p,'nw',-30,-20,true),{x:120,y:80,width:460,height:340},'centered west/north grow outwards too')
})
