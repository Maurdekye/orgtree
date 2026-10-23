import {createRoot} from 'react-dom/client'
import {DeskChat} from '../src/canvas/desk'
import {ProjectDesk} from '../src/canvas/projectdesk'
import type {CanvasNode} from '../src/canvas/shared'
import '../src/styles.css'
import '../src/shell.css'

const leaf={id:'worker',tier:'sol',kind:'agent',state:'live',generation:1,children:[],seat:2,grant:0,
  scope:{tools:{},add_dirs:[],effort:'high'},configured_scope:{tools:{},add_dirs:[]},turns:[],lineage:[],
  audiences_held:[],mail_pending:0} as unknown as CanvasNode
const manager={...leaf,id:'manager',children:[leaf],grant:5}
const project={...leaf,id:'project',tier:'project',kind:'project',children:[leaf],seat:0} as CanvasNode
const map=new Map([[leaf.id,leaf],[manager.id,manager],[project.id,project]])
globalThis.fetch=async()=>new Response(JSON.stringify({messages:[],pending:[],delivered:[],items:[],docs:[],references:{},
  after:'0:0',has_more:false,total:0}),{status:200,headers:{'Content-Type':'application/json'}})
document.documentElement.dataset.theme='dark'
document.body.style.cssText='margin:0;padding:16px;background:#202020;color:#ddd;box-sizing:border-box'
const props={map,slug:'desk-tooltip-capture',tree:{slug:'desk-tooltip-capture',roots:[]} as never,
  op:async()=>({}),toast:()=>{},bare:true}
createRoot(document.getElementById('root')!).render(<>
  <p style={{margin:'0 0 8px'}}>Desk header controls · native hover titles checked separately</p>
  {[leaf,manager,project].map(node=><section key={node.id} data-probe={node.id} style={{height:200,marginBottom:8}}>
    {node.kind==='project' ? <ProjectDesk {...props} node={node} refs={{world:{org:props.slug},onOpen:()=>{}} as never}/>
      : <DeskChat {...props} node={node}/>}
  </section>)}
</>)
