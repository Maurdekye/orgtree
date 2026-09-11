// placeholder-actions-probe.tsx — the page `placeholder-actions.probe.ts`
// drives in a REAL Electron window. It renders the REAL <OrgCanvas> from
// ../src with the REAL styles.css, so the pointer machinery under test —
// the viewport's `setPointerCapture`, the card's `startNodeDrag`, the
// desk's own propagation wall — is the application's, not this file's.
//
// WHY THE REAL CANVAS. The defect under test is that a click on the
// "…'s desk is open elsewhere." placeholder never reaches its buttons,
// because the viewport captures the pointer on pointerdown and Chromium
// then retargets the compatibility mouse events (including `click`) at the
// capturing element. Nothing about that is visible in jsdom, and nothing
// about it is visible in a hand-built viewport either: a fixture that wrote
// its own pan handler would only be testing the fixture.
//
// Nothing here asserts anything — the assertions live in the .probe.ts.
// This file only has to be an honest host: the same component tree, the
// same stylesheet, no pointer handling of its own.

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../apps/desktop/renderer/src/styles.css'
import { OrgCanvas } from '../apps/desktop/renderer/src/canvas/OrgCanvas'
import type { TreePayload } from '../apps/desktop/renderer/src/types'

const SLUG = 'probe'

function mk(id: string): unknown {
  return {
    id, title: id, tier: 'opus', model_id: 'opus', state: 'live',
    seat: 5, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: 'probe agent', mail_pending: 0, limit_locked: false,
    last_status: null, prev_status: null, inflight_at: null, last_denials: [],
    turns: [], frozen: null, audiences_held: [], bearer_state: null,
    generation: 0, children: [], lineage: [],
    scope: { permission_mode: 'default', add_dirs: [], tools: {}, org_visibility: 'team' },
  }
}

const tree = (ids: string[]): TreePayload => ({
  slug: SLUG, name: SLUG, workspace: null, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', credit_requests: [],
  tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
  roots: ids.map(mk), cost_usd_total: 0,
  audit: { live_nodes: ids.length, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
  spend_frozen: false, storage_blocked: false, auto_resume: false,
  fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
  cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null,
} as unknown as TreePayload)

const AGENTS = ['fix-coordinator-2']

function Fixture() {
  const [, bump] = useState(0)
  useEffect(() => {
    // Read-only helpers for the driver. Deliberately NO click helper: every
    // press in this probe is a real Chromium input event, because
    // `HTMLElement.click()` dispatches straight at the element and would
    // sail past the very retargeting the probe exists to detect.
    const q = (sel: string) => document.querySelector(sel)
    // WHERE A CLICK ACTUALLY LANDED. The defect under test is a RETARGETED
    // click: the press is delivered to the button, but the viewport has taken
    // pointer capture, so Chromium fires the compatibility `click` at the
    // capturing element instead. A capture-phase document listener sees the
    // event's real target and turns "the button did nothing" into "the click
    // was delivered somewhere else", which is a different claim.
    const clicks: string[] = []
    if (!(window as unknown as { __clickTap?: boolean }).__clickTap) {
      ;(window as unknown as { __clickTap?: boolean }).__clickTap = true
      document.addEventListener('click', (e) => {
        const t = e.target as Element | null
        clicks.push(t ? `${t.tagName.toLowerCase()}.${String(t.className).trim()}`.slice(0, 80) : 'null')
      }, true)
    }
    Object.assign(window as unknown as Record<string, unknown>, {
      probeBox: (sel: string) => {
        const el = q(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
      },
      // WHICH element a press at a point actually lands on, per the engine's
      // own hit testing — so a miss is reported as a miss rather than read as
      // a dead button.
      probeHit: (x: number, y: number) => {
        const el = document.elementFromPoint(x, y)
        return el ? `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 120) : null
      },
      probeCount: (sel: string) => document.querySelectorAll(sel).length,
      probeText: (sel: string) => (q(sel) as HTMLElement | null)?.textContent ?? null,
      probeButtons: (sel: string) => [...document.querySelectorAll(sel)].map(b => b.textContent),
      probeDraft: () => (q('.desk-over textarea, .desk-bare textarea') as HTMLTextAreaElement | null)?.value ?? null,
      probeBump: () => bump(n => n + 1),
      probeClicks: () => clicks.slice(),
      probeClearClicks: () => { clicks.length = 0 },
    })
  })
  return (
    <OrgCanvas
      tree={tree(AGENTS)}
      op={() => Promise.resolve({} as never)}
      slug={SLUG}
      toast={() => {}}
      mailEvt={null}
    />
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
