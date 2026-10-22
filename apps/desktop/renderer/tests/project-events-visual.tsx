// The real project settings and desk, served only by the isolated capture driver.
import { createRoot } from 'react-dom/client'
import { NodeConfig } from '../src/canvas/modals'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { legacyAppBackend } from './appfeed-fixture'
import { rememberDesk } from '../src/canvas/desktabs'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'

legacyAppBackend(() => {})
globalThis.fetch = (async () => new Response(JSON.stringify({
  working_checkups_enabled: true, history: [], records: [], entries: [], charters: [],
}), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
const node = {
  id: 'release-sync', title: 'release-sync', kind: 'project', tier: 'project', state: 'live',
  seat: 0, grant: 0, free: 0, parent: null, children: [], busy: false,
  scope: { tools: {}, add_dirs: [] }, configured_scope: { event_listeners: true },
  charter: 'Coordinate the release checks.', lineage: [], turns: [], audiences_held: [],
  mail_pending: 0, mail_held: 0, last_status: null, occupancy: 0, context_window: 0,
} as unknown as CanvasNode
const tree = { slug: 'synthetic', roots: [node], watchdogs: [], slot_leases: [] } as unknown as TreePayload
const map = new Map([[node.id, node]])
const noop = () => {}
const op = async (): Promise<OpResult> => ({ history: [], history_next: null, listeners_armed: 0 } as unknown as OpResult)
const refs = { world: { org: 'synthetic' }, onOpen: noop } as never
const desk = new URLSearchParams(location.search).get('surface') === 'desk'
rememberDesk('synthetic', node.id, 'tab', 'listeners')
createRoot(document.getElementById('root')!).render(desk
  ? <ProjectDesk bare node={node} slug="synthetic" tree={tree} map={map} op={op} toast={noop} refs={refs} />
  : <NodeConfig node={node} map={map} tree={tree} slug="synthetic" op={op} toast={noop} close={noop} />)
