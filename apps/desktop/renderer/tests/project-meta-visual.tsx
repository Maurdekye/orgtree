import { createRoot } from 'react-dom/client'
import { ProjectSquare } from '../src/canvas/projectcard'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { applyTheme } from '../src/themes'
import { legacyAppBackend } from './appfeed-fixture'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload, Watchdog } from '../src/types'
const noop=()=>{},now=Date.now(),since=new Date(now-17*60000).toISOString()
const scenario=new URLSearchParams(location.search).get('scenario')||'active'
const children=Array.from({length:24},(_,i)=>({id:'worker-'+(i+1),title:'worker-'+(i+1),kind:'agent',tier:'sol',state:'live',parent:'synthetic-build',
 children:[],busy:i<4,inflight_at:i<4?since:null,scope:{tools:{},add_dirs:[]},lineage:[],turns:[],mail_pending:0})) as unknown as CanvasNode[]
const node={id:'synthetic-build',title:'synthetic-build',kind:'project',tier:'project',state:'live',parent:null,children,
 charter:'Synthetic project: three slots, queued mail and waiting event listeners together.',scope:{tools:{},add_dirs:[]},
 configured_scope:{slots_capacity:3,mail_queue:'ack'},mail_pending:3,mail_held:1,lineage:[],turns:[],documents:[]} as unknown as CanvasNode
const dog=(kind:Watchdog['kind'],owner:string,name:string,extra:Partial<Watchdog>={}):Watchdog=>({id:owner+'/'+name,kind,owner,name,target:node.id,
 state:'armed',at:since,queued_at:since,spent:false,once:true,interval_s:5,fired:0,...extra} as Watchdog)
const dogs=[dog('slot','worker-4','waiting-one'),dog('slot','worker-5','waiting-two'),
 dog('fair_queue','worker-6','mail-one',{once:false}),dog('fair_queue','worker-7','mail-two',{once:false}),
 dog('project_listener','worker-8','ready-one'),dog('project_listener','worker-9','ready-two'),
 dog('listener_watch','worker-10','all-ready',{count:3,fire_actions:[{tool:'orgtree_project',args:{action:'fire_event',name:node.id}}]})]
if(scenario==='queued'||scenario==='flight'){
 for(let i=dogs.length-1;i>=0;i--)if(dogs[i]!.kind==='fair_queue')dogs.splice(i,1)
 node.mail_pending=scenario==='queued'?3:0;node.mail_held=scenario==='flight'?1:0
}else if(scenario==='long'){
 for(let i=2;i<128;i++)dogs.push(dog('fair_queue','synthetic-listener-'+i,'mail-'+i,{once:false}))
 node.mail_pending=999999;node.mail_held=128
}
const leases=[1,2,3].map(n=>({project:node.id,agent:'worker-'+n,slot:n,lease:'synthetic-'+n,since,reason:'Synthetic held permit'}))
if(scenario==='long'){
 (node.configured_scope as {slots_capacity:number}).slots_capacity=64
 for(let i=4;i<=64;i++)leases.push({project:node.id,agent:'synthetic-holder-'+i,slot:i,lease:'synthetic-'+i,since,reason:'Synthetic held permit'})
 for(let i=2;i<128;i++)dogs.push(dog('slot','synthetic-waiter-'+i,'wait-'+i))
 for(let i=2;i<128;i++)dogs.push(dog('project_listener','synthetic-event-'+i,'event-'+i))
 dogs.find(d=>d.kind==='listener_watch')!.count=999
}
const tree={slug:'fixture',name:'Fixture',roots:[node],watchdogs:dogs,slot_leases:leases,net:{hubs:[]},nodes:[],edges:[]} as unknown as TreePayload
const map=new Map<string,CanvasNode>([[node.id,node],...children.map(n=>[n.id,n] as [string,CanvasNode])])
window.fetch=legacyAppBackend(async()=>new Response(JSON.stringify({items:[],nodes:[],facts:[],rows:[],agents:[]}),{headers:{'content-type':'application/json'}}))
localStorage.clear();applyTheme('orgtree')
const refs={world:{org:'fixture'},onOpen:noop} as never
function Card({scale}:{scale:number}){return <section className="fixture-card" data-scale={scale} style={{position:'absolute',left:35,top:90+([1,0.75,1.25].indexOf(scale))*175,transform:`scale(${scale})`,transformOrigin:'top left'}}>
 <ProjectSquare node={node} tree={tree} map={map} pos={{x:0,y:0}} lod="norm" dragging={false} isDrop={false} op={async()=>({} as never)}
  slug="fixture" toast={noop} zoom={scale} hire={{}} seats={{}} onHire={noop} onNewProject={noop} onInbox={noop}
  onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}/>
 </section>}
createRoot(document.getElementById('root')!).render(<>
 <h1>One project · slots, mail and event listeners together</h1>
 <p className="fixture-caption">Synthetic data · {scenario} mail state · 4/24 active for 17m · {scenario==='long'?'64 held / 128 waiting slots':'3 held / 2 waiting slots'} · {scenario==='long'?"128 mail listeners / 999999 queued / 128 in flight":scenario==='queued'?'3 queued / nobody listening':scenario==='flight'?'1 in flight / nobody listening':'2 mail listeners / 3 queued / 1 in flight'} · {scenario==='long'?'128 of 999':'2 of 3'} event listeners ready</p>
 {[1,0.75,1.25].map(scale=><Card key={scale} scale={scale}/>)}
 <section id="fixture-desk" style={{position:'absolute',left:280,top:90,width:680,height:480,border:'1px solid var(--line)',borderRadius:6,overflow:'hidden'}}>
  <ProjectDesk bare node={node} slug="fixture" tree={tree} map={map} refs={refs} toast={noop} op={async()=>({} as never)}/>
 </section>
</>)
