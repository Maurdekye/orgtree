// docketname.dump.tsx — STEP 1 of the docket-name typography probe.
//
// Renders the REAL <DocketModal/> under the repo's jsdom harness, grouped by
// agent and with an item open, and writes its markup to a file. It asserts
// nothing about how any of it LOOKS, deliberately: jsdom has no CSS box model
// and no cascade, so "the heading kept its own font" is not a question it can
// answer — and an abstention reads exactly like a pass.
//
// Step 2 (`docketname_probe.py`) loads this markup plus the real `src/styles.css`
// into Edge and measures there. What this step guarantees is that what gets
// measured is the component's own output — classes, nesting and all — not a
// hand-written approximation that could drift from docket.tsx in silence.

import '../tests/harness'
import { writeFileSync } from 'node:fs'
import { createElement } from 'react'
import type { TreePayload, WorkItem } from '../src/types'

const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'unnamed-fixture-item', rev: 1, kind: 'code', title: 'Item',
  objective: '', status: 'in_progress', blocked_reason: null,
  archived: false, archived_at: null,
  owner: { node: 'checklist-evidence', generation: 2 }, owner_current: true,
  owner_state: 'live', participants: [],
  created_by: { node: 'checklist-evidence', generation: 2 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: [], working_on_next: [],
  docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'checklist-evidence', generation: 2 },
  manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [],
  acceptance: [], dependencies: [], evidence: [], delivery: null,
  accepted: null, superseded_by: null, history: [],
  ...o,
} as unknown as WorkItem)

const ITEMS: WorkItem[] = [
  mkItem({
    slug: 'canonize-the-model-chip',
    title: 'Canonize the model chip and the clickable agent name',
    // one agent mention and one item mention IN THE SAME SENTENCE, so the two
    // kinds of mention are measured against each other and against the prose
    objective: 'coordinator-astra asked for this; it follows on from '
      + 'explain-unavailable-actions, and tierless-agent has no model on '
      + 'record.',
    done_so_far: ['handed the switchboard tab to coordinator-astra'],
  }),
  mkItem({ slug: 'explain-unavailable-actions', title: 'Explain them' }),
  mkItem({ slug: 'nobody-owns-this', title: 'Ownerless',
    owner: null } as Partial<WorkItem>),
]

const TREE: TreePayload = {
  slug: 'org1', name: 'Org 1', epoch: 1, rev: 1,
  roots: [{
    id: 'coordinator-astra', tier: 'opus', generation: 1, state: 'live',
    children: [{
      id: 'checklist-evidence', tier: 'fable', generation: 2, state: 'live',
      children: [],
    }, {
      // live and reachable, model unknown: it links and wears no chip
      id: 'tierless-agent', generation: 1, state: 'live', children: [],
    }],
  }],
  work_items_summary: { attention: 0, active: ITEMS.length },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
} as unknown as TreePayload

;(globalThis as unknown as Record<string, unknown>).fetch = (url: string) => {
  const ok = (payload: unknown) => Promise.resolve({
    ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(payload),
  })
  if (String(url).includes('/work-items')) {
    return ok({
      items: ITEMS,
      counts: { attention: 0, active: ITEMS.length, archived: 0, backlogged: 0 },
      now: '2026-09-05T10:00:00.000Z',
    })
  }
  return ok({})
}

const main = async () => {
  // the grouping is a stored display preference — this is how the dump asks
  // for the by-agent heads without driving the control strip
  window.localStorage.setItem('orgtree.docket.group', 'agent')
  const { DocketModal } = await import('../src/canvas/docket')
  const { mountView, flush } = await import('../tests/harness')
  const { act } = await import('react')
  const view = await mountView(
    createElement(DocketModal, {
      slug: 'org1', toast: () => {}, close: () => {}, tree: TREE,
      onFocusAgent: () => {},
    }),
    (el: HTMLElement) => el.innerHTML,
  )
  await act(async () => { await flush(8) })
  // open the item whose description carries both kinds of mention
  const row = [...view.el.querySelectorAll<HTMLElement>('.mailrow.docket-row')]
    .find((r) => /canonize-the-model-chip/.test(r.textContent ?? ''))
  if (!row) throw new Error('the fixture item never rendered a row')
  await act(async () => { row.click() })
  await act(async () => { await flush(8) })
  const html = view.last()

  // ⚠ ONE ARTIFACT TO KNOW ABOUT BEFORE YOU READ A SCREENSHOT OF THIS: the
  // "Arrange" control will show "No group" even though the list IS grouped by
  // agent. React drives a <select> by the value PROPERTY, and innerHTML
  // serialises attributes — so no <option> comes out marked `selected`. The
  // grouping in the markup is real; the closed select is a dump artifact.

  // ⚠ FAIL LOUD IF THE MARKUP IS NOT THE THING UNDER TEST. Without this the
  // dump could be the "loading…" placeholder, or the panel could have stopped
  // drawing either surface, and the probe downstream would measure nothing and
  // report no failures.
  const want: [string, number][] = [
    ['docket-group-agent', 1],       // one owner group head
    ['docket-group-name', 1],
    ['docket-ref-agent', 2],         // description + the progress entry
    ['docket-actor-name', 2],        // the row actor and the pane actor
    ['docket-mention', 3],           // two known agents + the tierless one
    ['tier t-opus', 1],              // a mention's CURRENT-model chip
  ]
  for (const [cls, n] of want) {
    const got = (html.match(new RegExp(cls, 'g')) ?? []).length
    if (got < n) {
      throw new Error(`dump has ${got} × ${cls}, want at least ${n}. `
        + `First 400 chars:\n${html.slice(0, 400)}`)
    }
  }
  const dest = process.argv.slice(2).find((a) => !a.startsWith('--'))
  if (!dest) throw new Error('usage: docketname.dump <out.html>')
  writeFileSync(dest, html)
  console.log(`dumped ${html.length} bytes`)
}

await main()
// jsdom's window and the panel's poll timer hold the event loop open; this is
// a one-shot dump, so leave rather than wait for them
process.exit(0)
