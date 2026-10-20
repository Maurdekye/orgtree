import {advance,FakeServer,flush,inAct,installFetch,mountView,realClock,useFakeClock} from './harness'
import test from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {useState} from 'react'
import {OrgCanvas} from '../src/canvas/OrgCanvas'
import {revealExistingDesk,deskIdentity} from '../src/canvas/deskhosts'
import {registerWindow} from '../src/windowlife'
import {CurrentOrg} from '../src/popout'
import {addPin,forgetPins,readPins} from '../src/canvas/pins'
import {resetConvos} from '../src/convo'
import {refocusNode,refocusProject,refocusTree} from './project-refocus-fixture'

const noop=()=>{}
const op=async()=>({} as never)
const pointer=(type:string,x=200,y=200)=>new window.PointerEvent(type,{bubbles:true,cancelable:true,
 pointerId:1,pointerType:'mouse',isPrimary:true,button:type==='pointermove'?-1:0,buttons:1,clientX:x,clientY:y})
const camera=(host:HTMLElement)=>host.querySelector<HTMLElement>('.space')!.style.transform
const card=(host:HTMLElement)=>host.querySelector<HTMLElement>('.sq.project')!
const desk=()=>document.querySelector<HTMLElement>('.project-desk')!
async function press(el:Element){
 await inAct(()=>el.dispatchEvent(pointer('pointerdown')));await flush()
 await inAct(()=>el.dispatchEvent(pointer('pointerup')));await advance(1500)
}
async function pan(viewport:Element,x=28,y=18){
 await inAct(()=>viewport.dispatchEvent(pointer('pointerdown',400,300)))
 await inAct(()=>viewport.dispatchEvent(pointer('pointermove',400+x,300+y)))
 await inAct(()=>viewport.dispatchEvent(pointer('pointerup',400+x,300+y)));await flush()
}
async function mounted(t:TestContext,pin=false){
 useFakeClock();installFetch(new FakeServer())
 localStorage.clear();if(pin)addPin('refocus','build',{x:40,y:40,w:650,h:550})
 const proto=window.HTMLElement.prototype
 const old=[proto.setPointerCapture,proto.releasePointerCapture,proto.hasPointerCapture]
 let capture:Element|null=null
 proto.setPointerCapture=function(){capture=this};proto.releasePointerCapture=noop;proto.hasPointerCapture=()=>false
 let jump:(id:string)=>void=noop
 function View(){const [target,setTarget]=useState<string|null>(null);jump=setTarget
  return <CurrentOrg.Provider value="refocus"><OrgCanvas tree={refocusTree} op={op} slug="refocus"
   toast={noop} mailEvt={null} focusAgent={target} focusAgentDesk onFocusAgentHandled={()=>setTarget(null)}/></CurrentOrg.Provider>}
 const v=await mountView(<View/>,el=>el);await advance(2500)
 t.after(async()=>{await v.unmount();forgetPins('refocus');resetConvos();realClock()
  ;[proto.setPointerCapture,proto.releasePointerCapture,proto.hasPointerCapture]=old})
 return {host:v.el,viewport:v.el.querySelector<HTMLElement>('.viewport')!,jump:async()=>{
  await inAct(()=>jump('build'));await advance(1500)},captured:()=>capture}
}
async function tab(name:string){await inAct(()=>desk().querySelector<HTMLButtonElement>(`.cc-tabs [data-tab="${name}"]`)!.click());await flush(3)}
async function modalFromMenu(host:HTMLElement){
 await inAct(()=>card(host).dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:40,clientY:40})))
 const item=(name:string)=>[...document.querySelectorAll<HTMLElement>('.ctxmenu [role="menuitem"]')]
  .find(el=>el.textContent?.replace(/\s*▸$/,'')===name)
 assert.ok(item('Open'),'Open menu rendered')
 await inAct(()=>item('Open')!.dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true})));await advance(400)
 assert.ok(item('Desk'),'Desk submenu rendered');await inAct(()=>item('Desk')!.click());await flush(4)
 assert.ok(document.querySelector('.project-desk-modal'),'project modal opened')
}

test('project native windows reuse the agent reveal route with exact org/node identity',t=>{
 const raised:string[]=[]
 const remove=registerWindow({id:'project-popout',kind:'project-desk',org:'refocus',editable:true,
  window:window as unknown as Window,identity:()=>({agent:'build'}),redock:noop,reveal:()=>raised.push('build')})
 t.after(remove)
 assert.equal(revealExistingDesk('refocus',refocusProject),true)
 assert.deepEqual(raised,['build'])
 assert.equal(revealExistingDesk('other',refocusProject),false)
 assert.equal(revealExistingDesk('refocus',{...refocusProject,id:'other'}),false)
})
test('agent native window reveal remains unchanged',t=>{
 const n=refocusNode('agent',null),raised:string[]=[]
 t.after(registerWindow({id:'agent-popout',kind:`desk:${deskIdentity('refocus',n)}`,org:'refocus',editable:true,
  window:window as unknown as Window,redock:noop,reveal:()=>raised.push('agent')}))
 assert.equal(revealExistingDesk('refocus',n),true);assert.deepEqual(raised,['agent'])
})
test('captured stationary project desk press recenters without resetting tab or duplicating desk',async t=>{
 const c=await mounted(t);await press(card(c.host));await tab('presented')
 const original=camera(c.host);await pan(c.viewport);assert.notEqual(camera(c.host),original)
 await inAct(()=>desk().querySelector('.cc-head')!.dispatchEvent(pointer('pointerdown')))
 assert.equal(c.captured()===c.viewport,true,'background press is captured by viewport')
 // Native pointer capture retargets pointerup and click to the viewport.
 await inAct(()=>c.viewport.dispatchEvent(pointer('pointerup')));await inAct(()=>c.viewport.click());await advance(1500)
 assert.equal(camera(c.host),original,'same centerOn target as the initial project click')
 assert.equal(document.querySelectorAll('.project-desk').length,1)
 assert.equal(desk().querySelector('.cc-tabs .on')?.getAttribute('data-tab'),'presented')
})
test('a drag begun on project desk chrome still pans and never refocuses',async t=>{
 const c=await mounted(t);await press(card(c.host));const before=camera(c.host)
 await inAct(()=>desk().querySelector('.cc-head')!.dispatchEvent(pointer('pointerdown',400,300)))
 await inAct(()=>c.viewport.dispatchEvent(pointer('pointermove',450,330)))
 await inAct(()=>c.viewport.dispatchEvent(pointer('pointerup',450,330)));const after=camera(c.host);await advance(1500)
 assert.notEqual(after,before);assert.equal(camera(c.host),after)
})
test('a cancelled project desk press never refocuses',async t=>{
 const c=await mounted(t);await press(card(c.host));await pan(c.viewport);const before=camera(c.host)
 await inAct(()=>desk().querySelector('.cc-head')!.dispatchEvent(pointer('pointerdown')))
 await inAct(()=>c.viewport.dispatchEvent(pointer('pointercancel')));await advance(1500)
 assert.equal(camera(c.host),before)
})
test('generic opening reveals the pinned project desk without moving camera or changing its tab',async t=>{
 const c=await mounted(t,true);await tab('presented');const before=camera(c.host)
 await c.jump();assert.equal(camera(c.host),before)
 assert.equal(readPins('refocus').length,1);assert.equal(document.querySelectorAll('.project-desk').length,1)
 assert.equal(desk().querySelector('.cc-tabs .on')?.getAttribute('data-tab'),'presented')
})
test('generic opening raises a project popout without creating an embedded copy',async t=>{
 const c=await mounted(t),raised:string[]=[];const before=camera(c.host)
 t.after(registerWindow({id:'popout-route',kind:'project-desk',org:'refocus',editable:true,window:window as unknown as Window,
  identity:()=>({agent:'build'}),redock:noop,reveal:()=>raised.push('build')}))
 await c.jump();assert.deepEqual(raised,['build']);assert.equal(camera(c.host),before)
 assert.equal(document.querySelectorAll('.project-desk').length,0)
})
test('canvas Focus and Agents List clicks reveal the same project popout',async t=>{
 const c=await mounted(t),raised:string[]=[];const before=camera(c.host)
 t.after(registerWindow({id:'entry-route',kind:'project-desk',org:'refocus',editable:true,window:window as unknown as Window,
  identity:()=>({agent:'build'}),redock:noop,reveal:()=>raised.push('build')}))
 await press(card(c.host));assert.equal(raised.length,1,'canvas click revealed the popout')
 await inAct(()=>card(c.host).dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:40,clientY:40})))
 const focus=[...document.querySelectorAll<HTMLElement>('.ctxmenu [role="menuitem"]')].find(el=>el.textContent==='Focus')
 assert.ok(focus,'Focus menu rendered');await inAct(()=>focus!.click());await flush()
 assert.equal(raised.length,2,'menu uses the same reveal')
 await inAct(()=>c.host.querySelector<HTMLButtonElement>('.tray-toggle')!.click());await flush()
 const row=[...c.host.querySelectorAll<HTMLButtonElement>('.tray-main')].find(el=>el.textContent?.includes('build'))
 assert.ok(row,'project row in Agents List');await inAct(()=>row!.click());await flush()
 assert.equal(raised.length,3,'Agents List uses the same reveal');assert.equal(camera(c.host),before)
 assert.equal(document.querySelectorAll('.project-desk').length,0)
})
test('generic opening refocuses the existing project modal and preserves its selected tab and draft',async t=>{
 const c=await mounted(t);await modalFromMenu(c.host);await tab('presented')
 const input=desk().querySelector<HTMLTextAreaElement>('textarea')!;assert.ok(input,'project composer')
 await inAct(()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'Keep this draft');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
 const before=camera(c.host);await c.jump()
 assert.equal(camera(c.host),before,'modal reveal leaves canvas alone')
 assert.equal(document.querySelectorAll('.project-desk').length,1,'one existing desk')
 assert.equal(desk().querySelector('.cc-tabs .on')?.getAttribute('data-tab'),'presented')
 assert.equal(desk().querySelector<HTMLTextAreaElement>('textarea')?.value,'Keep this draft')
 assert.equal(document.activeElement===input,true,'reveal focuses the existing composer')
})
