import { createRoot } from 'react-dom/client'
import { ProjectDesk } from '../src/canvas/projectdesk'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'
import '../src/styles.css'
import '../src/shell.css'

// Standalone synthetic renderer: every request is answered in memory.
const now = Date.now()
const since = new Date(now - 9 * 60_000).toISOString()
const ended = new Date(now - 60_000).toISOString()
const agents = ['worker-a', 'worker-b', 'worker-c'].map(id => ({
  id, title: id, tier: 'sol', kind: 'agent', state: 'live', model_id: 'gpt-6',
  seat: 1, grant: 0, free: 0, scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] },
  parent: 'build-fixture', children: [], lineage: [], turns: [], audiences_held: [], mail_pending: 0,
  last_status: null, occupancy: 0, context_window: 0, busy: false, activity: null,
} as unknown as CanvasNode))
const node = { ...agents[0], id: 'build-fixture', title: 'build-fixture', tier: 'project', kind: 'project',
  model_id: '', children: agents, charter: 'Synthetic build machine.',
  configured_scope: { tools: {}, add_dirs: [], slots_capacity: 1 }, parent: null,
} as unknown as CanvasNode
const holds = [{ project: node.id, lease: 's_fixture_hold', agent: agents[0].id, slot: 37,
  reason: 'focused checks', since, reminders: 0 }]
const dogs = agents.slice(1).map((agent, i) => ({ id: agent.id + '/checks', owner: agent.id,
  name: 'focused checks', kind: 'slot', target: node.id, state: 'armed', once: true,
  fired: 0, spent: false, at: since, queued_at: new Date(now - (8 - i) * 60_000).toISOString(), interval_s: 60 }))
const status = { project: node.id, slots: 1, held: 1, holders: holds,
  line: dogs.map((dog, i) => ({ position: i + 1, agent: dog.owner, dog: dog.id, since: dog.queued_at })),
  history: agents.slice(1).map((agent, i) => ({ lease: 's_fixture_old_' + i, agent: agent.id,
    slot: 37, since, ended, how: i === 0 ? 'released' : 'idle: not released after 3 reminders' })),
}
globalThis.fetch = async () => new Response(JSON.stringify({ items: [], docs: [], references: {},
  nodes: [], has_more: false, next_cursor: null, total: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
document.documentElement.dataset.theme = 'dark'
document.body.style.cssText = 'margin:0;background:#202020;color:#ddd;font:13px sans-serif'
createRoot(document.getElementById('root')!).render(<ProjectDesk node={node} slug="synthetic-slot-fixture"
  tree={{ slug: 'synthetic-slot-fixture', roots: [node], slot_leases: holds, watchdogs: dogs } as unknown as TreePayload}
  map={new Map([node, ...agents].map(agent => [agent.id, agent]))}
  op={async request => (request.op === 'slot_status' ? status : {}) as unknown as OpResult}
  onJump={id => { document.body.dataset.lastSlotJump = id }} toast={() => {}}
  refs={{ world: { org: 'synthetic-slot-fixture' }, onOpen: () => {} } as never} bare />)
