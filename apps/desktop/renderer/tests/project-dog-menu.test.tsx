import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { AgentSlotChips } from '../src/canvas/slotchips'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { DeskDogsProvider, DogChip } from '../src/canvas/deskdogs'
import { ListenersView } from '../src/canvas/listenersdesk'
import { SlotsView } from '../src/canvas/slotsdesk'
import { MailListenersView } from '../src/canvas/maillisteners'
import { mailListenerState } from '../src/canvas/listeners'
import { projectSlotState } from '../src/canvas/slots'
import { WatchdogSatellite } from '../src/canvas/watchdogchip'
import type { CanvasNode } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'

const dog=(kind:Watchdog['kind'],extra:Partial<Watchdog>={}):Watchdog=>({id:'worker/'+kind,name:kind,owner:'worker',kind,target:'@build',state:'armed',once:true,spent:false,at:'2026-10-19T00:00:00Z',fired:0,...extra} as Watchdog)
async function right(el:Element){await inAct(()=>{el.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:20,clientY:20}))});await flush()}
const projectRow=()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(e=>e.textContent==='Project… ▸')
const labels=()=>Array.from(document.querySelectorAll('[role="menuitem"]')).map(e=>e.textContent)

test('listener watches have a distinct kind class on the real canvas and desk chips',async t=>{
 const dogs=[dog('project_listener'),dog('listener_watch'),dog('listener_watch',{id:'worker/watch-once',once:false})]
 const view=await mountView(<>{dogs.map(w=><section key={w.id} data-kind={w.kind}><WatchdogSatellite dog={w} dogs={dogs} org="org" onOpen={()=>{}}/><DogChip dog={w} onOpen={()=>{}}/></section>)}</>,el=>el)
 t.after(view.unmount)
 for(const row of view.el.querySelectorAll('section'))for(const chip of row.querySelectorAll('button'))assert.equal(chip.classList.contains('listener-watch'),row.getAttribute('data-kind')==='listener_watch')
})

for(const kind of ['slot','fair_queue','project_listener','listener_watch','activity'] as Watchdog['kind'][]){
 test(kind+' watchdog borrows the current canonical project menu, keeping its own actions',async t=>{
  let focus=0,opened=0,version='first'
  function Register(){useProvideAgentNav(id=>id==='build'?[{label:'Focus',onSelect:()=>{focus++}},{label:'Open',children:[{label:'Project mailbox',onSelect:()=>{}}],onSelect:()=>{}},{label:version,onSelect:()=>{}}]:[]);return null}
  const w=dog(kind),props={isProject:(id:string)=>id==='build'}
  const view=await mountView(<AgentNavProvider><ObjectNavProvider><Register/><ObjectNavHost {...props} org="org" dogs={[w]} openDog={()=>{opened++}} toast={()=>{}}/><ObjectMenuBoundary><DogChip dog={w} onOpen={()=>{opened++}}/></ObjectMenuBoundary></ObjectNavProvider></AgentNavProvider>,el=>el)
  t.after(view.unmount)
  const chip=view.el.querySelector('button')!
  await right(chip);assert.ok(projectRow(),'Project submenu exists');assert.ok(labels().includes('Pause'));assert.ok(labels().includes('Remove'));assert.equal(opened,0)
  await inAct(()=>{projectRow()!.focus();projectRow()!.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))});await flush()
  assert.deepEqual(Array.from(document.querySelectorAll('.ctxmenu-submenu [role="menuitem"]')).map(e=>e.textContent),['Copy mention','Focus','Open ▸','first']);assert.equal(focus,0)
  await right(chip);await inAct(()=>projectRow()!.click());assert.equal(focus,1);assert.equal(opened,0)
  version='fresh';await right(chip);await inAct(()=>{projectRow()!.focus();projectRow()!.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))});await flush();assert.ok(labels().includes('fresh'),'builder read on open, not mount')
  await inAct(()=>{chip.click()});assert.equal(opened,1,'normal click still opens dog')
 })
}

test('ordinary targets and spent dogs gain no project navigation',async t=>{
 function Register(){useProvideAgentNav(()=>[{label:'Focus',onSelect:()=>{}}]);return null}
 const dogs=[dog('command',{target:'echo build'}),dog('activity',{target:'worker'}),dog('slot',{spent:true,state:'spent'})]
 const view=await mountView(<AgentNavProvider><ObjectNavProvider><Register/><ObjectNavHost {...{isProject:(id:string)=>id==='build'}} org="org" dogs={dogs} openDog={()=>{}} toast={()=>{}}/><ObjectMenuBoundary>{dogs.map(w=><DogChip key={w.id} dog={w} onOpen={()=>{}}/>)}</ObjectMenuBoundary></ObjectNavProvider></AgentNavProvider>,el=>el)
 t.after(view.unmount)
 for(const chip of view.el.querySelectorAll('button')){await right(chip);assert.equal(projectRow()===undefined,true)}
})

test('held and waiting slot chips offer Project submenu and preserve slots left-click',async t=>{
 const opened:string[]=[],focused:string[]=[]
 function Register(){useProvideAgentNav(id=>[{label:'Focus',onSelect:()=>{focused.push(id)}},{label:'Open',children:[{label:'Slots',onSelect:()=>{}}],onSelect:()=>{}}]);return null}
 const w=dog('slot'),lease={project:'build',agent:'worker',slot:1,lease:'synthetic',since:'2026-10-19T00:00:00Z'}
 const view=await mountView(<AgentNavProvider><Register/><AgentSurfaceRoutesProvider value={{open:(kind,id)=>{opened.push(kind+':'+id)},show:()=>{}}}><ObjectMenuBoundary><AgentSlotChips agent="worker" leases={[lease]} dogs={[w]}/></ObjectMenuBoundary></AgentSurfaceRoutesProvider></AgentNavProvider>,el=>el)
 t.after(view.unmount)
 assert.equal(view.el.querySelectorAll('button').length,2)
 for(const chip of view.el.querySelectorAll('button')){await right(chip);assert.ok(projectRow());assert.deepEqual(opened,[]);await inAct(()=>projectRow()!.click());assert.deepEqual(focused,['build']);focused.length=0;await inAct(()=>{chip.click()});assert.deepEqual(opened,['project-slots:build']);opened.length=0}
})

test('project listener rows expose dog menus even away from their name buttons',async t=>{
 const dogs=[dog('project_listener'),dog('listener_watch',{count:2})],node={id:'build',kind:'project',state:'live',children:[]} as unknown as CanvasNode
 function Register(){useProvideAgentNav(()=>[{label:'Focus',onSelect:()=>{}}]);return null}
 const view=await mountView(<AgentNavProvider><ObjectNavProvider><Register/><ObjectNavHost {...{isProject:(id:string)=>id==='build'}} org="org" dogs={dogs} openDog={()=>{}} toast={()=>{}}/><DeskDogsProvider value={{org:'org',dogs,open:()=>{}}}><ObjectMenuBoundary><ListenersView node={node} dogs={dogs} map={new Map()} op={async()=>({} as never)} toast={()=>{}}/></ObjectMenuBoundary></DeskDogsProvider></ObjectNavProvider></AgentNavProvider>,el=>el)
 t.after(view.unmount)
 assert.equal(view.el.querySelectorAll('.listener-row').length,2)
 for(const row of view.el.querySelectorAll('.listener-row')){await right(row.querySelector('.dim')!);assert.ok(projectRow());assert.ok(labels().includes('Open details'))}
})

test('semantic slot line keeps its seven table cells, coloured time and nested agent menu',async t=>{
 const w=dog('slot'),node={id:'build',kind:'project',state:'live',children:[]} as unknown as CanvasNode
 const focused:string[]=[]
 function Register(){useProvideAgentNav(id=>[{label:'Focus',onSelect:()=>focused.push(id)}]);return null}
 const view=await mountView(<AgentNavProvider><ObjectNavProvider><Register/><ObjectNavHost {...{isProject:(id:string)=>id==='build'}} org="org" dogs={[w]} openDog={()=>{}} toast={()=>{}}/><DeskDogsProvider value={{org:'org',dogs:[w],open:()=>{}}}><ObjectMenuBoundary><SlotsView node={node} state={projectSlotState('build',1,[],[w])} map={new Map()} onJump={()=>{}} op={async()=>({holders:[],line:[{position:1,agent:'worker',dog:'slot',since:w.at}],history:[]} as never)} toast={()=>{}}/></ObjectMenuBoundary></DeskDogsProvider></ObjectNavProvider></AgentNavProvider>,el=>el)
 t.after(view.unmount);await flush()
 const row=view.el.querySelector('.slots-line .slot-row')!
 assert.equal(row.tagName,'TR');assert.equal(row.children.length,7);assert.equal(row.firstElementChild!.textContent,'1st')
 assert.ok(row.querySelector('.slot-wait .slot-time')?.getAttribute('style'),'SlotTime colour preserved')
 assert.deepEqual(Array.from(view.el.querySelectorAll('thead th')).map(e=>e.textContent),['Position','Agent','Waited','Held','Ended','Claim / lease','Action'])
 await right(row.querySelector('.slot-rest')!);assert.ok(projectRow());await inAct(()=>projectRow()!.click());assert.deepEqual(focused,['build'])
 await right(row.querySelector('[data-agent-nav="worker"]')!);assert.equal(projectRow()===undefined,true,'inner agent link keeps its menu')
 await inAct(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(e=>e.textContent==='Focus')!.click());assert.deepEqual(focused,['build','worker'])
})

test('mail listener rows (the inbox listeners table) are watchdog rows; the agent link keeps its own menu',async t=>{
 const w=dog('fair_queue',{once:false}),node={id:'build',kind:'project',state:'live',children:[]} as unknown as CanvasNode
 const focused:string[]=[]
 function Register(){useProvideAgentNav(id=>[{label:'Focus',onSelect:()=>focused.push(id)}]);return null}
 const map=new Map([['worker',{id:'worker',state:'live',tier:'haiku',children:[]} as unknown as CanvasNode]])
 const view=await mountView(<AgentNavProvider><ObjectNavProvider><Register/><ObjectNavHost {...{isProject:(id:string)=>id==='build'}} org="org" dogs={[w]} openDog={()=>{}} toast={()=>{}}/><DeskDogsProvider value={{org:'org',dogs:[w],open:()=>{}}}><ObjectMenuBoundary><MailListenersView node={node} state={mailListenerState('build',[w])} map={map} onJump={id=>focused.push('jump:'+id)} rows={[]} ack={false}/></ObjectMenuBoundary></DeskDogsProvider></ObjectNavProvider></AgentNavProvider>,el=>el)
 t.after(view.unmount);await flush()
 const row=view.el.querySelector('.mail-listeners-table tr.listener-row')!
 assert.equal(row.tagName,'TR');assert.equal(row.getAttribute('data-object-nav'),'watchdog');assert.equal(row.getAttribute('data-object-id'),w.id)
 await right(row.querySelector('.listener-handed')!);assert.ok(projectRow(),'the row borrows the dog menu');assert.ok(labels().includes('Open details'))
 await right(row.querySelector('[data-agent-nav="worker"]')!);assert.equal(projectRow()===undefined,true,'inner agent link keeps its menu')
})
