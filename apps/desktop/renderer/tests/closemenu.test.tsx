// closemenu.test.tsx — EVERY "Close" A CONTEXT MENU OFFERS, ON THE REAL SURFACE.
//
// The user reported (2026-09-12) that Close in the presented-documents menu
// did nothing, and then asked for the obvious follow-up question to be
// answered rather than assumed: does Close work everywhere else it is
// offered? This file is that answer, kept.
//
// THERE ARE ONLY TWO KINDS OF Close IN THIS APP, and they mean different
// things:
//
//   A. THE PANEL'S Close — the entry on a surface's own title bar menu
//      (canvas/modalpin.tsx, PinFrameInner). One implementation shared by
//      every panel: docket, usage, the galleries, the inboxes, settings, the
//      agents list, the disk browser, connections, the readers. It dismisses
//      the WHOLE surface. Each panel's only contribution is the `close` prop
//      it passes, so the way to audit it is to drive real panels rather than
//      the frame on its own — and in all three display modes, because
//      centred, pinned and popped-out are three different teardowns.
//
//   B. A ROW'S Close — the entry on a list row that is currently the OPEN
//      one (mail rows, both document galleries' rows). It closes the READING
//      PANE for that row and must touch nothing else. This is the class the
//      reported defect belonged to: the label flipped to Close while the
//      action still just re-selected the row that was already selected.
//
// WHAT THE AUDIT FOUND. Of nine surfaces driven in three modes, plus all
// three row menus, exactly one thing was wrong, and it was cosmetic: a
// surface that is NOT pinnable offers Close and nothing else, and the menu
// drew a separator rule above that single item (§6). Everything else — the
// teardown, the pin record, the durable open marker, the popped-out window
// and its restore record, and the isolation between panels, between
// organizations and between an org and the home screen — was already right,
// and is pinned here so it stays that way.
//
// ⚠ THE NEGATIVES NEED THE POSITIVES. Half of these assertions say a panel
// is GONE, and every one of them would pass against a build where the panel
// never opened. Each section opens its surface and asserts it is there first;
// do not remove those lines as redundant.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs closemenu

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { forgetModalOpenCache, forgetModalPins, isModalPinned, readModalOpen } from '../src/canvas/modalpin'
import { savedWindows, WINDOW_LAYOUT_KEY } from '../src/windowlayout'
import { MailList } from '../src/canvas/mail'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { DocReader } from '../src/canvas/docs'
import { DiskBrowser } from '../src/DiskBrowser'
import { ConnectionsPanel } from '../src/canvas/connections'
import App from '../src/App'

const W = window as unknown as Window & typeof globalThis
const noop = () => {}
const menuEl = () => document.querySelector('.ctxmenu') as HTMLElement | null
const labels = () => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .map((b) => (b as HTMLButtonElement).textContent ?? '')
/** every child of the open menu IN ORDER, separators included — the only way
 *  to see a rule that has nothing above it (§6). `labels()` cannot: it reads
 *  menuitems and a separator is not one. */
const menuShape = () => [...(menuEl()?.children ?? [])]
  .map((c) => c.getAttribute('role') === 'separator' ? '—' : (c.textContent ?? ''))
const itemNamed = (label: string) => [...document.querySelectorAll('.ctxmenu [role="menuitem"]')]
  .find((b) => b.textContent === label) as HTMLButtonElement | undefined

async function rightClick(el: Element): Promise<boolean> {
  const ev = new W.MouseEvent('contextmenu',
    { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 30 })
  await inAct(() => { el.dispatchEvent(ev) })
  await flush(3)
  return ev.defaultPrevented
}
async function pick(label: string) {
  const b = itemNamed(label)
  assert.ok(b, `menu item "${label}" present — have ${JSON.stringify(labels())}`)
  await inAct(() => { b!.click() })
  await flush(3)
}

// ----------------------------------------------------------- the whole app
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

/** the real <App />, on a stubbed server with one organization — the same
 *  shape usagescope.test.tsx drives, because these panels are only reachable
 *  through the header they hang off. */
async function app(t: TestContext) {
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  // ⚠ the URL outlives the test: App reads `/o/<slug>` on mount, so without
  // this a later test starts inside the org an earlier one navigated to.
  window.history.replaceState(null, '', '/')
  const g = globalThis as unknown as Record<string, unknown>
  const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(body) })
  const stub = (async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '').split('?')[0]!
    if (path === '/api/orgs') return json([{ slug: 'alpha', name: 'alpha', live: 1, seats: 1 }])
    if (path === '/api/orgs/alpha') return json(tree('alpha'))
    if (path === '/api/providers') return json({ providers: [] })
    if (path.endsWith('/work-items')) return json({ items: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 }, now: '2026-09-12T00:00:00Z' })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/inbox')) return json({ pending: [], delivered: [], sent: [] })
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
  const text = (b: Element) => ((b.getAttribute('aria-label') || b.getAttribute('title')
    || b.textContent || '').trim())
  // case-insensitive by label, like usagescope.test.tsx: a re-casing sweep of
  // the app's copy must not read as a broken menu
  const press = async (what: string) => {
    const hit = [...document.querySelectorAll('button, a, [role="button"], .orgrow, li')]
      .find((b) => text(b).toLowerCase().startsWith(what.toLowerCase())) as HTMLElement | undefined
    assert.ok(hit, `the harness could not find "${what}" to press`)
    await inAct(() => { hit.click() })
    await settle()
  }
  return { view, settle, press, enter: (org: string) => press(org) }
}

/** a panel by the classes its own `panel` prop carries, and its title bar */
const panelBy = (sel: string) => document.querySelector(sel) as HTMLElement | null
const barOf = (sel: string) => {
  const bar = panelBy(sel)?.querySelector('.modalpin-bar') as HTMLElement | undefined
  assert.ok(bar, `the surface ${sel} draws no title bar to right-click`)
  return bar!
}

/** the six surfaces the org header can open, by the control that opens them
 *  and the class their panel carries */
const ORG_SURFACES = [
  { name: 'Work docket', kind: 'docket', open: 'work docket', sel: '.docket-modal' },
  { name: 'Usage limits', kind: 'usage', open: 'usage limits', sel: '.usage-modal' },
  { name: 'Presented documents', kind: 'gallery', open: 'presented documents', sel: '.gallery-modal' },
  { name: 'Your inbox', kind: 'inbox', open: 'your inbox', sel: '.settings.wide' },
  { name: 'Org settings', kind: 'org-settings', open: 'Settings', sel: '.settings' },
  { name: 'Agents list', kind: 'agent-list', open: 'every agent', sel: '.tray-panel' },
]

// ------------------------------------------------------ A. the panel's Close

test('§1 every header panel closes from its own title-bar menu (centred)', async (t) => {
  const a = await app(t)
  await a.enter('alpha')
  for (const s of ORG_SURFACES) {
    await a.press(s.open)
    assert.ok(panelBy(s.sel), `POSITIVE CONTROL: ${s.name} opened`)
    assert.equal(await rightClick(barOf(s.sel)), true,
      `${s.name}: the title bar takes the right-click rather than leaving the browser's menu`)
    assert.deepEqual(labels(), ['Open in new window', 'Pin to window', 'Close'], s.name)
    await pick('Close')
    assert.equal(panelBy(s.sel), null, `${s.name}: Close closed it`)
  }
})

test('§2 …and while PINNED: it closes, keeps its placement, drops its open '
  + 'marker, and opens again', async (t) => {
  const a = await app(t)
  await a.enter('alpha')
  for (const s of ORG_SURFACES) {
    await a.press(s.open)
    assert.ok(panelBy(s.sel), `POSITIVE CONTROL: ${s.name} opened`)
    const pinBtn = [...panelBy(s.sel)!.querySelectorAll('button')]
      .find((b) => (b.getAttribute('aria-label') ?? '').startsWith('pin this')) as HTMLElement | undefined
    assert.ok(pinBtn, `${s.name}: has its own pin control`)
    await inAct(() => { pinBtn!.click() }); await a.settle()
    assert.ok(isModalPinned(s.kind, 'alpha'), `POSITIVE CONTROL: ${s.name} really pinned`)

    await rightClick(barOf(s.sel))
    assert.deepEqual(labels(), ['Open in new window', 'Unpin', 'Close'],
      `${s.name}: pinned, the menu says Unpin rather than Pin`)
    await pick('Close')
    assert.equal(panelBy(s.sel), null, `${s.name}: Close closed the pinned window`)
    // ⚠ THE PIN SURVIVES ON PURPOSE. Close dismisses the window; it does not
    // throw away where the user put it. Unpin is the control that does that.
    assert.ok(isModalPinned(s.kind, 'alpha'), `${s.name}: its placement survived the close`)
    assert.ok(!readModalOpen('alpha').some((r) => r.kind === s.kind),
      `${s.name}: but the durable OPEN marker is gone, so a restart does not reopen it`)

    await a.press(s.open)
    assert.ok(panelBy(s.sel), `${s.name}: and the header control opens it again`)
    await rightClick(barOf(s.sel))
    await pick('Close')
  }
})

test('§3 closing one panel leaves every other open panel alone', async (t) => {
  const a = await app(t)
  await a.enter('alpha')
  await a.press('work docket')
  await a.press('usage limits')
  await a.press('presented documents')
  const up = () => [!!panelBy('.docket-modal'), !!panelBy('.usage-modal'), !!panelBy('.gallery-modal')]
  assert.deepEqual(up(), [true, true, true], 'POSITIVE CONTROL: all three are open')
  await rightClick(barOf('.usage-modal'))
  await pick('Close')
  assert.deepEqual(up(), [true, false, true],
    'only the panel whose menu was used closed')
})

test('§4 a POPPED-OUT panel: Close closes its native window and clears the '
  + 'restore record, leaving nothing stranded in the main window', async (t) => {
  const { OrgCanvas } = await import('../src/canvas/OrgCanvas')
  const { CurrentOrg } = await import('../src/popout')
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  localStorage.removeItem(WINDOW_LAYOUT_KEY)
  // the saved-window layer is desktop-only; without this stub nothing is
  // recorded and the record assertions below would pass vacuously
  Object.defineProperty(window, 'orgtreeDesktop', { value: {}, configurable: true })
  // a REAL second document to be the popped-out window, the way
  // agentstray.test.tsx §12 drives the same surface
  const child = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const childWindow = child.window as unknown as Window
  childWindow.focus = noop
  ;(childWindow as unknown as Record<string, unknown>).requestAnimationFrame = () => 1
  ;(childWindow as unknown as Record<string, unknown>).cancelAnimationFrame = noop
  let closeCalls = 0
  const realClose = childWindow.close.bind(childWindow)
  ;(childWindow as unknown as Record<string, unknown>).close = () => {
    closeCalls += 1; try { realClose() } catch { /* jsdom tears the document down */ } }
  const originalOpen = window.open
  const originalObserver = globalThis.MutationObserver
  window.open = (() => childWindow) as typeof window.open
  globalThis.MutationObserver = child.window.MutationObserver
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = (async () => ({ ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve({}) })) as unknown as typeof fetch
  let view: { el: HTMLElement; unmount: () => Promise<void> } | null = null
  try {
    view = await mountView(<CurrentOrg.Provider value="mine">
      <OrgCanvas tree={{ ...tree('mine'), roots: [agent('ceo')] } as never}
        op={() => Promise.resolve({} as never)} slug="mine" toast={noop} mailEvt={null} />
    </CurrentOrg.Provider>, (h) => h)
    await flush(5)
    await inAct(() => { view!.el.querySelector<HTMLButtonElement>('.tray-toggle')!.click() })
    await flush(3)
    const popout = view.el.querySelector<HTMLButtonElement>('.tray-panel [aria-label="Open in new window"]')
    assert.ok(popout, 'POSITIVE CONTROL: the list offers the popout action')
    await inAct(() => { popout!.click() }); await flush(10)
    const childPanel = child.window.document.querySelector('.tray-panel') as HTMLElement | null
    assert.ok(childPanel, 'POSITIVE CONTROL: the list really moved into the child window')
    assert.equal(savedWindows().find((r) => r.kind === 'agent-list')?.open, true,
      'POSITIVE CONTROL: and the restore record says it is open')

    // the menu opens in the CHILD document — that is where the surface lives
    const bar = childPanel!.querySelector('.modalpin-bar') as HTMLElement
    assert.ok(bar, 'the detached panel still draws its title bar')
    const ev = new (child.window as unknown as { MouseEvent: typeof MouseEvent })
      .MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 10 })
    await inAct(() => { bar.dispatchEvent(ev) }); await flush(3)
    const items = [...child.window.document.querySelectorAll('.ctxmenu [role="menuitem"]')] as HTMLElement[]
    assert.deepEqual(items.map((b) => b.textContent),
      ['Return to main window', 'Pin to window', 'Close'],
      'popped out, the menu offers the way back and the close')
    const closeItem = items.find((b) => b.textContent === 'Close')!
    await inAct(() => { closeItem.click() }); await flush(10)

    assert.equal(closeCalls, 1, 'the native window was actually closed, not just emptied')
    assert.equal(view.el.querySelector('.tray-panel'), null,
      'and nothing came back to the main window instead')
    assert.equal(document.querySelector('.popout-notices')?.textContent ?? '', '',
      'no "it is in another window" notice is left pointing at a window that is gone')
    assert.equal(document.querySelector('.movable-anchor'), null,
      'and the surface itself is unmounted, not left as an empty anchor')
    assert.equal(savedWindows().find((r) => r.kind === 'agent-list')?.open, false,
      'the restore record is closed, so the next launch does not reopen it')
  } finally {
    window.open = originalOpen
    globalThis.MutationObserver = originalObserver
    await view?.unmount()
    delete g.fetch
    delete (globalThis as unknown as Record<string, unknown>).orgtreeDesktop
    delete (window as unknown as Record<string, unknown>).orgtreeDesktop
    localStorage.removeItem(WINDOW_LAYOUT_KEY)
    forgetModalPins(); forgetModalOpenCache()
  }
})

test('§5 Close belongs to ONE scope: closing Usage at home leaves the '
  + "organization's pinned Usage exactly as it was", async (t) => {
  const a = await app(t)
  await a.enter('alpha')
  await a.press('usage limits')
  const pinBtn = [...panelBy('.usage-modal')!.querySelectorAll('button')]
    .find((b) => (b.getAttribute('aria-label') ?? '').startsWith('pin this')) as HTMLElement
  await inAct(() => { pinBtn.click() }); await a.settle()
  assert.ok(isModalPinned('usage', 'alpha'), 'POSITIVE CONTROL: alpha pinned Usage')

  // home, through the drawer — the same route a user takes
  await inAct(() => { document.querySelector<HTMLElement>('button.iconbtn')!.click() }); await a.settle()
  await inAct(() => { document.querySelector<HTMLElement>('button.home')!.click() }); await a.settle()
  await a.press('usage limits')
  assert.ok(panelBy('.usage-modal'), 'POSITIVE CONTROL: home opens its own Usage')
  await rightClick(barOf('.usage-modal'))
  await pick('Close')

  assert.equal(panelBy('.usage-modal'), null, 'home closed its own Usage')
  assert.ok(isModalPinned('usage', 'alpha'), "alpha's pin is untouched")
  assert.ok(readModalOpen('alpha').some((r) => r.kind === 'usage'),
    "and so is alpha's own open marker")
  await a.enter('alpha')
  assert.ok(panelBy('.usage-modal'), 'back in alpha, its Usage is still where it was left')
})

test('§6 a surface that cannot be pinned offers Close ALONE — with no '
  + 'separator rule above it', async (t) => {
  const a = await app(t)
  // at home there is no org to pin to, so Usage is the non-pinnable case
  await a.press('usage limits')
  assert.ok(panelBy('.usage-modal'), 'POSITIVE CONTROL: Usage opens at home')
  await rightClick(barOf('.usage-modal'))
  assert.deepEqual(labels(), ['Close'], 'no pin and no popout without an org')
  // ⚠ THE WHOLE POINT OF THIS SECTION. The builder used to push its
  // separator unconditionally, so this menu opened with a rule across the top
  // and nothing above it.
  assert.deepEqual(menuShape(), ['Close'],
    'the menu is the one item, with no leading separator')
  await pick('Close')
  assert.equal(panelBy('.usage-modal'), null, 'and it still closes')
})

test('§7 the same Close on two panels reached outside the header, and on a '
  + 'reader that has not loaded yet', async (t) => {
  const g = globalThis as unknown as Record<string, unknown>
  const had = g.fetch
  // a fetch that never settles: the doc reader stays in its loading frame,
  // which is the third non-pinnable surface and is the one a user meets by
  // accident rather than by choice
  g.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  t.after(() => { g.fetch = had })

  let diskClosed = 0
  const disk = await mountView(<DiskBrowser slug="org" isPublic={false} toast={noop}
    close={() => { diskClosed += 1 }} />, (h) => h)
  await flush(3)
  assert.ok(panelBy('.disk-browser'), 'POSITIVE CONTROL: the disk browser is up')
  await rightClick(barOf('.disk-browser'))
  assert.ok(labels().includes('Close'), 'the disk browser offers Close')
  await pick('Close')
  assert.equal(diskClosed, 1, 'the disk browser ran its own close')
  await disk.unmount()

  let connClosed = 0
  const conn = await mountView(<ConnectionsPanel tree={tree('org') as never} toast={noop}
    close={() => { connClosed += 1 }} />, (h) => h)
  await flush(3)
  const connPanel = [...document.querySelectorAll('.settings.wide')]
    .find((p) => (p.textContent ?? '').includes('Connections')) as HTMLElement
  assert.ok(connPanel, 'POSITIVE CONTROL: connections is up')
  await rightClick(connPanel.querySelector('.modalpin-bar') as HTMLElement)
  await pick('Close')
  assert.equal(connClosed, 1, 'connections ran its own close')
  await conn.unmount()

  let readerClosed = 0
  const reader = await mountView(<DocReader slug="org" docId="d1" toast={noop}
    close={() => { readerClosed += 1 }} />, (h) => h)
  await flush(3)
  const loading = [...document.querySelectorAll('.gallery-modal')]
    .find((p) => (p.textContent ?? '').toLowerCase().includes('loading')) as HTMLElement
  assert.ok(loading, 'POSITIVE CONTROL: the reader is in its loading frame')
  await rightClick(loading.querySelector('.modalpin-bar') as HTMLElement)
  assert.deepEqual(menuShape(), ['Close'],
    'the loading reader is not pinnable either: one item, no leading rule')
  await pick('Close')
  assert.equal(readerClosed, 1, 'and it closes the reader')
  await reader.unmount()
})

// -------------------------------------------------------- B. a row's Close

test('§8 a mail row: Close closes the OPEN message only', async (t) => {
  const ROW = (id: string) => ({ id, from: 'peer', to: 'me', at: '2026-09-05T09:00:00.000Z',
    kind: 'message', body: `body of ${id}`, read: true })
  const v = await mountView(
    <MailList org="org" delivered={[ROW('m1'), ROW('m2')] as never} />, (h) => h)
  t.after(() => v.unmount())
  const rows = () => [...v.el.querySelectorAll('.mailrow')] as HTMLElement[]
  assert.equal(rows().length, 2, 'POSITIVE CONTROL: both rows rendered')

  await rightClick(rows()[0]!)
  await pick('Open')
  assert.ok(rows()[0]!.classList.contains('on'), 'POSITIVE CONTROL: Open opened it')
  await rightClick(rows()[1]!)
  assert.equal(labels()[0], 'Open', 'the row that is not open still says Open')
  await rightClick(rows()[0]!)
  assert.equal(labels()[0], 'Close', 'the open row says Close')
  await pick('Close')
  assert.ok(!rows()[0]!.classList.contains('on'), 'Close closed the open message')
  assert.ok(!rows()[1]!.classList.contains('on'), 'and did not open the other one')
  assert.equal(rows().length, 2, 'both messages are still listed — Close is not a delete')
  assert.match(v.el.querySelector('.mailer-read')?.textContent ?? '', /select a mail to read it/,
    'the reading pane went back to its empty state')
})

test('§9 both document galleries: Close closes the OPEN document only', async (t) => {
  const had = (globalThis as { fetch?: typeof fetch }).fetch
  const docs = [
    { id: 'd1', node: 'me', title: 'One', at: '2026-09-07T10:00:00Z', evicted: false, node_state: 'live', tier: 'haiku' },
    { id: 'd2', node: 'me', title: 'Two', at: '2026-09-07T09:00:00Z', evicted: false, node_state: 'live', tier: 'haiku' },
  ]
  const calls: string[] = []
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push(method)
    const one = String(url).match(/\/documents\/([^/?]+)$/)
    const body = method !== 'GET' ? {}
      : one ? { ...docs.find((d) => d.id === one[1]!), body: 'a body' }
        : { documents: docs, total: docs.length }
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body) })
  }) as unknown as typeof fetch
  t.after(() => { (globalThis as { fetch?: typeof fetch }).fetch = had })

  // the org-wide gallery — the surface the user reported
  const org = await mountView(<DocGalleryModal slug="org" toast={noop} close={noop} />, (h) => h)
  await flush(6)
  const orgRows = () => [...org.el.querySelectorAll('.doc-gallery-row')] as HTMLElement[]
  assert.equal(orgRows().length, 2, 'POSITIVE CONTROL: the org gallery listed both')
  await rightClick(orgRows()[0]!)
  await pick('Open')
  assert.ok(orgRows()[0]!.classList.contains('on'), 'POSITIVE CONTROL: it opened')
  await rightClick(orgRows()[0]!)
  assert.equal(labels()[0], 'Close', 'the open row says Close')
  await pick('Close')
  assert.ok(!orgRows()[0]!.classList.contains('on'), 'and Close closes it')
  assert.ok(!orgRows()[1]!.classList.contains('on'), 'without opening the other')
  assert.equal(orgRows().length, 2, 'both documents still listed')
  await org.unmount()

  // and the agent-scoped one next to it
  const one = await mountView(
    <AgentGalleryView slug="org" nid="me" node={undefined} toast={noop} />, (h) => h)
  t.after(() => one.unmount())
  await flush(6)
  const rows = () => [...one.el.querySelectorAll('.doc-gallery-row')] as HTMLElement[]
  assert.equal(rows().length, 2, 'POSITIVE CONTROL: the agent gallery listed both')
  await rightClick(rows()[0]!)
  await pick('Open')
  assert.ok(rows()[0]!.classList.contains('on'), 'POSITIVE CONTROL: it opened')
  await rightClick(rows()[0]!)
  assert.equal(labels()[0], 'Close', 'the open row says Close')
  await pick('Close')
  assert.ok(!rows()[0]!.classList.contains('on'), 'and Close closes it')
  assert.ok(!rows()[1]!.classList.contains('on'), 'without opening the other')
  assert.equal(rows().length, 2, 'both documents still listed')
  assert.ok(!calls.includes('DELETE'), 'and no card was dismissed by any of it')
})
