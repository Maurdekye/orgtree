// usagescope.test.tsx — the Usage panel is the same component everywhere, but
// the home screen and each organization are DIFFERENT PLACES to have it open.
//
// User 2026-09-12, with the exact sequence: pin Usage in an org, go home, and
// the org's pinned surface reappears there as an ordinary centred modal;
// close it there and the organization's pin is gone when you go back.
//
// WHY THAT HAPPENS. The persistence layer has always been keyed by
// `(kind, org)` — but the in-memory answer to "is Usage open" was a single
// `useState(false)` shared by home and every org, so navigating carried one
// scope's answer into another. Two orgs shared it too.
//
// WHAT IS DRIVEN HERE. The real <App />, with the real navigation: pick an
// org from the list, use the panel's own "pin this to the window" control,
// open the drawer and press "all organizations". Nothing reaches into state;
// the only direct calls are READS (`isModalPinned`) used as assertions.
//
// ⚠ THE NEGATIVE SECTIONS NEED THE POSITIVE ONES. §2 and §4 say a surface is
// NOT there, and both would pass just as well against a build where Usage
// never opened at all. §1 (it opens and pins in the org) and §3 (it opens and
// closes at home, on its own) are what make them mean anything.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs usagescope

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { forgetModalOpenCache, forgetModalPins, isModalPinned } from '../src/canvas/modalpin'
import App from '../src/App'

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

/** The whole app, on a stubbed server with two organizations. */
async function app(t: { after: (fn: () => void | Promise<void>) => void }) {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  // ⚠ the URL outlives the test. App reads `/o/<slug>` on mount, so a second
  // test would start INSIDE the org the first one navigated to and never see
  // the org list at all.
  window.history.replaceState(null, '', '/')
  const g = globalThis as unknown as Record<string, unknown>
  const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(body) })
  const stub = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0]!
    if (path === '/api/orgs') return json([{ slug: 'alpha', name: 'alpha', live: 1, seats: 1 },
      { slug: 'beta', name: 'beta', live: 1, seats: 1 }])
    if (path === '/api/orgs/alpha') return json(tree('alpha'))
    if (path === '/api/orgs/beta') return json(tree('beta'))
    if (path === '/api/providers') return json({ providers: [] })
    return json({})
  }) as unknown as typeof fetch
  g.fetch = stub; (window as unknown as Record<string, unknown>).fetch = stub
  // App navigates with the bare global `history`; jsdom puts it on `window`,
  // and in this bundle `globalThis` is not `window`.
  g.history ??= window.history
  g.location ??= window.location

  const view = await mountView(<App />, (el) => el)
  t.after(async () => { await view.unmount(); delete g.fetch; forgetModalPins(); forgetModalOpenCache() })
  const settle = () => inAct(async () => { await flush(10) })
  await settle()

  const label = (b: Element) => ((b.getAttribute('aria-label') || b.getAttribute('title')
    || b.textContent || '').trim())
  // ⚠ CASE-INSENSITIVE ON PURPOSE. These controls are found by their visible
  // label, and the app's copy gets re-cased from time to time (a sentence-case
  // sweep landed the same day this was written). A navigation test should fail
  // when the navigation breaks, not when a capital letter moves.
  const find = (text: string, root: ParentNode = view.el) =>
    [...root.querySelectorAll('button, a, [role="button"], .orgrow, li')]
      .find(b => label(b).toLowerCase().startsWith(text.toLowerCase())) as HTMLElement | undefined
  const press = async (text: string, what = text, root: ParentNode = view.el) => {
    const hit = find(text, root)
    assert.ok(hit, `the harness could not find "${what}" to press`)
    await inAct(() => { hit.click() })
    await settle()
  }
  /** Is the Usage panel drawn anywhere — centred at home, pinned in an org?
   *  ⚠ A BOOLEAN, NOT THE NODE. Handing a jsdom element to `assert.equal`
   *  makes node:assert walk it to build a diff, and its cyclic structure
   *  overflows the stack: the run dies with 0xC00000FD and no assertion
   *  message at all, which looks like a hang rather than a failure. */
  const usage = () => !!document.querySelector('.usage-modal')
  return {
    press,
    usage,
    enter: (org: string) => press(org, `the "${org}" row in the org list`, document),
    toggleUsage: () => press('usage', 'the header usage button', document),
    /** How a reader closes a CENTRED panel: press the backdrop it sits in.
     *  ⚠ Not the header button again - for an unpinned modal
     *  `modalToggleAction` always answers "open", so that button cannot
     *  close anything; and not the `modalpin-x`, which only a PINNED panel
     *  draws. */
    closeUsage: async () => {
      const panel = document.querySelector('.usage-modal')
      const backdrop = panel?.closest('.overlay') as HTMLElement | null
      assert.ok(backdrop, 'the usage panel is not in a backdrop that can dismiss it')
      await inAct(() => { backdrop.click() })
      await settle()
    },
    goHome: async () => {
      // the drawer is how an org reaches the org list; `button.home` lives in
      // the same panel the home screen renders
      const menu = document.querySelector<HTMLElement>('button.iconbtn')
      assert.ok(menu, 'the harness could not find the drawer control')
      await inAct(() => { menu.click() })
      await settle()
      const home = document.querySelector<HTMLElement>('button.home')
      assert.ok(home, 'the drawer did not offer "all organizations"')
      await inAct(() => { home.click() })
      await settle()
    },
  }
}

test('Usage is a separate surface at home and in each organization', async (t) => {
  const a = await app(t)

  // ── §1 in an organization it opens and pins (POSITIVE CONTROL) ───────────
  await a.enter('alpha')
  await a.toggleUsage()
  assert.ok(a.usage(), '§1 the usage panel must open inside an organization')
  await a.press('pin this to the window', "alpha's pin control", document)
  assert.ok(isModalPinned('usage', 'alpha'), '§1 the panel must really be pinned to alpha')
  assert.ok(a.usage(), '§1 and it stays up once pinned')

  // ── §2 at home that pin is NOT a home modal ─────────────────────────────
  await a.goHome()
  assert.ok(!isModalPinned('usage', null), 'home has no usage pin of its own')
  assert.ok(!a.usage(),
    "§2 an organization's pinned Usage must not follow the user home as a centred modal")

  // ── §3 home has its own open/closed, which works (POSITIVE CONTROL) ──────
  await a.toggleUsage()
  assert.ok(a.usage(), '§3 home must still be able to open Usage for itself')
  await a.closeUsage()
  assert.ok(!a.usage(), '§3 and to close it again')

  // ── §4 …and none of that touched the organization ───────────────────────
  await a.enter('alpha')
  assert.ok(isModalPinned('usage', 'alpha'), "alpha's pin itself must survive the trip")
  assert.ok(a.usage(),
    "§4 closing Usage at home must not close the organization's pinned Usage")
})

// ⚠ PINNED IN BOTH, DELIBERATELY. Only a PINNED surface's open state is
// durable - an unpinned centred modal is transient by design, and the org
// restore correctly reports it closed on the next visit. Asserting that an
// unpinned panel survives a round trip would be asserting something the
// product never promised, and it is how the first draft of this test failed.
test('two organizations each keep their own pinned Usage', async (t) => {
  const a = await app(t)

  await a.enter('alpha')
  await a.toggleUsage()
  await a.press('pin this to the window', "alpha's pin control", document)
  assert.ok(isModalPinned('usage', 'alpha'), 'POSITIVE CONTROL: alpha can pin Usage')
  assert.ok(a.usage(), 'and it is up in alpha')

  await a.goHome()
  await a.enter('beta')
  assert.ok(!isModalPinned('usage', 'beta'), "alpha's pin is not beta's")
  assert.ok(!a.usage(), "beta must start with its own answer, not alpha's")

  await a.toggleUsage()
  await a.press('pin this to the window', "beta's pin control", document)
  assert.ok(isModalPinned('usage', 'beta'), 'POSITIVE CONTROL: beta can pin Usage too')

  await a.goHome()
  assert.ok(!a.usage(), 'and neither pin shows at home')

  await a.enter('alpha')
  assert.ok(a.usage(), 'alpha must still be as it was left')
})
