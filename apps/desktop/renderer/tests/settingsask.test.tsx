// The canvas answers a desk's "Turn off in settings" for an agent's gear
// (docket cheap-compact-warning-turn-off-in-settings-link-o).
//
// A desk asks by window event, 'orgtree:open-settings-at' (the way the
// turn-slot banner asks for app settings), so it needs no route handed down to
// it and works the same docked or popped out. OrgCanvas owns the gear panel
// (`node-config`): on an ask of scope 'agent' for ITS organization it opens
// that agent's gear (never closing one already open: opening is not
// toggling), on the tab the ask names, and the panel lands on the row.
//
//   §1 an agent ask opens the gear at the Model tab, the row marked and focused
//   §2 a second ask while the gear is open keeps it open and lands again
//   §3 an ask for another organization, or for the org's settings, opens nothing here
//
// The org-settings half is answered by App.tsx (tests/settingstarget.test.tsx
// covers the panel; the real App is driven in the Electron capture).
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs settingsask

import { FakeServer, advance, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { resetConvos } from '../src/convo'
import type { OpRequest } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const EVENT = 'orgtree:open-settings-at'
const W = window as unknown as Window & typeof globalThis
const asTree = (v: unknown) => v as TreePayload

const tools = { bash: true, edit: true, web: false, subagents: false, mcp: [] }
const own = { permission_mode: 'default', add_dirs: [], tools, org_visibility: 'team',
  auto_cheap_compact: { enabled: true, occ: 0.4 } }
const agent = {
  id: 'ranger', title: 'ranger', tier: 'haiku', model_id: 'haiku', state: 'live',
  seat: 1, grant: 0, free: 0, ui_order: 0, cost_usd: 0, occupancy: null,
  context_window: null, charter: null, mail_pending: 0, limit_locked: false,
  last_status: null, prev_status: null, inflight_at: null, last_denials: [],
  turns: [], frozen: null, audiences_held: [], bearer_state: null,
  generation: 0, children: [], lineage: [],
  scope: own, configured_scope: own,
}
const tree = asTree({
  slug: 'mine', name: 'mine', workspace: null, dirs: [], max_top_grant: 1000,
  default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', credit_requests: [],
  tiers: { haiku: 1, sonnet: 3, opus: 5, fable: 10 }, audiences: [],
  roots: [agent], cost_usd_total: 0,
  audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
  auto_resume: false, fable_limit_policy: 'freeze', fable_filter_policy: 'halt',
  cascade_hire: false, cascade_alloc: true, audience_requests: [], org_inbox: null, net: null,
})

type Cap = { setPointerCapture?: unknown; releasePointerCapture?: unknown; hasPointerCapture?: unknown }
function stubPointerCapture(): () => void {
  const proto = (globalThis as unknown as { HTMLElement: { prototype: Cap } }).HTMLElement.prototype
  const had = { s: proto.setPointerCapture, r: proto.releasePointerCapture, h: proto.hasPointerCapture }
  proto.setPointerCapture = () => {}; proto.releasePointerCapture = () => {}; proto.hasPointerCapture = () => false
  return () => { proto.setPointerCapture = had.s; proto.releasePointerCapture = had.r; proto.hasPointerCapture = had.h }
}

async function mountCanvas(t: TestContext) {
  t.after(stubPointerCapture())
  resetConvos()
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  installFetch(new FakeServer())
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })
  useFakeClock()
  t.after(() => realClock())
  const v = await mountView(
    <OrgCanvas tree={tree} slug="mine" op={(_b: OpRequest) => Promise.resolve({})}
      toast={() => {}} mailEvt={null} onOpenAgentGallery={() => {}} />, (h) => h)
  t.after(() => v.unmount())
  await flush(); await advance(400, 50); await flush()
  return v
}

const ask = async (detail: unknown) => {
  await inAct(async () => { W.dispatchEvent(new W.CustomEvent(EVENT, { detail })); await flush(4); await advance(200, 50) })
}
const gear = () => document.body.querySelector<HTMLElement>('[role="tablist"][aria-label="Agent settings"]')
const tabOn = () => document.body.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent?.trim()
const marked = () => document.body.querySelectorAll('.set-target-hl').length
const target = { tab: 'model', field: 'cheap-compact' }

test('§1 an agent ask opens the gear at the Model tab, the row marked and focused', async (t) => {
  await mountCanvas(t)
  assert.equal(gear() === null, true, 'no gear yet')
  await ask({ scope: 'agent', org: 'mine', agentId: 'ranger', target })
  assert.equal(gear() !== null, true, 'the gear is open')
  assert.equal(tabOn(), 'Model')
  const row = document.body.querySelector<HTMLElement>('[data-settings-field="cheap-compact"]')
  assert.ok(row, 'the cheap-compact row is there')
  assert.equal(row!.classList.contains('set-target-hl'), true, 'marked')
  assert.equal(row!.ownerDocument.activeElement === row!.querySelector('select'), true, 'focused')
})

test('§2 a second ask keeps the gear open (opening is not toggling) and lands again', async (t) => {
  await mountCanvas(t)
  await ask({ scope: 'agent', org: 'mine', agentId: 'ranger', target })
  await advance(2200, 100)
  assert.equal(marked(), 0, 'the first mark has faded')
  await ask({ scope: 'agent', org: 'mine', agentId: 'ranger', target })
  assert.equal(gear() !== null, true, 'still open, not toggled shut')
  assert.equal(marked(), 1, 'marked again')
})

test('§3 an ask for another organization, or for the org settings, opens no gear here', async (t) => {
  await mountCanvas(t)
  await ask({ scope: 'agent', org: 'elsewhere', agentId: 'ranger', target })
  await ask({ scope: 'org', org: 'mine', target: { tab: 'policies', field: 'cheap-compact' } })
  assert.equal(gear() === null, true)
})
