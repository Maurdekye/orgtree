import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { MailReplyBox } from '../src/canvas/mail'
import { QuickChat } from '../src/QuickChatBox'
import { syncProviderRegistries } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop=()=>{}
export const composerAgent={id:'test-writer',tier:'sol',state:'live',generation:1,model_id:'gpt-6.1-sol',
  children:[],seat:2,grant:0,free:0,scope:{tools:{},add_dirs:[],effort:'high'},configured_scope:{tools:{},add_dirs:[]},
  turns:[],lineage:[],audiences_held:[],mail_pending:0} as unknown as CanvasNode
export const seedComposer=()=>syncProviderRegistries({providers:[{id:'openai',tiers:[
  {tier:'sol',model:'gpt-6.1-sol',fast_mode:true,effort_levels:['low','medium','high']},
]}]})
export function ComposerFocusFixture({surface,busy=false}:{surface:'agent'|'project'|'quick'|'reply';busy?:boolean}){
  const slug=`synthetic-composer-${surface}`,node={...composerAgent,busy,phase:busy?'thinking':undefined},
    project={...node,id:'test-project',kind:'project',tier:'project',children:[node]} as CanvasNode,
    map=new Map([[node.id,node],[project.id,project]]),tree={slug,roots:[project],max_top_grant:100} as unknown as TreePayload
  if(surface==='agent')return <DeskChat node={node} map={map} slug={slug} bare op={async()=>({})} toast={noop}/>
  if(surface==='project')return <ProjectDesk node={project} map={map} tree={tree} slug={slug} bare op={async()=>({})}
    toast={noop} refs={{world:{org:slug},onOpen:noop} as never}/>
  if(surface==='quick')return <QuickChat slug={slug} tree={tree} op={async()=>({})} toast={noop} onHired={noop}/>
  return <MailReplyBox target={node.id} slug={slug} onSend={noop}/>
}
