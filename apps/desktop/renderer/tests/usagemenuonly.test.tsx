// usagemenuonly.test.tsx — in a v3 organization window, Usage opens ONLY from
// the Orgtree menu (user 2026-09-28, item usage-window-open-it-only-from-the-
// orgtree-menu).
//
// Usage covers the whole app, not one organization, so the org header no
// longer carries a Usage button. The Orgtree menu's "Usage…" is the one way
// in, with no near-limit warning anywhere ("we can do without the warning").
//
// ⚠ THE NEGATIVE NEEDS THE POSITIVE. "No Usage button in the header" would
// also pass against a window whose header never rendered, or that was not a
// v3 window at all. So the header's other actions are asserted first, and the
// menu entry is proven to open the real Usage panel.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs usagemenuonly

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { forgetModalOpenCache, forgetModalPins } from '../src/canvas/modalpin'
import App from '../src/App'
import { installBridge, removeBridge } from './shellbridge'

const agent = (id: string) => ({ id, title: id, tier: 'haiku', model_id: 'haiku',
  state: 'live', seat: 1, grant: 0, free: 0, mail_pending: 0, documents: [],
  children: [], lineage: [], turns: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } })
const tree = (slug: string) => ({ slug, name: slug, workspace: null, dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', prefer_reserve_default: false,
  credit_requests: [], tiers: { haiku: 1 }, audiences: [], roots: [agent('a1')],
  cost_usd_total: 0, audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null, spend_frozen: false,
  storage_blocked: false, auto_resume: false, fable_limit_policy: 'freeze',
  fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true, sandboxed: false,
  audience_requests: [], org_inbox: null, net: null, public: false, epoch: 1, rev: 1,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0, watchdogs: [] })

async function v3OrgWindow(t: TestContext) {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  window.history.replaceState(null, '', '/o/alpha')
  installBridge({
    requestOrg: async () => ({ outcome: 'focused' }),
    windowIdentity: { windowId: 'w-alpha', kind: 'org', org: 'alpha', duties: true },
  })
  const g = globalThis as unknown as Record<string, unknown>
  const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(body) })
  const stub = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0]!
    if (path === '/api/orgs') return json([{ slug: 'alpha', name: 'alpha', live: 1, seats: 1 }])
    if (path === '/api/orgs/alpha') return json(tree('alpha'))
    if (path === '/api/providers') return json({ providers: [] })
    if (path.endsWith('/work-items')) return json({ items: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 }, now: '2026-09-28T00:00:00Z' })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/inbox')) return json({ pending: [], delivered: [], sent: [] })
    return json({})
  }) as unknown as typeof fetch
  g.fetch = stub; (window as unknown as Record<string, unknown>).fetch = stub
  g.history ??= window.history
  g.location ??= window.location
  const view = await mountView(<App />, (el) => el)
  t.after(async () => {
    await view.unmount(); delete g.fetch; removeBridge()
    forgetModalPins(); forgetModalOpenCache()
    window.history.replaceState(null, '', '/')
  })
  await inAct(async () => { await flush(10) })
  return view
}

const label = (b: Element) => (b.getAttribute('aria-label') || b.getAttribute('title')
  || b.textContent || '').trim()
const headerActions = () =>
  [...document.querySelectorAll('.shell-header-actions button')].map(label)

test('a v3 org header has no Usage button; the Orgtree menu opens Usage', async (t) => {
  await v3OrgWindow(t)
  // POSITIVE CONTROL: this is the v3 shell, with its org header drawn
  const actions = headerActions()
  assert.ok(actions.some((l) => /^org settings/i.test(l)),
    `the v3 org header rendered its actions — have ${JSON.stringify(actions)}`)
  assert.ok(actions.some((l) => /^presentations|presented documents/i.test(l)),
    `and Presentations is still there — have ${JSON.stringify(actions)}`)
  // THE CHANGE: nothing in the org header opens Usage
  assert.ok(!actions.some((l) => /usage/i.test(l)),
    `no Usage entry in the org header — have ${JSON.stringify(actions)}`)
  assert.equal(document.querySelector('.shell-header-actions .u-warn, .shell-header-actions .u-crit'),
    null, 'and no near-limit warning in the header')
  assert.equal(document.querySelector('.usage-modal'), null, 'Usage is not open yet')

  // the Orgtree menu is the one way in
  const menuButton = document.querySelector('.shell-menu-button') as HTMLButtonElement | null
  assert.ok(menuButton, 'the Orgtree menu button is drawn in the org window')
  await inAct(async () => { menuButton!.click(); await flush(3) })
  const usage = [...document.querySelectorAll('.shell-menu-panel [role="menuitem"]')]
    .find((b) => /^Usage/.test((b.textContent ?? '').trim())) as HTMLButtonElement | undefined
  assert.ok(usage, 'the Orgtree menu carries "Usage…"')
  await inAct(async () => { usage!.click(); await flush(10) })
  assert.ok(document.querySelector('.usage-modal'), 'the menu entry opens the Usage panel')
})
