import { createRoot } from 'react-dom/client'
import { AgentDocketModal } from '../src/canvas/agentdocket'
import { CurrentOrg } from '../src/popout'
import { compatibilityWorkFixture } from './workcompat.fixture'
import type { TreePayload, WorkItem } from '../src/types'

const noop = () => {}
const owner = { node: 'developer', generation: 1 }
const makeItem = (slug: string, title: string, objective: string, parent?: string): WorkItem => ({
  slug, title, objective, parent, rev: 1, kind: 'code', status: 'in_progress', archived: false,
  owner, owner_current: true, participants: [], questions: [], done_so_far: [], working_on_next: [],
  dependencies: [], evidence: [], history: [], dismissals: [], acceptance: [], attention_sources: [],
  effective_attention: false, manual_attention: null, at: '2026-10-21T12:00:00Z',
  updated_at: '2026-10-21T12:00:00Z', docket_at: '2026-10-21T12:00:00Z',
} as unknown as WorkItem)
const items = [
  makeItem('implementation', 'Implement the shared opening rule', 'Use the first ticket shown by the current sort and grouping.', 'release-plan'),
  makeItem('release-plan', 'Release plan', 'Opening ticket selected automatically.\n\nSpecific ticket links keep their target. A deliberate clear stays empty after refresh.'),
  makeItem('checks', 'Verify every docket surface', 'Cover the agent desk, team, project and org dockets.'),
]
const tree = { slug: 'demo', name: 'Demo', roots: [{ id: 'website', title: 'website', kind: 'project', tier: 'project', state: 'live',
  children: [{ id: 'developer', tier: 'sol', state: 'live', children: [] }] }], tiers: { sol: 1 }, asks: [], epoch: 1, rev: 1 } as unknown as TreePayload
localStorage.removeItem('orgtree.docket.group')
localStorage.removeItem('orgtree.docket.sort')
globalThis.fetch = compatibilityWorkFixture((async url => {
  const path = String(url)
  if (path.includes('/work-items/')) return new Response(JSON.stringify({ item: items.find(it => path.endsWith('/' + it.slug)) }))
  if (path.includes('/work-items')) return new Response(JSON.stringify({ items, archived: [], backlogged: [], counts: { active: items.length, archived: 0, backlogged: 0 } }))
  return new Response(JSON.stringify({}))
}) as typeof fetch)
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="demo">
  <AgentDocketModal slug="demo" nid="website" tree={tree} toast={noop} close={noop}
    refs={{ world: { org: 'demo' }, onOpen: noop }} />
</CurrentOrg.Provider>)
