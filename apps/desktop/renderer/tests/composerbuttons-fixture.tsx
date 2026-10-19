import {DeskChat} from '../src/canvas/desk'
import {ProjectDesk} from '../src/canvas/projectdesk'
import {composerAgent,seedComposer} from './composerfocus-fixture'
import type {CanvasNode} from '../src/canvas/shared'
import type {TreePayload} from '../src/types'

export {seedComposer}
export function ComposerButtonsFixture({project=false,busy=false}:{project?:boolean;busy?:boolean}) {
  const slug=`composer-buttons-${project?'project':busy?'busy':'idle'}`
  const node={...composerAgent,dnd:true,busy,responding:busy,effort_current:busy?'medium':null,pending_effort:busy?'xhigh':null}
  const parent={...composerAgent,id:'test-project',tier:'project',kind:'project',children:[node]} as CanvasNode
  const map=new Map([[node.id,node],[parent.id,parent]])
  if(project)return <ProjectDesk node={parent} slug={slug} map={map} tree={{slug,roots:[parent]} as unknown as TreePayload}
    bare op={async()=>({})} toast={()=>{}} refs={{world:{org:slug},onOpen:()=>{}} as never}/>
  return <DeskChat node={node} slug={slug} map={map} bare op={async()=>({})} toast={()=>{}}/>
}
