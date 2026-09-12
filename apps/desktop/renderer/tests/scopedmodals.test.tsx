// scopedmodals.test.tsx — the Usage window's open/closed state used to be
// shared between the All organizations screen and an organization (fixed in
// c68e57b). The user asked whether Inbox, Docket, Presented Documents and
// Organization Settings have the same fault, and for only the confirmed ones
// to be fixed.
//
// SO THIS FILE IS A DIAGNOSIS BEFORE IT IS A GUARD. Each section states one
// of the two halves of the Usage fault and asks it of all four windows:
//
//   §1  does an organization's window follow the user HOME?
//   §2  does one organization's window open itself in ANOTHER organization?
//   §3  does a window survive a trip home and back, as it should?
//
// ⚠ READ WHAT THESE PROVE, NOT WHAT THEY ARE NAMED. A section that passes on
// the SHIPPED build is reporting that this window does not have that fault -
// which is a finding, and the reason the user asked for it to be tested
// rather than assumed. Only a section that fails is a defect to fix.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs scopedmodals

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
    // the four panels each fetch their own list; an empty one of the right
    // SHAPE is what lets them render at all (an object where a list is
    // expected is what made the first run throw "reading 'length'")
    // ⚠ SHAPE, NOT JUST EMPTINESS. InboxPanel reads `box?.pending.length`:
    // `pending` is NOT optional there, so any truthy answer without it -
    // `{}` or `[]` - throws before the panel can render at all.
    if (/inbox|mailbox|\/mail/.test(path)) {
      return json({ pending: [], delivered: [], history: [], messages: [], items: [], unread: 0 })
    }
    if (/\/(work|items|documents|asks|watchdogs|events|audiences)$/.test(path)) return json([])
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
    toggleUsage: () => press('usage limits', 'the header usage button', document),
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


/** The four windows the user named.
 *
 *  IDENTIFIED BY THEIR OWN TITLE, not by a class: `inbox` renders under
 *  `settings wide` and `org-settings` under plain `settings`, which several
 *  other panels also use, so a class query would happily report the wrong
 *  window as present.
 *
 *  The org-settings control is reached by its exact aria-label: there is a
 *  second, mobile-only row that also says "settings", and an App-level
 *  "App settings" button beside it - matching on text alone opens the wrong
 *  one, which is what the first draft of this file did.
 */
const WINDOWS = [
  { name: 'Inbox', press: 'your inbox', title: /Your inbox/i },
  { name: 'Docket', press: 'work docket', title: /Work docket/i },
  { name: 'Presented Documents', press: 'presented documents', title: /Presented documents/i },
  // by exact selector, not by label: see the note above
  { name: 'Organization Settings', sel: 'button.iconbtn[aria-label="Settings"]', title: /Org settings/i },
] as const

const shown = (title: RegExp) => [...document.querySelectorAll('.settings')]
  .some(el => title.test(el.textContent ?? ''))

for (const w of WINDOWS) {
  test(`${w.name}: an organization's window is its own`, async (t) => {
    const a = await app(t)
    const clickSel = async (sel: string, what: string) => {
      const el = document.querySelector(sel) as HTMLElement | null
      assert.ok(el, `the harness could not find ${what}`)
      await inAct(() => { el.click() })
      await inAct(async () => { await flush(10) })
    }
    const openIt = () => 'sel' in w
      ? clickSel(w.sel, `${w.name}'s control in alpha`)
      : a.press(w.press, `${w.name}'s control in alpha`, document)

    // ── open it in alpha and pin it, so its state is durable ─────────────
    await a.enter('alpha')
    await openIt()
    assert.ok(shown(w.title), `POSITIVE CONTROL: ${w.name} must open in an organization at all`)
    await a.press('pin this to the window', `${w.name}'s pin control`, document)
    assert.ok(shown(w.title), `${w.name} stays up once pinned`)

    // ── §1 it must not follow the user home ─────────────────────────────
    // This is the half that bit Usage. These four render inside App's
    // `{slug && …}` block, so the expectation is that they were never
    // exposed to it - but that is a claim about the code, and the user
    // asked for it to be TESTED rather than assumed.
    await a.goHome()
    assert.ok(!shown(w.title),
      `§1 ${w.name} pinned in an organization must not appear on the home screen`)

    // ── §3 …and it must survive the trip ────────────────────────────────
    await a.enter('alpha')
    assert.ok(shown(w.title),
      `§3 ${w.name} must still be open in alpha after a trip home`)

    // ── §2 …and it must not open itself in a DIFFERENT organization ─────
    await a.goHome()
    await a.enter('beta')
    assert.ok(!shown(w.title),
      `§2 ${w.name} open in alpha must not be open in beta, which has its own`)
  })
}
