import { NodeSquare } from '../src/canvas/cards'
import { CreditGrant } from '../src/canvas/creditgrant'
import { DeskChat } from '../src/canvas/desk'
import { InboxAskCard } from '../src/canvas/asks'
import type { CanvasNode } from '../src/canvas/shared'
import type { AskInfo, TreeNode, TreePayload } from '../src/types'

const agent=(id:string,seat:number,grant:number,extra:Partial<CanvasNode>={}):CanvasNode=>({
  id,state:'live',tier:'sol',children:[],seat,grant,free:grant,generation:1,
  scope:{tools:{},add_dirs:[]},turns:[],lineage:[],audiences_held:[],mail_pending:0,...extra,
})
export const reports=[agent('test-manager',2,4,{children:[agent('test-grandchild',2,2)]}),
  agent('test-fractional',0.1,1.9),agent('test-held',1,2,{state:'unrecoverable'}),
  agent('test-retired',5,5,{state:'archived'})]
const project=(id:string,children:CanvasNode[]):CanvasNode=>({id,kind:'project',state:'live',tier:'project',
  seat:0,grant:children.reduce((sum,c)=>sum+(c.state==='archived'?0:(c.seat??0)+(c.grant??0)),0),free:0,children})
export const groupedReports=[project('test-wrapper',[reports[0]!,project('test-nested',[reports[1]!,reports[2]!,reports[3]!]),project('test-empty',[])])]
export const makeNode=(grouped:boolean):CanvasNode=>agent('test-superior',4,20,{free:9,parent:'user',children:grouped?groupedReports:reports})
export const makeTree=(roots:CanvasNode[]):TreePayload=>({roots,max_top_grant:100,cascade_alloc:true} as unknown as TreePayload)
export const noop=()=>{}
const op=async()=>({})
export type Surface='canvas'|'settings'|'desk'|'inbox'
export function ProjectCreditFixture({surface,grouped,askEnabled=true}:{surface:Surface;grouped:boolean;askEnabled?:boolean}) {
  const node=makeNode(grouped),map=new Map([[node.id,node]]),tree=makeTree([node])
  const slug=`synthetic-credit-${surface}-${grouped}`
  const ask:AskInfo={id:`credit-${surface}-${grouped}`,node:node.id,kind:'credit',status:'open',at:'2026-10-19T17:00:00Z',old:20,new:25}
  if(surface==='settings')return <CreditGrant node={node} map={map} tree={tree} op={op}/>
  if(surface==='inbox')return <InboxAskCard ask={ask} node={node as unknown as TreeNode} slug={slug} tree={tree} toast={noop}/>
  if(surface==='desk')return <DeskChat node={{...node,ask}} map={map} slug={slug} bare op={op} toast={noop} pxc={5}/>
  return <NodeSquare node={node} pos={{x:60,y:40}} lod="norm" focused={false} dragging={false} isDrop={false}
    seats={{sol:2}} map={map} op={op} slug={slug} toast={noop} pxc={5} zoom={1} compactAt={0.8} maxTop={100} cascadeAlloc
    onSpawn={noop} onConfig={noop} onInbox={noop} onLineage={noop} onRecenter={noop} onJump={noop} onMailLink={noop} onWorkLink={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop}/>
}
