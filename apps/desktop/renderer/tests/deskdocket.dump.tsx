// deskdocket.dump.tsx — the markup half of `deskdocket_layout_probe.py`.
//
// The real <AgentDocketView/> (the desk's fifth tab, user ruling 2026-09-05
// 21:07) inside the box the desk actually gives it, against the real
// styles.css. The tab REUSES the docket modal's rows and pane, so everything
// about a row is already measured by docket_layout_probe.py; what is NOT
// covered there is the only thing that differs — the panel is a narrow desk
// column instead of a wide modal, and it has to lay two panes out inside it
// without collapsing either or growing a third scrollbar.
//
//   node tests/deskdocket_dump.mjs <out.html>

import '../tests/harness'
import { writeFileSync } from 'node:fs'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { AgentDocketView } from '../src/canvas/docket'
import type { RefRoutes } from '../src/canvas/reflinks'
import type { RefKind } from '../src/canvas/workrefs'
import type { WorkItem } from '../src/types'

const mk = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'fixture-item', parent: null, rev: 1, kind: 'code', title: 'Item',
  objective: 'the thing is not shipped; ship it', status: 'in_progress',
  blocked_reason: null, archived: false, archived_at: null,
  owner: { node: 'codex-sandbox', generation: 3 }, owner_current: true,
  owner_state: 'live', reviewer: null, participants: [],
  created_by: { node: 'coordinator-astra', generation: 0 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: ['rebased onto main', 'the backend suite is green'],
  working_on_next: ['the frontend tests', 'the docs'],
  docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'codex-sandbox', generation: 3 },
  manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [],
  acceptance: [], dependencies: [], evidence: [], delivery: null,
  accepted: null, superseded_by: null, history: [],
  ...o,
} as unknown as WorkItem)

// REAL SLUGS AND REAL AGENT NAMES, at the lengths this org actually produces —
// a fixture of short names would fit any width and measure nothing.
const MINE: WorkItem[] = [
  mk({ slug: 'docket-assignment-and-one-step-staffing',
    title: 'Docket assignment and one-step staffing', status: 'in_progress' }),
  mk({ slug: 'working-status-nudges-every-twenty-minutes',
    title: 'Working-status nudges every twenty minutes', status: 'review',
    reviewer: { node: 'coordinator-astra', generation: 0 } }),
  // a REVIEW this agent holds without owning: the row still names the owner
  mk({ slug: 'clickable-docket-references-across-text-surfaces',
    title: 'Clickable docket references across text surfaces', status: 'review',
    owner: { node: 'codex-checklist', generation: 5 },
    reviewer: { node: 'codex-sandbox', generation: 3 } }),
  mk({ slug: 'antigravity-usage-limit-estimation',
    title: 'Antigravity usage-limit estimation', status: 'blocked',
    blocked_reason: 'no authoritative window' }),
  mk({ slug: 'mail-ack', title: 'Mail acknowledgement contract', status: 'open' }),
]

const FACTS = new Map([
  ['codex-sandbox', { tier: 'opus', generation: 3, live: true }],
  ['codex-checklist', { tier: 'opus', generation: 5, live: true }],
  ['coordinator-astra', { tier: 'fable', generation: 0, live: true }],
])

// ⚠ THE DESK'S REFERENCE WIRING, WHICH THE TAB NO LONGER BUILDS FOR ITSELF.
// Shaped like `deskRoutes` in desk.tsx — every kind routed, because the desk
// routes every kind — so the probe measures the page the product shows. The
// routes are no-ops on purpose: this dump measures GEOMETRY, and a chip's size
// does not depend on where its click goes.
const REFS: RefRoutes = {
  world: {
    org: 'orgtree',
    agents: new Map([...FACTS.keys()].map((id) => [id, id])),
    mail: () => 'ready',
    destination: 'codex-sandbox',
    tierOf: (id) => FACTS.get(id)?.tier ?? null,
    handles: new Set<RefKind>(['item', 'agent', 'doc', 'mail']),
  },
  onOpen: () => {},
}

const dest = process.argv[2]
if (!dest) {
  console.error('usage: node tests/deskdocket_dump.mjs <out.html> [empty]')
  process.exit(2)
}
// the SECOND page is the empty tab — the sentence an agent with no assigned
// work reads, which is a layout claim of its own (it must fill the panel's
// width rather than hug a corner of an empty box)
const empty = process.argv[3] === 'empty'

const host = document.createElement('div')
// the desk's own chain: the tab content sits in `.msgs-wrap`, which is the
// flex child that gives it its height. Reproduced here because the panel's
// height is exactly what the two-pane layout depends on.
host.className = 'msgs-wrap deskdocket-frame'
document.body.appendChild(host)
const root = createRoot(host)
flushSync(() => {
  root.render(
    // ⚠ `onFocusAgent` IS PASSED BECAUSE THE DESK ALWAYS PASSES IT — without
    // it the shared AgentName renders as plain text instead of a jump button,
    // and the probe would be measuring a page the product never shows.
    <AgentDocketView slug="orgtree" nid="codex-sandbox"
      mine={empty ? [] : MINE} facts={FACTS} toast={() => {}}
      onFocusAgent={() => {}} onChanged={() => {}} refs={REFS} />)
})

setTimeout(() => {
  if (!empty) {
    const rows = [...document.querySelectorAll('.mailrow.docket-row')]
    const target = rows.find((r) => r.querySelector('.l1 .mfrom')?.textContent
      === 'docket-assignment-and-one-step-staffing')
    if (!target) {
      console.error('no row to open — the dump would be measuring an empty pane')
      process.exit(3)
    }
    flushSync(() => { (target as HTMLElement).click() })
  }
  setTimeout(() => {
    writeFileSync(dest, host.outerHTML, 'utf8')
    console.log(`wrote ${dest} (${host.outerHTML.length} bytes)`)
    process.exit(0)
  }, 30)
}, 30)
