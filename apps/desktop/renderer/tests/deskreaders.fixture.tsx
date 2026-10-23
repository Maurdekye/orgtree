import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

export const noop=()=>{}
export const op=async()=>({})
export const child={id:'worker',title:'worker',parent:'lead',generation:1,state:'live',tier:'sol',model_id:'sol',
  children:[],turns:[],seat:1,grant:0,free:0,scope:{tools:{},add_dirs:[]}} as unknown as CanvasNode
export const lead={...child,id:'lead',title:'lead',parent:'user',children:[child]} as unknown as CanvasNode
export const project={...lead,id:'pool',title:'pool',kind:'project',tier:'project',parent:'user',children:[{...child,parent:'pool'}],
  charter:'A project with presentations from its team.',configured_scope:{tools:{},add_dirs:[]}} as unknown as CanvasNode
export const tree=(node:CanvasNode)=>({slug:'readers',roots:[node],watchdogs:[],slot_leases:[]} as unknown as TreePayload)
export const map=(node:CanvasNode)=>new Map([[node.id,node],...node.children.map(c=>[c.id,c] as [string,CanvasNode])])
export const Agent=({node=lead}:{node?:CanvasNode})=><DeskChat node={node} map={map(node)} slug="readers" bare op={op} toast={noop}/>
export const Project=()=> <ProjectDesk node={project} slug="readers" tree={tree(project)} map={map(project)} bare op={op} toast={noop} refs={{world:{org:'readers'},onOpen:noop} as never}/>
export const documentRow={id:'proposal',node:'worker',title:'Team proposal',at:'2026-10-22T10:00:00Z',viewed_at:null,node_state:'live',format:'markdown',evicted:false}
export const workRow={slug:'team-ticket',title:'Team ticket',kind:'code',rev:1,status:'in_progress',archived:false,
  owner:{node:'worker',generation:1},owner_current:true,owner_state:'live',participants:[],questions:[],
  objective:'A ticket from the team is available here.',done_so_far:[],working_on_next:[],dependencies:[],evidence:[],history:[],attachments:[],
  dismissals:[],acceptance:[],effective_attention:false,attention_sources:[],at:'2026-10-22T10:00:00Z',updated_at:'2026-10-22T10:00:00Z'}
