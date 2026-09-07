// The REAL <DocketModal/>, mounted, for copyslug_probe.py. Shaped on
// docketoptions-fixture.tsx: same stubbed fetch, same CurrentOrg wrapper, same
// bundle-and-serve dance — so what the probe drives is the production
// component and the production stylesheet, not a hand-written row.
import { createRoot } from 'react-dom/client'
import { DocketModal } from '../src/canvas/docket'
import { CurrentOrg } from '../src/popout'
import type { TreePayload, WorkItem } from '../src/types'
import '../src/styles.css'

const tree = { slug: 'fixture', name: 'Fixture', roots: [], asks: [], epoch: 1, rev: 1 } as unknown as TreePayload

const item = (slug: string, extra: Partial<WorkItem> = {}) => ({
  slug, title: 'the descriptive title of ' + slug, kind: 'code', status: 'in_progress',
  archived: false, rev: 1, owner: null, participants: [], at: '2026-09-05T08:00:00Z',
  updated_at: '2026-09-06T08:00:00Z', docket_at: '2026-09-06T08:00:00Z',
  done_so_far: [], working_on_next: [], questions: [], dependencies: [], evidence: [],
  history: [], dismissals: [], acceptance: [], effective_attention: false,
  attention_sources: [], ...extra,
} as unknown as WorkItem)

// three shapes the probe needs: a plain row, a row with the DISMISS control
// (an embedded button), and a parent whose FOLD arrow is another one
const items = [
  item('copy-me-exactly'),
  item('flagged-row', { effective_attention: true, attention_sources: ['manual'] }),
  item('parent-row'),
  item('child-row', { parent: 'parent-row' } as Partial<WorkItem>),
]

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method && init.method !== 'GET') throw Error('Blocked fixture write')
  return new Response(JSON.stringify({ items, archived: [], backlogged: [] }),
    { headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch

createRoot(document.getElementById('root')!).render(
  <CurrentOrg.Provider value="fixture">
    <DocketModal slug="fixture" tree={tree} toast={() => {}} close={() => {}} />
  </CurrentOrg.Provider>,
)
