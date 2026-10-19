import {createRoot} from 'react-dom/client'
import {DeskDogsProvider,DogChip} from '../src/canvas/deskdogs'
import {WatchdogSatellite} from '../src/canvas/watchdogchip'
import {WatchdogLink} from '../src/canvas/watchdoglink'
import {ToolRefs} from '../src/canvas/toolrefs'
import {MailListenersView} from '../src/canvas/maillisteners'
import {mailListenerState} from '../src/canvas/listeners'
import {applyTheme} from '../src/themes'
import type {Watchdog} from '../src/types'
import type {CanvasNode} from '../src/canvas/shared'
const kinds:Watchdog['kind'][]=['command','event','mqtt','slot','fair_queue','project_listener','listener_watch']
const dogs=kinds.flatMap(kind=>[false,true].map(once=>({id:'worker/'+kind+(once?'-once':''),name:kind+(once?'-once':''),owner:'worker',kind,once,state:'armed',target:'synthetic',count:2,interval_s:30,fired:0,at:new Date().toISOString()} as Watchdog)))
const opened:string[]=[];Object.assign(window,{fixtureOpened:opened})
const project={id:'synthetic',kind:'project',state:'live'} as CanvasNode
const map=new Map([['worker',{id:'worker',tier:'sol',state:'live'} as CanvasNode]])
localStorage.clear();applyTheme('orgtree')
createRoot(document.getElementById('root')!).render(<DeskDogsProvider value={{org:'fixture',dogs,open:id=>opened.push(id)}}>
  <main style={{padding:20,fontSize:12}}>
    <h2 style={{margin:'0 0 8px'}}>Watchdog links share their card’s appearance</h2>
    <div style={{display:'grid',gridTemplateColumns:'200px 100px 230px 230px',gap:6,alignItems:'center'}}>
      <strong>Kind / lifetime</strong><strong>Canvas</strong><strong>Desk card</strong><strong>Tool / transcript link</strong>
      {dogs.map(w=><section key={w.id} className="link-sample" data-kind={w.kind} data-once={String(w.once)} style={{display:'contents'}}>
        <span>{w.kind} {w.once?'one-shot':''}</span>
        <div style={{position:'relative',height:25}}><WatchdogSatellite dog={w} dogs={dogs} org="fixture" style={{width:92,height:24}} onOpen={id=>opened.push(id)}/></div>
        <div className="desk-sample"><DogChip dog={w} onOpen={id=>opened.push(id)}/></div>
        <div className="tool-sample"><ToolRefs refs={[{kind:'watchdog',id:w.id}]} owner="worker" org="fixture" agent={id=>id}/></div>
      </section>)}
    </div>
    <div id="unknown-link" style={{marginTop:8}}><WatchdogLink id="worker/removed" name="removed watchdog" org="fixture" stale/></div>
    <div id="mail-listener-sample" style={{marginTop:8}}><MailListenersView node={project} state={mailListenerState('synthetic',dogs)} map={map} rows={[]} ack={false}/></div>
  </main>
</DeskDogsProvider>)
