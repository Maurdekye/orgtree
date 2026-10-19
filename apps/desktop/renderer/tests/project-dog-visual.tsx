import { createRoot } from 'react-dom/client'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { AgentSlotChips } from '../src/canvas/slotchips'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { WatchdogSatellite } from '../src/canvas/watchdogchip'
import { DogChip, DeskDogsProvider } from '../src/canvas/deskdogs'
import { ListenersView } from '../src/canvas/listenersdesk'
import { projectMenuEntries } from '../src/canvas/agentmenu'
import { applyTheme } from '../src/themes'
import type { CanvasNode } from '../src/canvas/shared'
import type { Watchdog } from '../src/types'
const noop=()=>{},now=new Date().toISOString()
const node={id:'synthetic-build',kind:'project',tier:'project',state:'live',children:[],configured_scope:{slots_capacity:3},scope:{tools:{},add_dirs:[]}} as unknown as CanvasNode
const kinds=['command','fair_queue','slot','project_listener','listener_watch'] as Watchdog['kind'][]
const dogs=kinds.flatMap((kind,i)=>[false,true].map(once=>({id:'worker/'+kind+(once?'-once':''),name:kind+(once?'-once':''),owner:'worker',kind,target:node.id,state:'armed',once,spent:false,at:now,queued_at:now,count:3,fired:0,interval_s:60} as Watchdog)))
const opened:string[]=[];(window as unknown as {fixtureOpened:string[]}).fixtureOpened=opened
const projectActions=()=>projectMenuEntries(node,{onOpenDesk:()=>opened.push('focus'),onOpenTemporary:noop,onPin:noop,onPopout:noop,onInbox:noop,onSlots:noop,onSettings:noop},{})
function Register(){useProvideAgentNav(id=>id===node.id?projectActions():[]);return null}
localStorage.clear();applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<AgentNavProvider><ObjectNavProvider><Register/>
 <ObjectNavHost {...{isProject:(id:string)=>id===node.id}} org="fixture" dogs={dogs} openDog={id=>opened.push(id)} toast={noop}/>
 <DeskDogsProvider value={{org:'fixture',dogs,open:id=>opened.push(id)}}><AgentSurfaceRoutesProvider value={{open:(kind,id)=>opened.push(kind+':'+id),show:noop}}>
 <ObjectMenuBoundary style={{padding:24,height:650,boxSizing:'border-box'}}>
 <h2 style={{margin:'0 0 10px'}}>Project watchdogs and slot chips</h2>
 <p style={{fontSize:12}}>Synthetic fixtures · continuous / one-shot · full shared project menu</p>
 {dogs.map((dog,i)=><section key={dog.id} className="outline-sample" data-kind={dog.kind} data-once={String(dog.once)} style={{position:'absolute',left:24+(i%2)*235,top:115+Math.floor(i/2)*78,width:218,height:66}}>
  <small style={{fontSize:11}}>{dog.kind} {dog.once?'(one-shot)':'(continuous)'}</small>
  <WatchdogSatellite dog={dog} dogs={dogs} org="fixture" style={{left:0,top:23,width:75,height:32,fontSize:9}} onOpen={id=>opened.push(id)}/>
  <div style={{position:'absolute',left:85,top:23,maxWidth:125}}><DogChip dog={dog} onOpen={id=>opened.push(id)}/></div>
 </section>)}
 <section id="slot-chips" style={{position:'absolute',left:535,top:100,display:'flex',gap:6}}><AgentSlotChips agent="worker" leases={[{agent:'worker',project:node.id,slot:1,lease:'synthetic',since:now}]} dogs={dogs}/></section>
 <section id="listener-rows" style={{position:'absolute',left:24,top:505,width:940,fontSize:11}}><ListenersView node={node} dogs={dogs.filter(w=>w.once)} map={new Map()} op={async()=>({} as never)} toast={noop}/></section>
 </ObjectMenuBoundary></AgentSurfaceRoutesProvider></DeskDogsProvider>
 </ObjectNavProvider></AgentNavProvider>)
