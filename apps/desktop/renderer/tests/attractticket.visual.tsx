// attractticket.visual.tsx - capture fixture for attract mode opening a CHANGED ticket
// (@item:orgtree/attract-mode-only-canvas-interaction-interrupts-i, points i-l).
// The REAL <DocketModal/> on one long ticket, opened through its jump the way attract opens it. The
// window has an older text snapshot of the ticket (rev 3); the ticket now is rev 4 with a sentence added
// in the middle of the long DESCRIPTION and a new entry under EVIDENCE NOTES (NOTE: the Evidence notes section is open by default in the real pane, so the capture closes it before the first shot).
//   window.attractTicketVisual.theme('light' | 'charcoal' | 'obsidian-black' | 'solarized-light')
//   window.attractTicketVisual.show()      -> the change attract finds, driven on the open pane; resolves to its length (ms)
//   window.attractTicketVisual.change      -> the located change (field, offset, snippet)
//   window.attractTicketVisual.restore()   -> moving on: sections back, highlight off
// Browser-only data: no engine, bridge or live org; the clipboard is refused; writes are blocked.
import { createRoot } from 'react-dom/client'
import { DocketModal } from '../src/canvas/docket'
import { CurrentOrg } from '../src/popout'
import { applyTheme } from '../src/themes'
import { applyContrast } from '../src/contrast'
import { locateChange, recordTicketSnapshot, ticketSnapshot } from '../src/attract/ticketsnap'
import { showTicketChange } from '../src/attract/ticketdom'
import type { TicketShow } from '../src/attract/ticketdom'
import type { TreePayload, WorkItem } from '../src/types'
import { compatibilityWorkFixture } from './workcompat.fixture'
import '../src/styles.css'
import '../src/shell.css'

const refused = () => Promise.reject(new DOMException('clipboard disabled in this fixture', 'NotAllowedError'))
const owned = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
if (!owned || owned.configurable) Object.defineProperty(navigator, 'clipboard', { configurable: true,
  value: { readText: refused, writeText: refused, read: refused, write: refused } })

const tree = { slug: 'fixture', name: 'Fixture', roots: [], asks: [], epoch: 1, rev: 1 } as unknown as TreePayload
const para = (n: number) => `Paragraph ${n}: the problem statement, then what the solution needs to do, then the cases it must handle `
  + 'and the integration points it has to respect, written the way a senior developer would for a junior one.'
const OLD_OBJECTIVE = Array.from({ length: 14 }, (_, i) => para(i + 1)).join('\n\n')
const NEW_SENTENCE = 'ADDED LATER: the user asked for the start-after delay to go down to zero.'
const objective = OLD_OBJECTIVE.replace(para(9), para(9) + ' ' + NEW_SENTENCE)
const base = {
  slug: 'changed-ticket', title: 'Attract mode: a ticket that changed since it was last shown', kind: 'code', status: 'in_progress',
  archived: false, owner: null, participants: [], at: '2026-11-03T08:00:00Z', updated_at: '2026-11-03T11:00:00Z', docket_at: '2026-11-03T11:00:00Z',
  done_so_far: ['Wrote the red tests', 'Implemented the change', 'Ran the batch: green'], working_on_next: ['Post the integration job'],
  questions: [], dependencies: [], history: [], dismissals: [], acceptance: [], effective_attention: false, attention_sources: [],
}
const oldItem = { ...base, rev: 3, objective: OLD_OBJECTIVE, evidence: [{ note: 'first evidence', ref: 'r1', kind: 'note', at: '2026-11-03T08:30:00Z', by: 'a' }] }
const newItem = { ...base, rev: 4, objective,
  evidence: [...oldItem.evidence, { note: 'EVIDENCE ADDED AFTER YOU LAST SAW THIS', ref: 'r2', kind: 'note', at: '2026-11-03T10:30:00Z', by: 'a' }] }

// the docket reads through the paged route (useWorkItems -> getWorkPage); compatibilityWorkFixture answers it from the
// legacy full-list body below as one complete page, and the foreground/reference routes as compatibility, as the suites do
window.fetch = compatibilityWorkFixture((async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method && init.method !== 'GET') throw Error('Blocked fixture write')
  const u = String(input)
  if (u.includes('/work-items/changed-ticket')) return new Response(JSON.stringify({ item: newItem }), { headers: { 'Content-Type': 'application/json' } })
  return new Response(JSON.stringify({ items: [newItem], archived: [], backlogged: [] }), { headers: { 'Content-Type': 'application/json' } })
}) as typeof fetch)

// the window "last showed" rev 3
recordTicketSnapshot('fixture', oldItem as unknown as WorkItem)
let current: TicketShow | null = null
// the diff is taken NOW, before the docket mounts: the pane records the current text of what it shows on mount (and
// attract's own route diffs before it opens the docket, for the same reason)
const located = locateChange(ticketSnapshot('fixture', 'changed-ticket'), newItem as unknown as WorkItem, 0)
const api = {
  theme: (contrast: string, accent = 'claude') => { applyContrast(contrast); applyTheme(accent) },
  change: located as unknown,
  show: () => {
    current?.restore()
    current = showTicketChange(located)
    return current.length
  },
  restore: () => { current?.restore(); current = null },
}
;(window as unknown as { attractTicketVisual: unknown }).attractTicketVisual = api

createRoot(document.getElementById('root')!).render(
  <CurrentOrg.Provider value="fixture">
    <div style={{ width: 900, height: 640 }}>
      <DocketModal slug="fixture" tree={tree} toast={() => {}} close={() => {}} jumpTo="changed-ticket" jumpSeq={1} />
    </div>
  </CurrentOrg.Provider>,
)
