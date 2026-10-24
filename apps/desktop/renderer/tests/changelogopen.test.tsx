// changelogopen.test.tsx — where and when the Changelog opens (docket
// changelog-window-one-row-per-version-pinnable-po).
//
// §1 the app menu lists "Changelog…" directly below "Usage history…"
//    (USER 2026-10-24 22:13:55Z: "accessible via a new entry in the app menu
//    below usage history").
// §2 the first launch after an update opens it in the first window, on the
//    latest version ("opens automatically after an update on first launch";
//    22:15:56Z: "opens automatically to the latest version when opened (and
//    when opening automatically on launch after update)").
// §3 …unless the user turned that off (22:14:57Z: "an option to disable
//    automatically opening it"). The window still takes native's news.
// §4 any other launch (native has nothing to say: a fresh install, a later
//    window or launch) opens nothing. §2 is its positive control.
// §5 from the menu it opens on the latest version every time, whatever was
//    read before.
// §6 its header links to the setting: App settings opens on Display, at it.
//
// The whole App in an organization window, on a stubbed engine and a fake
// native bridge. Run:  node apps/desktop/renderer/tests/run.mjs changelogopen
import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import App from '../src/App'
import { OrgtreeMenu } from '../src/shell/menu'
import { forgetAttentionMode } from '../src/attention/mode'
import { forgetModalOpenCache, forgetModalPins } from '../src/canvas/modalpin'
import { legacyAppBackend } from './appfeed-fixture'
import { installBridge, removeBridge } from './shellbridge'

const RELEASES = [
  { version: '4.4.5', released_at: '2026-10-26T09:30:00Z', unpublished: false, notes: true },
  { version: '4.4.4', released_at: '2026-10-24T02:58:37Z', unpublished: false, notes: true },
  { version: '4.4.3', released_at: '2026-10-23T13:05:20Z', unpublished: false, notes: true },
]
const entry = (version: string) => ({ ...RELEASES.find((r) => r.version === version)!,
  notes_version: version, notes: `# Orgtree ${version}\n\nWhat changed in ${version}.\n` })

interface Launch { news: { from: string | null; to: string } | null; autoOpen?: boolean }

async function withApp(launch: Launch, run: (h: {
  el: HTMLElement; asked: () => number; reads: string[]; settle: () => Promise<void>
}) => Promise<void>) {
  useFakeClock()
  const hidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket, history: globals.history,
    CustomEvent: globals.CustomEvent, DocumentFragment: globals.DocumentFragment }
  const tree = { slug: 'notes-org', name: 'Notes org', roots: [], asks: [], asks_open: 0,
    epoch: 1, rev: 1, dirs: [], tiers: {}, max_top_grant: 1000, default_top_grant: 50,
    compact_at: 0, credit_requests: [], audience_requests: [], audiences: [], watchdogs: [],
    work_items_summary: { attention: 0, active: 0 },
    audit: { live_nodes: 0, top_level_holds: 0, no_overdraft: true, problems: [] },
    user_inbox_count: 0, org_inbox: null, net: null }
  const reads: string[] = []
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body),
    { status, headers: { 'Content-Type': 'application/json' } }))
  class Socket { readyState = 1; send() {} close() { this.readyState = 3 } }
  Object.assign(globals, { WebSocket: Socket, history: window.history, CustomEvent: window.CustomEvent,
    DocumentFragment: window.DocumentFragment })
  let asked = 0
  const identity = { windowId: 'notes-main', kind: 'org', org: tree.slug, notificationOwner: false }
  installBridge({ windowIdentity: identity, getWindowIdentity: async () => identity,
    requestOrg: async () => ({ action: 'focused', org: tree.slug }), getPreferences: async () => ({}),
    takeChangelogAfterUpdate: async () => { asked++; return asked === 1 ? launch.news : null } })
  globals.fetch = legacyAppBackend(async input => {
    const path = new URL(String(input), window.location.origin).pathname
    reads.push(path)
    if (path === '/api/changelog') return json({ running: '4.4.5', time_source: 'tagged', releases: RELEASES })
    const one = /^\/api\/changelog\/(.+)$/.exec(path)
    if (one) return json(entry(decodeURIComponent(one[1]!)))
    if (path.endsWith('/foreground-tree')) return json({ kind: 'compatibility' }, 409)
    if (path === '/api/orgs') return json([{ slug: tree.slug, name: tree.name, live: 0, seats: 0 }])
    if (path === '/api/orgs/' + tree.slug) return json(tree)
    if (path === '/api/providers') return json({ providers: [] })
    if (path === '/api/accounts') return json({ accounts: [] })
    if (path.endsWith('/inbox')) return json({ pending: [], delivered: [], sent: [] })
    if (path.endsWith('/documents')) return json({ documents: [], total: 0 })
    if (path.endsWith('/staffing-options')) return json({ tiers: [], at: Date.now(), stale: false,
      errors: [], loading: false, generation: 0 })
    if (/\/work-items(?:-view)?$/.test(path)) return json({ items: [], archived: [], backlogged: [],
      counts: { attention: 0, active: 0, archived: 0, backlogged: 0 } })
    if (path.endsWith('/usage/history')) return json({ series: [] })
    if (path.endsWith('/usage')) return json({ available: false, windows: [] })
    return json({})
  })
  localStorage.clear(); forgetAttentionMode(); forgetModalPins(); forgetModalOpenCache()
  if (launch.autoOpen === false) localStorage.setItem('orgtree-changelog-after-update', '0')
  window.history.replaceState(null, '', '/o/' + tree.slug)
  let view: Awaited<ReturnType<typeof mountView>> | undefined
  const settle = () => inAct(async () => { await flush(30) })
  try {
    view = await mountView(<App />, el => el)
    await inAct(() => flush(60))
    await run({ el: view.el, asked: () => asked, reads, settle })
  } finally {
    await view?.unmount(); removeBridge(); localStorage.clear()
    forgetAttentionMode(); forgetModalPins(); forgetModalOpenCache()
    Object.assign(globals, saved); window.history.replaceState(null, '', '/')
    if (hidden) Object.defineProperty(document, 'hidden', hidden)
    else delete (document as unknown as { hidden?: boolean }).hidden
    realClock()
  }
}

/** a boolean and a string, never a node: node:assert walks a jsdom node to diff it */
const panelOpen = () => !!document.querySelector('.changelog-modal')
const shownVersion = () => document.querySelector<HTMLElement>('.changelog-modal .changelog-row.on')?.dataset.version ?? null

async function openFromMenu(settle: () => Promise<void>) {
  const button = document.querySelector<HTMLButtonElement>('.shell-menu-button')
  assert.ok(button, 'the window has an app menu')
  await inAct(() => { button.click() })
  const item = [...document.querySelectorAll<HTMLButtonElement>('.shell-menu-item')]
    .find((b) => b.querySelector('.shell-menu-label')?.textContent === 'Changelog…')
  assert.ok(item, 'the app menu has a Changelog… entry')
  await inAct(() => { item.click() })
  await settle()
}

test('§1 the app menu lists "Changelog…" directly below "Usage history…" and opens it', async () => {
  let opened = 0
  const view = await mountView(<OrgtreeMenu orgs={[]} freshness="current" ageMs={0} error={null}
    currentOrg={null} onOpenOrg={() => {}} onNewWindow={() => {}} onCreateOrg={() => {}}
    onAppSettings={() => {}} onUsage={() => {}} onUsageHistory={() => {}}
    onChangelog={() => { opened++ }} />, el => el)
  try {
    await inAct(() => { view.el.querySelector<HTMLButtonElement>('.shell-menu-button')!.click() })
    const labels = [...view.el.querySelectorAll('.shell-menu-item .shell-menu-label')].map((e) => e.textContent ?? '')
    const at = labels.indexOf('Changelog…')
    assert.ok(at > 0 && labels[at - 1] === 'Usage history…', labels.join(' | '))
    await inAct(() => { view.el.querySelectorAll<HTMLButtonElement>('.shell-menu-item')[at]!.click() })
    assert.equal(opened, 1)
    assert.equal(view.el.querySelector('.shell-menu-panel'), null, 'the menu closes behind it')
  } finally { await view.unmount() }
})

test('§2 the first launch after an update opens the Changelog on the latest version', async () => {
  await withApp({ news: { from: '4.4.4', to: '4.4.5' } }, async ({ asked, reads, settle }) => {
    await settle()
    assert.equal(asked(), 1, 'the window asks native once')
    assert.ok(panelOpen(), 'the Changelog opened by itself')
    assert.equal(shownVersion(), '4.4.5', 'on the latest version')
    assert.match(document.querySelector('.changelog-modal .mailer-read')?.textContent ?? '', /What changed in 4\.4\.5/)
    assert.ok(reads.includes('/api/changelog/4.4.5'), reads.filter((r) => r.includes('changelog')).join(','))
  })
})

test('§3 turned off, it stays shut after an update, though the window takes the news', async () => {
  await withApp({ news: { from: '4.4.4', to: '4.4.5' }, autoOpen: false }, async ({ asked, settle }) => {
    await settle()
    assert.equal(asked(), 1, 'the news is taken, so a later launch is not told again')
    assert.ok(!panelOpen(), 'no Changelog')
    await openFromMenu(settle)
    assert.ok(panelOpen(), 'the menu still opens it')
  })
})

test('§4 a launch native has no news for opens nothing', async () => {
  await withApp({ news: null }, async ({ asked, settle }) => {
    await settle()
    assert.equal(asked(), 1)
    assert.ok(!panelOpen())
  })
})

test('§5 from the menu it opens on the latest version every time', async () => {
  await withApp({ news: null }, async ({ settle }) => {
    await openFromMenu(settle)
    assert.equal(shownVersion(), '4.4.5')
    const older = document.querySelector<HTMLElement>('.changelog-row[data-version="4.4.3"]')!
    await inAct(() => { older.click() })
    await settle()
    assert.equal(shownVersion(), '4.4.3', 'a row selects its version')
    assert.match(document.querySelector('.changelog-modal .mailer-read')?.textContent ?? '', /What changed in 4\.4\.3/)
    // the menu again, while it is open: back to the latest
    await openFromMenu(settle)
    assert.equal(shownVersion(), '4.4.5', 'raised from the menu')
    // closed and opened again
    const backdrop = document.querySelector('.changelog-modal')?.closest('.overlay') as HTMLElement | null
    assert.ok(backdrop, 'the centred panel sits in a dismissable backdrop')
    await inAct(() => { backdrop.click() })
    await settle()
    assert.ok(!panelOpen(), 'closed')
    await openFromMenu(settle)
    assert.equal(shownVersion(), '4.4.5', 'reopened')
  })
})

test('§6 the header link opens App settings on Display, at "Open changelog after updates"', async () => {
  await withApp({ news: { from: '4.4.4', to: '4.4.5' } }, async ({ settle }) => {
    await settle()
    const link = document.querySelector<HTMLButtonElement>('.changelog-modal .changelog-setting-link')
    assert.ok(link, 'the header has the link')
    assert.equal(link.textContent, 'Open after updates: On')
    await inAct(() => { link.click() })
    await settle()
    await inAct(async () => { advance(400); await flush(20) })
    const row = document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden]) [data-settings-field="changelog_after_update"]')
    assert.ok(row, 'App settings shows the Display tab with the setting')
    assert.match(row.textContent ?? '', /Open changelog after updates/)
    assert.equal(row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, true, 'on by default')
  })
})
