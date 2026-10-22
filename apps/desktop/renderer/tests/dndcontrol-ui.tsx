import {createRoot} from 'react-dom/client'
import {DeskChat} from '../src/canvas/desk'
import type {CanvasNode} from '../src/canvas/shared'
import '../src/styles.css'
import '../src/shell.css'
const node={id:'focused-worker',tier:'sol',kind:'agent',state:'live',generation:1,dnd:false,dnd_next_turn:true,
  children:[],seat:2,grant:0,scope:{tools:{},add_dirs:[],effort:'high'},configured_scope:{tools:{},add_dirs:[]},
  turns:[],lineage:[],audiences_held:[],mail_pending:0} as unknown as CanvasNode
globalThis.fetch=async()=>new Response(JSON.stringify({messages:[],pending:[],delivered:[],items:[],docs:[],references:{},
  after:'0:0',has_more:false,total:0}),{status:200,headers:{'Content-Type':'application/json'}})
document.documentElement.dataset.theme='dark'
document.body.style.cssText='margin:0;padding:20px;background:#202020;color:#ddd;box-sizing:border-box'
createRoot(document.getElementById('root')!).render(<div style={{height:640}}>
  <DeskChat node={node} map={new Map([[node.id,node]])} slug="dnd-capture" op={async()=>({})}
    toast={()=>{}} bare/></div>)
