import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const make = (id: string, parent?: string, extra = {}) => ({ id, title: id, parent, generation: 1,
  state: 'live', tier: 'sol', children: [], turns: [], seat: 2, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, ...extra } as CanvasNode)
export const root = make('team-lead')
export const project = make('project-team', undefined, { kind: 'project', tier: 'project' })
const child = make('layout-author', root.id, { busy: true,
  last_status: { status: 'working', summary: 'Checking the toolbar and list' } })
const projectChild = { ...child, id: 'project-author', parent: project.id }
root.children = [child]; project.children = [projectChild]
export const map = new Map([root,child,project,projectChild].map(n=>[n.id,n]))
export const tree = { slug:'team-actions-synthetic', roots:[root,project] } as unknown as TreePayload
export function TeamActionsFixture({ isProject, onOpen = noop, onShow = noop }: {
  isProject: boolean; onOpen?: (kind:string,id:string)=>void; onShow?: (kind:string,id:string)=>void
}) {
  return <AgentSurfaceRoutesProvider value={{open:onOpen,show:onShow}}>
    {isProject ? <ProjectDesk bare node={project} map={map} tree={tree} slug={tree.slug}
      op={async()=>({})} toast={noop} refs={{world:{org:tree.slug},onOpen:noop} as never} onJump={noop}/>
      : <DeskChat bare node={root} map={map} slug={tree.slug} op={async()=>({})} toast={noop} onJump={noop}/>}
  </AgentSurfaceRoutesProvider>
}
