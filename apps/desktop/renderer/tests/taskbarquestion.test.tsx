import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {legacyAppBackend} from './appfeed-fixture'
import {eventFanout,startBus} from './heldevents'
import {useNativeNotifications,type DesktopNotice} from '../src/notifications'
import {DesktopSettings} from '../src/canvas/desktopsettings'
import type {DesktopPreferences} from '../../../../packages/contracts'
import {DEFAULT_NOTIFICATIONS} from '../../../../packages/contracts/notifications'

test('taskbar actions open muted mail, use the selected question destination and discard resolved items',async()=>{
 localStorage.clear()
 const oldFetch=globalThis.fetch,fan=eventFanout(),opened:DesktopNotice[]=[]
 const notices:DesktopNotice[]=[
  {org:'alpha',id:'mail',kind:'routine',source_id:'m1',agent:'helper',title:'Mail',body:'Text'},
  {org:'alpha',id:'question',kind:'question',source_id:'q1',agent:'helper',title:'Question',body:'Choose'},
  {org:'alpha',id:'mention',kind:'mention',agent:'helper',title:'Mention',body:'Hello'},
 ]
 Object.defineProperty(window,'orgtreeDesktop',{configurable:true,value:{
  notify:async()=>true,onEvent:fan.onEvent,getPreferences:async()=>({...DEFAULT_NOTIFICATIONS,notificationsEnabled:false}),
 }})
 const stop=startBus()
 globalThis.fetch=legacyAppBackend(async()=>({ok:true,headers:new Headers(),json:async()=>({notices,total:notices.length,truncated:false})} as Response))
 function View(){useNativeNotifications(n=>opened.push(n));return <div/>}
 const view=await mountView(<View/>,el=>el)
 try{
  await inAct(async()=>{await flush(30)})
  const click=async(id:string,questionTarget?:string)=>inAct(async()=>{fan.emit({type:'taskbar-attention',data:{org:'alpha',id,questionTarget}});await flush(30)})
  await click('mail');assert.equal(opened.at(-1)?.source_id,'m1');assert.equal(opened.at(-1)?.focusDesk,false)
  await click('question');assert.equal(opened.at(-1)?.focusDesk,true)
  await click('question','mail');assert.equal(opened.at(-1)?.focusDesk,false)
  await click('mention','mail');assert.equal(opened.at(-1)?.focusDesk,true)
  assert.equal(opened.every(n=>n.fromTaskbar),true)
  notices.splice(0);await click('question');assert.equal(opened.length,4)
 }finally{await view.unmount();stop();globalThis.fetch=oldFetch;Object.defineProperty(window,'orgtreeDesktop',{configurable:true,value:undefined})}
})

test('question destination is visible with banners off, defaults to desk and saves through native preferences',async()=>{
 const writes:unknown[]=[],fan=eventFanout()
 let prefs={...DEFAULT_NOTIFICATIONS,notificationsEnabled:false} as DesktopPreferences
 Object.defineProperty(window,'orgtreeDesktop',{configurable:true,value:{onEvent:fan.onEvent,getPreferences:async()=>prefs,
  setPreferences:async(patch:Partial<DesktopPreferences>)=>{writes.push(patch);return prefs={...prefs,...patch}},
 }})
 const view=await mountView(<DesktopSettings/>,el=>el)
 try{
  await inAct(async()=>{await flush(12)})
  const select=view.el.querySelector<HTMLSelectElement>('select[aria-label="open questions"]')
  assert.ok(select,'question destination control exists');assert.equal(select.disabled,false);assert.equal(select.value,'desk')
  assert.deepEqual([...select.options].map(o=>o.textContent),['focus the agent desk','open questions as mail'])
  await inAct(async()=>{select.value='mail';select.dispatchEvent(new window.Event('change',{bubbles:true}));await flush(12)})
  assert.deepEqual(writes,[{questionTarget:'mail'}]);assert.equal(select.value,'mail')
  await inAct(async()=>{fan.emit({type:'preferences',data:{...prefs,questionTarget:'desk'}});await flush(8)})
  assert.equal(select.value,'desk')
 }finally{await view.unmount();Object.defineProperty(window,'orgtreeDesktop',{configurable:true,value:undefined})}
})
