import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { CurrentOrg } from '../src/popout'
import { AgentSurfaceRoutesProvider, PanelCorner } from '../src/canvas/panelcorner'
import type { AgentPanelKind } from '../src/canvas/panelcorner'
import { PinFrame, claimSurfaceRequests, forgetModalOpenCache, forgetModalPins,
  forgetSurfaceRequests, modalPinKey, readModalPins, requestSurfaceAction } from '../src/canvas/modalpin'

const org='tab-origin-synthetic',nid='origin-lead'
const tab={x:180,y:160,w:510,h:315},modal={x:300,y:205,w:400,h:300}
type Origin={rect:typeof tab;owner:Window}
const rect=(r:typeof tab)=>({x:r.x,y:r.y,left:r.x,top:r.y,width:r.w,height:r.h,right:r.x+r.w,bottom:r.y+r.h,toJSON(){}} as DOMRect)
async function setup(t:TestContext){
  const fetch=globalThis.fetch;installFetch(new FakeServer())
  await inAct(()=>{localStorage.clear();forgetModalPins();forgetModalOpenCache();forgetSurfaceRequests()})
  t.after(()=>{globalThis.fetch=fetch;localStorage.clear();forgetModalPins();forgetModalOpenCache();forgetSurfaceRequests()})
}

for(const kind of ['node-inbox','agent-docket','agent-gallery','agent-team','project-slots'] as AgentPanelKind[])
 for(const action of ['pin','popout'] as const)test(`${kind} ${action} snapshots the inline tab before showing its modal`,async t=>{
  await setup(t)
  let host:HTMLElement|null=null
  const got:{action:string;origin?:Origin}[]=[]
  const view=await mountView(<AgentSurfaceRoutesProvider value={{open(){},show(){
    // A route may replace the tab as soon as the modal is requested.
    host!.getBoundingClientRect=()=>rect({x:0,y:0,w:0,h:0})
  }}}><div className="desk-tabpanel"><PanelCorner kind={kind} slug={org} nid={nid}/></div></AgentSurfaceRoutesProvider>,el=>el)
  t.after(()=>view.unmount());host=view.el.querySelector('.desk-tabpanel')!
  host!.getBoundingClientRect=()=>rect(tab)
  await inAct(()=>view.el.querySelectorAll<HTMLButtonElement>('.panel-corner-btn')[action==='pin'?0:1]!.click())
  claimSurfaceRequests(kind,org,(a,o?:Origin)=>got.push({action:a,origin:o}));await flush(2)
  assert.equal(got.length,1,'one delayed request reaches its surface')
  assert.equal(got[0]!.action,action)
  assert.deepEqual(got[0]!.origin?.rect,tab,'use original tab bounds, not modal/new DOM bounds')
  assert.equal(got[0]!.origin?.owner===host!.ownerDocument.defaultView,true,'retain the source window for exact native coordinates')
 })

async function surface(t:TestContext){
 await setup(t)
 const canvas=document.createElement('div');canvas.dataset.pinOrg=org;canvas.style.border='0'
 canvas.getBoundingClientRect=()=>rect({x:70,y:40,w:850,h:650});document.body.appendChild(canvas)
 const view=await mountView(<CurrentOrg.Provider value={org}><PinFrame kind="agent-team" title="Team" panel="settings origin-panel" close={()=>{}}>
  <h3>Team</h3><input defaultValue="retained"/>
 </PinFrame></CurrentOrg.Provider>,el=>el)
 t.after(async()=>{await view.unmount();canvas.remove()})
 const panel=document.querySelector<HTMLElement>('.origin-panel')!;assert.ok(panel,'actual frame mounted')
 panel.getBoundingClientRect=()=>rect(modal)
 return {panel}
}
test('inline pin request uses tab viewport bounds relative to canvas, not the modal box',async t=>{
 const {panel}=await surface(t),input=panel.querySelector('input')
 await inAct(()=>requestSurfaceAction('agent-team',org,'pin',{rect:tab,owner:window}));await flush(2)
 assert.deepEqual(readModalPins()[modalPinKey('agent-team',org)]?.rect,{x:110,y:120,w:510,h:315})
 assert.equal(panel.querySelector('input')===input,true,'same content DOM survives pinning')
})
test('inline pop-out uses exact source client bounds then modal pop-out returns to its own bounds',async t=>{
 const {panel}=await surface(t),oldOpen=window.open,asked:string[]=[]
 window.open=((_url?:string|URL,_name?:string,features?:string)=>{asked.push(features||'');return null}) as typeof window.open
 t.after(()=>{window.open=oldOpen})
 await inAct(()=>requestSurfaceAction('agent-team',org,'popout',{rect:tab,owner:window}));await flush(2)
 assert.equal(asked.length,1)
 assert.match(asked[0]!,/orgtreeExactRect=1,orgtreeClientX=180,orgtreeClientY=160,orgtreeClientWidth=510,orgtreeClientHeight=315/)
 assert.match(asked[0]!,new RegExp(`left=${Math.round(window.screenX+tab.x)},top=${Math.round(window.screenY+tab.y)},width=510,height=315`))
 asked.length=0
 await inAct(()=>panel.querySelector<HTMLButtonElement>('.popout-button')!.click());await flush(2)
 assert.equal(asked.length,1)
 assert.doesNotMatch(asked[0]!,/orgtreeExactRect/,'the one-shot inline override must not leak into a later modal press')
 assert.match(asked[0]!,/width=400,height=300/,'the later modal press measures its original frame')
})
test('pin pressed in the modal keeps measuring the modal itself',async t=>{
 const {panel}=await surface(t)
 await inAct(()=>panel.querySelector<HTMLButtonElement>('.modalpin-btn')!.click());await flush(2)
 assert.deepEqual(readModalPins()[modalPinKey('agent-team',org)]?.rect,{x:230,y:165,w:400,h:300})
})
test('inline pins retain the existing minimum for a small tab',async t=>{
 await surface(t)
 await inAct(()=>requestSurfaceAction('agent-team',org,'pin',{rect:{...tab,w:160,h:120},owner:window}));await flush(2)
 assert.deepEqual(readModalPins()[modalPinKey('agent-team',org)]?.rect,{x:110,y:120,w:320,h:240})
})
test('inline pins clamp to the visible canvas after inheriting source bounds',async t=>{
 await surface(t)
 await inAct(()=>requestSurfaceAction('agent-team',org,'pin',{rect:{x:900,y:650,w:500,h:300},owner:window}));await flush(2)
 assert.deepEqual(readModalPins()[modalPinKey('agent-team',org)]?.rect,{x:350,y:350,w:500,h:300})
})
test('request without an inline tab still uses the existing modal origin',async t=>{
 await surface(t)
 await inAct(()=>requestSurfaceAction('agent-team',org,'pin'));await flush(2)
 assert.deepEqual(readModalPins()[modalPinKey('agent-team',org)]?.rect,{x:230,y:165,w:400,h:300})
})
test('a zero-size inline host falls back to the existing request',async t=>{
 await setup(t);let received:Origin|undefined
 const view=await mountView(<AgentSurfaceRoutesProvider value={{open(){},show(){}}}>
  <div className="desk-tabpanel"><PanelCorner kind="agent-team" slug={org} nid={nid}/></div>
 </AgentSurfaceRoutesProvider>,el=>el);t.after(()=>view.unmount())
 await inAct(()=>view.el.querySelector<HTMLButtonElement>('.panel-corner-btn')!.click())
 claimSurfaceRequests('agent-team',org,(_a,o?:Origin)=>{received=o});await flush(2)
 assert.equal(received,undefined,'do not invent geometry before layout')
})
