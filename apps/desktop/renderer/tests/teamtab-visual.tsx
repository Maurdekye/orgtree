import { createRoot } from 'react-dom/client'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { AgentSurfaceRoutesProvider } from '../src/canvas/panelcorner'
import type { CanvasNode } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

// Synthetic state only; no request may reach a running engine.
window.fetch = (() => Promise.resolve(new Response(JSON.stringify({
  items: [], references: {}, revisions: {}, next_cursor: null,
}), { headers: { 'content-type': 'application/json' } }))) as typeof fetch
const make = (id: string, parent: string | undefined, extra = {}) => ({
  id, title: id, parent, generation: 1, state: 'live', tier: 'sol', children: [],
  seat: 2, grant: 0, free: 0, turns: [], scope: { tools: {}, add_dirs: [] }, ...extra,
} as CanvasNode)
const root = make('website', undefined, { kind: 'project', tier: 'project' })
const lead = make('lead', root.id, { tier: 'astra', last_status: { status: 'working', summary: 'Finishing the team view' } })
const nested = make('frontend', root.id, { kind: 'project', tier: 'project' })
const busy = make('renderer', nested.id, { busy: true, last_status: { status: 'working', summary: 'Checking the layout and filters' } })
const idle = make('writer', nested.id, { last_status: { status: 'done', summary: 'Documentation is ready' } })
const unrelated = make('outside-this-team', undefined)
nested.children = [busy, idle]; root.children = [lead, nested]
const map = new Map([root, lead, nested, busy, idle, unrelated].map(n => [n.id, n]))
const tree = { slug: 'synthetic', roots: [root, unrelated] } as unknown as TreePayload
const noop = () => {}
createRoot(document.getElementById('root')!).render(
  <AgentSurfaceRoutesProvider value={{ open: noop, show: noop }}>
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 12, color: 'var(--dim)' }}>Synthetic project desk · Team</div>
      <div style={{ height: 580 }}>
        <ProjectDesk bare node={root} slug="synthetic" tree={tree} map={map}
          op={async () => ({})} toast={noop} refs={{ world: { org: 'synthetic' }, onOpen: noop } as never}
          onJump={noop} />
      </div>
    </div>
  </AgentSurfaceRoutesProvider>)
