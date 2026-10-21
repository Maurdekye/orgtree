// App settings pins and pops out like every other modal (docket
// app-settings-pinnable-and-pop-out-able-like-ever; USER 2026-10-20 12:26Z:
// "ive decided i want app settings to be pinnable and popoutable like every
// other modal", 12:53Z: "yes, put it in 19").
//
// App settings was the one surface PinFrame treated as global (scope null:
// no pin button, no pop-out button), on the ground that it belongs to the app
// rather than to an organization. It now follows Usage: the same component in
// every place, but home and each organization are DIFFERENT PLACES to have it
// open. In an organization it pins and pops out like any org surface, saved
// per organization; at home (no organization to pin into) it stays an ordinary
// centred modal, exactly as Usage does there.
//
//   §1 in an org it opens, pins, and offers the pop-out button; at home it has neither
//   §2 two organizations each keep their own pinned App settings; neither follows home
//   §3 a pinned App settings comes back when the window is loaded again
//   §4 the open-at-section ask (the turn-slot banner's "Open settings",
//      orgtree:open-app-settings) lands on the row: opens a closed panel, and
//      reveals a pinned one without toggling it shut
//   §5 the landing works in a panel that lives in another document (popped out)
//
// The real <App /> is driven here, through the real controls, as
// usagescope.test.tsx does for Usage.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs appsettingspin

import { JSDOM, flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { legacyAppBackend } from './appfeed-fixture'
import { forgetModalOpenCache, forgetModalPins, isModalPinned } from '../src/canvas/modalpin'
import { AccountsPanel } from '../src/canvas/accounts'
import { CurrentOrg } from '../src/popout'
import App from '../src/App'

declare const __SRC_DIR__: string
const W = window as unknown as Window & typeof globalThis
const g = globalThis as unknown as Record<string, unknown>
const HL = 'set-target-hl'
const MARK_MS = 2100

const agent = (id: string) => ({ id, title: id, tier: 'haiku', model_id: 'haiku',
  state: 'live', seat: 1, grant: 0, free: 0, mail_pending: 0, documents: [],
  children: [], lineage: [], turns: [], audiences_held: [],
  scope: { tools: {}, add_dirs: [], permission_mode: 'default', org_visibility: 'team' } })
const tree = (slug: string) => ({ slug, name: slug, workspace: null, dirs: [],
  max_top_grant: 1000, default_top_grant: 50, compact_at: 0, default_tools: null,
  default_visibility: 'team', default_effort: '', prefer_reserve_default: false,
  credit_requests: [], tiers: { haiku: 1 }, audiences: [], roots: [agent('a1')],
  cost_usd_total: 0, audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
  user_inbox_count: 0, user_inbox_newest: null, fable_lock: null,
  auto_resume: false, fable_limit_policy: 'freeze',
  fable_filter_policy: 'halt', cascade_hire: false, cascade_alloc: true,
  audience_requests: [], org_inbox: null, net: null, epoch: 1, rev: 1,
  work_items_summary: { attention: 0, active: 0 }, asks: [], asks_open: 0, watchdogs: [] })

const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(),
  json: () => Promise.resolve(body) })
const server = (async (input: RequestInfo | URL) => {
  const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0]!
  if (path === '/api/orgs') return json([{ slug: 'alpha', name: 'alpha', live: 1, seats: 1 },
    { slug: 'beta', name: 'beta', live: 1, seats: 1 }])
  if (path === '/api/orgs/alpha') return json(tree('alpha'))
  if (path === '/api/orgs/beta') return json(tree('beta'))
  if (path === '/api/providers') return json({ providers: [] })
  if (path === '/api/accounts') return json({ accounts: [] })
  if (path === '/api/app-settings/runtime') return json({ max_concurrent_turns: 16 })
  return json({})
}) as unknown as typeof fetch

type After = { after: (fn: () => void | Promise<void>) => void }
function install() {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  window.history.replaceState(null, '', '/')
  g.fetch = legacyAppBackend(server); (window as unknown as Record<string, unknown>).fetch = legacyAppBackend(server)
  g.history ??= window.history
  g.location ??= window.location
}

async function app(t: After, at = '/') {
  install()
  window.history.replaceState(null, '', at)
  const view = await mountView(<App />, (el) => el)
  t.after(async () => { await view.unmount(); delete g.fetch; forgetModalPins(); forgetModalOpenCache() })
  const settle = () => inAct(async () => { await flush(10) })
  await settle()
  const label = (b: Element) => ((b.getAttribute('aria-label') || b.getAttribute('title')
    || b.textContent || '').trim())
  const find = (text: string, root: ParentNode = view.el) =>
    [...root.querySelectorAll('button, a, [role="button"], .orgrow, li')]
      .find(b => label(b).toLowerCase().startsWith(text.toLowerCase())) as HTMLElement | undefined
  const press = async (text: string, what = text, root: ParentNode = view.el) => {
    const hit = find(text, root)
    assert.ok(hit, `the harness could not find "${what}" to press`)
    await inAct(() => { hit.click() })
    await settle()
  }
  const panel = () => !!document.querySelector('.acct-panel')
  const popout = () => document.querySelector('.acct-panel .popout-button') !== null
  const pinButton = () => document.querySelector('.acct-panel .modalpin-btn[aria-label="pin this to the window"]') !== null
  return {
    view, settle, press, panel, popout, pinButton,
    enter: async (org: string) => {
      // Organization identity hovers describe the action; the visible name
      // identifies the row. Do not mistake its title for its display label.
      const row = [...document.querySelectorAll<HTMLElement>('.org[role="button"]')]
        .find(el => el.querySelector('.org-name-text')?.textContent === org)
      assert.ok(row, `the harness could not find the "${org}" row in the org list`)
      assert.equal(row.title, `Open organization ${org} in a new window`)
      await inAct(() => { row.click() }); await settle()
    },
    // at home the sidebar's gear opens it; inside an organization the sidebar is not drawn and it is
    // reached from the Orgtree menu, the F1 shortcut, or the turn-slot banner's ask (the route used here)
    openSettings: async () => {
      if (find('app settings', document)) return press('app settings', 'the header App settings button', document)
      await inAct(async () => { W.dispatchEvent(new W.CustomEvent('orgtree:open-app-settings', { detail: {} })); await flush(6) })
      await settle()
    },
    closeSettings: async () => {
      const backdrop = document.querySelector('.acct-panel')?.closest('.overlay') as HTMLElement | null
      assert.ok(backdrop, 'the App settings panel is not in a backdrop that can dismiss it')
      await inAct(() => { backdrop.click() })
      await settle()
    },
    goHome: async () => {
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

test('§1 in an organization App settings opens, pins and offers the pop-out; at home it has neither', async (t) => {
  const a = await app(t)
  // home first: a centred modal with no window controls
  await a.openSettings()
  assert.equal(a.panel(), true, 'App settings opens at home')
  assert.equal(a.pinButton(), false, 'home has nothing to pin it into: no pin button')
  assert.equal(a.popout(), false, 'and no pop-out button')
  await a.closeSettings()
  assert.equal(a.panel(), false)

  await a.enter('alpha')
  await a.openSettings()
  assert.equal(a.panel(), true, 'it opens inside an organization')
  assert.equal(a.popout(), true, 'with the pop-out button every org modal has')
  assert.equal(a.pinButton(), true, 'and the pin button')
  await a.press('pin this to the window', "alpha's pin control", document)
  assert.equal(isModalPinned('app-settings', 'alpha'), true, 'it is really pinned to alpha')
  assert.equal(a.panel(), true, 'and stays up once pinned')
  assert.equal(document.querySelector('.acct-panel .modalpin-x') !== null, true, 'a pinned window has its own close')
})

test('§2 two organizations each keep their own pinned App settings; neither follows home', async (t) => {
  const a = await app(t)
  await a.enter('alpha')
  await a.openSettings()
  await a.press('pin this to the window', "alpha's pin control", document)
  assert.equal(isModalPinned('app-settings', 'alpha'), true, 'POSITIVE CONTROL: alpha can pin it')

  await a.goHome()
  assert.equal(isModalPinned('app-settings', null), false, 'home has no pin of its own')
  assert.equal(a.panel(), false, "an organization's pinned panel must not follow the user home")

  await a.enter('beta')
  assert.equal(isModalPinned('app-settings', 'beta'), false, "alpha's pin is not beta's")
  assert.equal(a.panel(), false, 'beta starts with its own answer')
  await a.openSettings()
  await a.press('pin this to the window', "beta's pin control", document)
  assert.equal(isModalPinned('app-settings', 'beta'), true, 'POSITIVE CONTROL: beta can pin it too')

  await a.goHome()
  await a.enter('alpha')
  assert.equal(a.panel(), true, 'alpha is as it was left')
})

test('§3 a pinned App settings comes back when the window is loaded again', async (t) => {
  const first = await app(t)
  await first.enter('alpha')
  await first.openSettings()
  await first.press('pin this to the window', "alpha's pin control", document)
  assert.equal(isModalPinned('app-settings', 'alpha'), true)
  await first.view.unmount()
  forgetModalOpenCache()
  window.history.replaceState(null, '', '/o/alpha')
  const again = await mountView(<App />, (el) => el)
  t.after(async () => { await again.unmount() })
  await inAct(async () => { await flush(12) })
  assert.equal(!!document.querySelector('.acct-panel'), true, 'App settings is open again, where it was pinned')
  assert.equal(isModalPinned('app-settings', 'alpha'), true)
})

// ----------------------------------------------------- the open-at-section ask

const ASK = 'orgtree:open-app-settings'
const ask = async (settle: () => Promise<void>, detail: unknown) => {
  await inAct(async () => { W.dispatchEvent(new W.CustomEvent(ASK, { detail })); await flush(6) })
  await settle()
}
const tabOn = () => document.querySelector<HTMLElement>('.acct-panel [role="tab"][aria-selected="true"]')?.textContent?.trim()
const marked = () => document.querySelectorAll('.acct-panel .' + HL).length
/** the row is looked for for a moment (it waits for the runtime settings fetch), so wait for it */
const until = async (ok: () => boolean, ms = 3000) => {
  for (let at = Date.now(); !ok() && Date.now() - at < ms;) await inAct(async () => { await flush(4); await new Promise(r => setTimeout(r, 25)) })
}
const row = () => document.querySelector<HTMLElement>('.acct-panel [data-settings-field="max_concurrent_turns"]')

test('§4 the open-at-section ask lands on the row: it opens a closed panel and reveals a pinned one without shutting it', async (t) => {
  const a = await app(t, '/o/alpha')
  // closed: the ask opens it at the section
  await ask(a.settle, { tab: 'runtime', focus: 'max_concurrent_turns' })
  assert.equal(a.panel(), true, 'a closed App settings is opened by the ask')
  await until(() => marked() > 0)
  assert.equal(tabOn(), 'Runtime', 'at the Runtime tab')
  assert.ok(row(), 'the turn-limit row is tagged data-settings-field="max_concurrent_turns"')
  assert.equal(row()!.classList.contains(HL), true, 'marked')
  assert.equal(row()!.ownerDocument.activeElement === row()!.querySelector('input'), true, 'and its input focused')

  // pinned and showing another tab: the ask must not toggle it shut
  await a.press('pin this to the window', "alpha's pin control", document)
  assert.equal(isModalPinned('app-settings', 'alpha'), true)
  const display = [...document.querySelectorAll<HTMLElement>('.acct-panel [role="tab"]')].find(b => /display/i.test(b.textContent ?? ''))!
  await inAct(async () => { display.click(); await flush(2) })
  assert.notEqual(tabOn(), 'Runtime')
  await new Promise(r => setTimeout(r, MARK_MS))
  await ask(a.settle, { tab: 'runtime', focus: 'max_concurrent_turns' })
  await until(() => marked() > 0)
  assert.equal(a.panel(), true, 'the pinned panel is still up: an ask opens, it never toggles')
  assert.equal(isModalPinned('app-settings', 'alpha'), true, 'and still pinned')
  assert.equal(tabOn(), 'Runtime', 'it went to the section')
  assert.equal(marked(), 1, 'and marked the row again')
})

// ----------------------------------------------------- another document

test('§5 a panel in a window of its own is landed in that window, not in the main one', async (t) => {
  install()
  const popup = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const host = popup.window.document.createElement('div')
  popup.window.document.body.appendChild(host)
  const view = await mountView(createPortal(
    <CurrentOrg.Provider value="alpha">
      <AccountsPanel toast={() => {}} close={() => {}}
        {...({ target: { tab: 'runtime', field: 'max_concurrent_turns', seq: 1 } } as Record<string, unknown>)} />
    </CurrentOrg.Provider>, host), (el) => el)
  t.after(async () => { await view.unmount(); popup.window.close(); delete g.fetch })
  await until(() => host.querySelector('.' + HL) !== null)
  const r = host.querySelector<HTMLElement>('[data-settings-field="max_concurrent_turns"]')
  assert.ok(r, 'the row is in the popped-out document')
  assert.equal(r!.classList.contains(HL), true, 'and marked there')
  assert.equal(popup.window.document.activeElement === r!.querySelector('input'), true, "focused in that window's own document")
  assert.equal(document.querySelector('.' + HL) === null, true, 'nothing in the main window is marked')
})
