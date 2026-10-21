import {createRoot} from 'react-dom/client'
import {ProjectSquare} from '../src/canvas/projectcard'
import type {CanvasNode} from '../src/canvas/shared'
import type {TreePayload} from '../src/types'
import '../src/styles.css'
const noop=()=>{}
const project={id:'resource-lock',kind:'project',tier:'project',state:'live',children:[],configured_scope:{slots_capacity:64},scope:{},mail_pending:0} as unknown as CanvasNode
const tree={slug:'synthetic-slot-limit',watchdogs:[],slot_leases:[]} as unknown as TreePayload
window.fetch=async()=>({ok:true,status:200,headers:new Headers(),json:async()=>({})}) as Response
createRoot(document.getElementById('root')!).render(<div className="app" style={{height:'100vh'}}>
 <h2 style={{padding:24}}>Project slot count at near zoom</h2>
 <div style={{position:'relative',transform:'scale(3)',transformOrigin:'top left',marginLeft:40}}>
 <ProjectSquare node={project} pos={{x:20,y:12}} lod="norm" zoom={3} tree={tree} map={new Map([[project.id,project]])}
  dragging={false} isDrop={false} op={async()=>({})} slug={tree.slug} toast={noop} hire={{}} seats={{}}
  onHire={noop} onNewProject={noop} onInbox={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}/>
 </div>
</div>)
