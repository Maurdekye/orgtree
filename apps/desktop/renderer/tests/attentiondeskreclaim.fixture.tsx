import type { ReactNode } from 'react'
import { DeskHosts, DeskSlot } from '../src/canvas/deskhosts'
import type { CanvasNode } from '../src/canvas/shared'
import { USER } from '../src/canvas/shared'
import { AttentionView, DESK_KIND } from '../src/attention/AttentionView'
import { setAttentionLayout, setOrgView } from '../src/attention/mode'
import { pinModal } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import type { OpFn, TreePayload } from '../src/types'

export const SLUG = 'desk-reclaim-fixture'
const noop = () => {}
const op: OpFn = async () => ({})
export function attentionDeskScene() {
  const node = { id: 'alpha', parent: USER, tier: 'opus', state: 'live', generation: 0,
    children: [], seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] } } as unknown as CanvasNode
  const map = new Map<string, CanvasNode>([[USER, { id: USER, parent: null, tier: null,
    state: 'user', children: ['alpha'] } as unknown as CanvasNode], ['alpha', node]])
  const tree = { slug: SLUG, name: 'Desk fixture', epoch: 1, rev: 1, roots: [],
    work_items_summary: { attention: 0, active: 0 }, user_inbox_count: 0,
    user_inbox_urgent_count: 0, asks: [], asks_open: 0, max_top_grant: 1000 } as unknown as TreePayload
  // Reuse this exact element on open/close. A parent re-render or click must
  // not repair ownership incidentally by refreshing the remaining slot.
  const attention = <AttentionView key="attention" slug={SLUG} tree={tree} map={map} op={op} toast={noop} />
  const switchboard = <aside key="switchboard" data-switchboard style={{ position: 'absolute',
    left: 700, top: 60, width: 360, height: 600, display: 'flex', flexDirection: 'column',
    background: 'var(--panel)', border: '1px solid var(--line)' }}>
    <h3>Switchboard · alpha</h3>
    <DeskSlot node={node} map={map} slug={SLUG} op={op} toast={noop} bare />
  </aside>
  const wrap = (open: boolean) => <CurrentOrg.Provider value={SLUG}>
    <DeskHosts map={map} slug={SLUG}>{attention}{open && switchboard}</DeskHosts>
  </CurrentOrg.Provider>
  return { node, map, wrap, init: () => {
    setOrgView(SLUG, 'canvas')
    setAttentionLayout(SLUG, { agent: 'alpha' })
    pinModal(DESK_KIND, { x: 24, y: 60, w: 640, h: 600 }, SLUG)
  } }
}

export function eligibleDeskScene() {
  const { node, map } = attentionDeskScene()
  const box = (name: string, eligible: boolean) => <div key={name} data-host={name}>
    <DeskSlot node={node} map={map} slug={SLUG} op={op} toast={noop} bare eligible={eligible} />
  </div>
  const hidden = box('hidden', false), visible = box('visible', true), owner = box('owner', true)
  const wrap = (...slots: ReactNode[]) => <DeskHosts map={map} slug={SLUG}>{slots}</DeskHosts>
  return { before: wrap(hidden, visible, owner), after: wrap(hidden, visible) }
}
