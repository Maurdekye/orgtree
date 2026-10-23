import { createRoot } from 'react-dom/client'
import { DeskReportRow } from '../src/canvas/desk'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { WatchdogCanvasCards } from '../src/canvas/watchdoggroup'
import { applyTheme } from '../src/themes'
import type { Watchdog } from '../src/types'

const root=createRoot(document.getElementById('root')!),opened:string[]=[]
const kinds:Watchdog['kind'][]=['file','event','command','mqtt','websocket','fair_queue','slot','project_listener','listener_watch']
let all:Watchdog[]=[]
window.fetch=async()=>new Response(JSON.stringify({watchdogs:all,total:all.length,next_cursor:null}),{headers:{'Content-Type':'application/json'}})
function render(count:number){
  all=Array.from({length:count},(_,i)=>({id:'worker/watch-'+(i+1),name:'watch-'+(i+1),owner:'worker',kind:kinds[i%kinds.length]!,
    target:'synthetic',interval_s:600,once:i%3===0,state:i===2?'paused':'armed',fired:0,count:2,at:'2026-10-20T00:00:00Z'}))
  const dogs=all.slice(0,8),counts={worker:{total:count,kept:count,one_shot:Math.ceil(count/3)}}
  root.render(<DeskDogsProvider value={{org:'fixture',dogs,counts,open:id=>opened.push(id)}}>
    <main style={{padding:24}}><h2>Owner watchdog cards · {count} kept watchdogs</h2>
      <div style={{display:'grid',gridTemplateColumns:'360px 500px',gap:36}}>
        <section><h3>Canvas</h3><div style={{position:'relative',height:230}}>
          <div style={{position:'absolute',left:70,top:8,padding:16,border:'1px solid var(--line)',borderRadius:8}}>worker</div>
          <WatchdogCanvasCards org="fixture" dogs={dogs} counts={counts} onOpen={id=>opened.push(id)} visible={()=>true}
            position={id=>{const i=dogs.findIndex(w=>w.id===id);return count>8?{x:70,y:80}:{x:34+(i%3)*58,y:80+Math.floor(i/3)*34}}}/>
        </div></section>
        <section><h3>Desk jump row</h3><DeskReportRow node={{id:'worker',children:[]}} map={new Map()}
          dogs={{dogs,total:count,org:'fixture',open:id=>opened.push(id)}}/>
          <p className="dim">Each link keeps its kind, state, lifetime outline and object menu.</p></section>
      </div>
    </main>
  </DeskDogsProvider>)
}
localStorage.clear();applyTheme('custom:#b6bdc8')
Object.assign(window,{fixtureRender:render,fixtureOpened:opened})
render(8)
