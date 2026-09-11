import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PinFrame, pinModal, commitModalRect } from '../src/canvas/modalpin'
import { PinLayer, addPin, commitRect } from '../src/canvas/pins'
import { DeskHosts } from '../src/canvas/deskhosts'
import { CurrentOrg } from '../src/popout'
import type { CanvasNode } from '../src/canvas/shared'
import '../src/styles.css'
const node = { id: 'builder', title: 'builder', tier: 'haiku', model_id: 'haiku', state: 'live', parent: 'user',
 seat:1,grant:0,free:0,generation:0,children:[],lineage:[],turns:[],last_denials:[],audiences_held:[],
 scope:{permission_mode:'default',add_dirs:[],tools:{},org_visibility:'team'},
 context_window:200000,occupancy:20000,last_status:{status:'idle',summary:'Ready'},cost_usd:0 } as unknown as CanvasNode
const map=new Map([['builder',node]]), rect={x:300,y:180,w:600,h:460},noop=()=>{}
const requests:string[]=[]
window.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
 if(init?.method && init.method!=='GET')throw new Error('Blocked fixture mutation')
 const url=String(input);requests.push(url)
 return new Response(JSON.stringify(url.includes('/chat')?{messages:[],total:0,busy:false,pending_mail:[],session_id:'fixture'}:url.includes('work-items')?{items:[],counts:{attention:0,active:0,archived:0,backlogged:0}}:{}),{headers:{'Content-Type':'application/json'}})
}) as typeof fetch
function Fixture(){
 const viewportRef=useRef<HTMLDivElement>(null),[open,setOpen]=useState(['alpha','beta']),[jumps,setJumps]=useState(0)
 Object.assign(window,{chromeProbe:{reset:(agent=false)=>agent?commitRect('fixture','builder',rect,{w:1400,h:900}):commitModalRect('alpha',rect),pinAt:pinModal,pin:()=>pinModal('alpha',rect),agent:()=>{setOpen([]);addPin('fixture','builder',rect)},requests}})
 return <CurrentOrg.Provider value="fixture"><DeskHosts slug="fixture" map={map}>
 <div ref={viewportRef} style={{position:'fixed',inset:0,overflow:'hidden'}}>
 <output id="jumps">{jumps}</output><div id="flow-marker" style={{width:160,height:40}}>Main canvas marker</div>
 <PinLayer slug="fixture" map={map} viewportRef={viewportRef} targetOf={()=>null} op={async()=>({})} toast={noop} pub={false} maxTop={100} pxc={1} onMailLink={noop} onWorkLink={noop} onOpenDoc={noop} onLineage={noop} onConfig={noop} onJump={()=>setJumps(v=>v+1)} onShowOnCanvas={()=>setJumps(v=>v+1)} />
 </div>
 {open.map(id=><PinFrame key={id} kind={id} title={id} panel={'settings test-'+id} close={()=>setOpen(v=>v.filter(x=>x!==id))}>
 <h3>{id}</h3><input aria-label={'Draft '+id} defaultValue="preserved"/><div style={{minHeight:1000}}>Long scrollable content</div><button onClick={()=>setOpen(v=>v.filter(x=>x!==id))}>Done {id}</button>
 </PinFrame>)}
 </DeskHosts></CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture/>)
