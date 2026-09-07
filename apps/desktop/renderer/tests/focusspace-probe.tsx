// focusspace-probe.tsx — the page `focusspace_probe.py` drives in a REAL
// browser. It renders the REAL <OrgCanvas> from ../src with the REAL
// styles.css, so every rectangle the probe reads is a genuine laid-out box
// from the engine, not a number this code wrote into an inline style.
//
// WHY THIS EXISTS ON TOP OF focusspace.test.tsx. That suite runs under jsdom,
// which does no layout: it can only read back the values the component writes
// (the `.space` transform, the eye's inline width). It therefore cannot see
// whether the switchboard's ACTUAL painted box fits inside the free region —
// and it cannot, because `focusView` floors the zoom at Z_DESK and the eye
// carries a USER_W minimum, either of which can make the rendered surface
// overflow a region whose aspect it nominally matches. Only a browser can
// answer that, and the review asked for exactly that answer.
//
// Nothing here asserts anything — the assertions live in the .py file. This
// file only has to be an honest host: the same component, the same stylesheet,
// no geometry of its own.

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { addPin, forgetPins, pinsKey } from '../src/canvas/pins'
import type { PinRect } from '../src/canvas/pins'
import type { TreePayload } from '../src/types'

const SLUG = 'probe'

function mk(id: string): unknown {
  return {
    id, title: id, tier: 'haiku', model_id: 'haiku', state: 'live',
    seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
    context_window: null, charter: null, mail_pending: 0, limit_locked: false,
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

const AGENTS = ['ceo', 'cto', 'qa', 'ops']

interface Probe {
  setPins: (rects: (PinRect & { id: string })[]) => void
  clearPins: () => void
  toasts: string[]
}

const toasts: string[] = []

function Fixture() {
  const [, bump] = useState(0)
  const probe: Probe = {
    setPins: (rects) => {
      forgetPins(SLUG)
      localStorage.removeItem(pinsKey(SLUG))
      for (const r of rects) addPin(SLUG, r.id, { x: r.x, y: r.y, w: r.w, h: r.h })
      bump((n) => n + 1)
    },
    clearPins: () => {
      forgetPins(SLUG)
      localStorage.removeItem(pinsKey(SLUG))
      bump((n) => n + 1)
    },
    toasts,
  }
  ;(window as unknown as { __probe: Probe }).__probe = probe
  useEffect(() => { forgetPins(SLUG); localStorage.removeItem(pinsKey(SLUG)) }, [])
  return (
    <OrgCanvas
      tree={tree(AGENTS)}
      op={() => Promise.resolve({} as never)}
      slug={SLUG}
      toast={(lines: string[]) => { toasts.push(lines.join(' ')) }}
      mailEvt={null}
    />
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
