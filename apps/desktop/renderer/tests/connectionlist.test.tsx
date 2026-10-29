// The Connections lists: Org settings → Connections and App settings → Mail
// hub (USER 2026-10-29). A row is a presence dot and the connection's chip
// ("thought the gray dot meant offline", m4c84e393768e; "that should be
// communicated more clearly", m0537fdb73608; "also remove the online /
// independent chat tags", mae6a9c785cc0); the words moved into the chip's one
// hover ("and just show that text when hovering the link", m6f8fcfbd2824;
// "online status and chat type", m822daec481cc; "(org, person, independent
// chat)", me07459d92f6d). The list is rows, scrolls past ten and mounts only
// the rows near the view (mdc7e971eaf19), sorted online first, then the
// newest mail with the org, none last A-Z (m3e3829f0bf18). The Mail hub tab
// drops its intro and migration reports for the same list of the local hub
// (m12a433749fda), with Chat from your phone below it (m6b0d9089462e).
// Offline is a hollow grey ring, as in Hubchat ("A5 use the grey ring for
// offline both places", m019c9500d23a).
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { Connections } from '../src/canvas/connections'
import { MailHubSettings } from '../src/canvas/hosthub'
import { setHubchatInstalled } from '../src/canvas/agentmentions'
import { hubAddressTitle, resetNetMentions, setNetRoster } from '../src/canvas/netmentions'
import type { NetBlock, NetPeer, TreePayload } from '../src/types'

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

/** Route the renderer's reads; every request is kept. */
function serve(t: TestContext, answer: (url: string) => unknown) {
  const urls: string[] = []
  const old = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const body = url.endsWith('/api/desktop/phone') ? { hubchat_pc: false } : answer(url) ?? {}
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(async () => {
    globalThis.fetch = old
    await inAct(async () => { resetNetMentions(); setHubchatInstalled(false); await flush(2) })
  })
  return urls
}

const netOf = (roster: NetPeer[], extra: Partial<NetBlock['hubs'][number]> = {}): NetBlock => ({
  slug: 'acme.home.a1b2c3',
  hubs: [{ id: 'local', address: 'http://127.0.0.1:7370', name: 'maurdekye-net', version: '2.2.0', enabled: true,
    connected: true, queued: 0, roster, ...extra }],
})
const treeOf = (net: NetBlock) => ({ slug: 'acme', net } as unknown as TreePayload)

function Fixture({ tree }: { tree: TreePayload }) {
  const [adding, setAdding] = useState('')
  return <Connections tree={tree} toast={() => {}} adding={adding} setAdding={setAdding} />
}

async function mountTab(t: TestContext, net: NetBlock) {
  setNetRoster('acme', net)
  const view = await mountView(<Fixture tree={treeOf(net)} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(8) })
  return view
}

const list = (el: HTMLElement) => el.querySelector<HTMLElement>('[role="list"]')!
const rows = (el: HTMLElement) => [...list(el).querySelectorAll<HTMLElement>('[role="listitem"]')]
const addressOf = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-hub-address]')!.dataset.hubAddress!

test("a hub's connections are rows: a presence dot and the chip, with no words beside them", async t => {
  serve(t, () => ({ recent: {} }))
  const roster: NetPeer[] = [
    { slug: 'alpha.home.aa0001', org_name: 'alpha test', kind: 'org', online: true },
    { slug: 'orgtree-rustengine.cc.bb0002', username: 'orgtree-rustengine', kind: 'chat', online: false, blurb: 'independent Claude Code chat' },
    { slug: 'link.19356f', org_name: 'Penelope', kind: 'chat', online: false, blurb: 'Waiting to be linked to a Hubchat identity' },
    { slug: 'maurdekye.p.cc0003', username: 'Maurdekye', kind: 'person', online: true },
  ]
  const view = await mountTab(t, netOf(roster))
  assert.equal(view.el.querySelectorAll('.connection-row li, .connection-row ul').length, 0, 'no bulleted list')
  const shown = rows(view.el)
  assert.equal(shown.length, 4)
  for (const row of shown) {
    const peer = roster.find(p => '@net:' + p.slug === addressOf(row))!
    const dot = row.firstElementChild as HTMLElement
    const word = peer.online ? 'Online' : 'Offline'
    assert.deepEqual([dot.classList.contains('presence-dot'), dot.classList.contains(peer.online ? 'online' : 'offline'),
      dot.title, dot.getAttribute('aria-label')], [true, true, word, word], `${peer.slug}'s dot`)
    const chip = row.querySelector<HTMLElement>('[data-hub-address]')!
    assert.equal(row.textContent, chip.textContent, `${peer.slug}: the row says nothing beside its chip`)
    assert.equal(chip.title, hubAddressTitle(addressOf(row)), 'the chip keeps the one @net hover')
  }
  const text = list(view.el).textContent!
  for (const gone of ['Online', 'Offline', 'independent Claude Code chat', 'Waiting to be linked']) {
    assert.doesNotMatch(text, new RegExp(gone), `"${gone}" moved into the hover`)
  }
})

test('online first, then the newest mail with this org; no mail last, A-Z; equal times A-Z', async t => {
  const urls = serve(t, url => url === '/api/orgs/acme/net/recent' ? { recent: {
    'zed.on.old': ago(3 * 1440), 'mike.on.new': ago(60), 'off.new': ago(10), 'off.old': ago(2 * 1440),
    'tieb.off': ago(1440), 'tiea.off': ago(1440), 'not.listed': ago(1),
  } } : undefined)
  const roster: NetPeer[] = [
    { slug: 'charlie.off.none', org_name: 'charlie', kind: 'org', online: false },
    { slug: 'zed.on.old', org_name: 'Zed', kind: 'org', online: true },
    { slug: 'tieb.off', org_name: 'Tie Beta', kind: 'chat', online: false },
    { slug: 'alpha.on.none', org_name: 'Alpha', kind: 'org', online: true },
    { slug: 'off.old', org_name: 'Ollie', kind: 'person', online: false },
    { slug: 'mike.on.new', username: 'Mike', kind: 'person', online: true },
    { slug: 'noname.on.x', kind: 'org', online: true },
    { slug: 'bravo.off.none', org_name: 'Bravo', kind: 'org', online: false },
    { slug: 'off.new', org_name: 'Oscar', kind: 'chat', online: false },
    { slug: 'beta.on.none', username: 'beta', kind: 'chat', online: true },
    { slug: 'tiea.off', org_name: 'Tie Alpha', kind: 'chat', online: false },
  ]
  const view = await mountTab(t, netOf(roster))
  assert.ok(urls.includes('/api/orgs/acme/net/recent'), 'the order comes from the engine: this org\'s newest mail per address')
  assert.deepEqual(rows(view.el).map(addressOf).map(a => a.slice(5)), [
    'mike.on.new', 'zed.on.old', 'alpha.on.none', 'beta.on.none', 'noname.on.x',
    'off.new', 'tiea.off', 'tieb.off', 'off.old', 'bravo.off.none', 'charlie.off.none',
  ])
})

test("the chip's hover gives the presence and the type, then its name, the hub's description and the address", async t => {
  serve(t, () => ({ recent: {} }))
  setHubchatInstalled(false)
  setNetRoster('acme', { slug: 'acme.home.a1b2c3', hubs: [
    { id: 'local', address: 'http://127.0.0.1:7370', enabled: true, connected: true, queued: 0, roster: [
      { slug: 'alice.p.77ded7', username: 'Alice', kind: 'person', online: true },
      { slug: 'acme2.o.12ab34', org_name: 'Acme Labs', kind: 'org', online: false },
      { slug: 'cc.c.5e55', kind: 'chat', online: true, blurb: 'independent Claude Code chat' },
      { slug: 'link.19356f', org_name: 'Penelope', kind: 'chat', online: false, blurb: 'Waiting to be linked to a Hubchat identity' },
      { slug: 'both.o.9999', org_name: 'Both', kind: 'org', online: false },
    ] },
    { id: 'far', address: 'https://far.example', enabled: true, connected: true, queued: 0, roster: [
      { slug: 'both.o.9999', org_name: 'Both', kind: 'org', online: true },
    ] },
  ] })
  const off = "Hubchat isn't installed"
  assert.equal(hubAddressTitle('@net:alice.p.77ded7'), `Online · person\nAlice\n@net:alice.p.77ded7\n${off}`)
  assert.equal(hubAddressTitle('@net:acme2.o.12ab34'), `Offline · org\nAcme Labs\n@net:acme2.o.12ab34\n${off}`)
  assert.equal(hubAddressTitle('@net:cc.c.5e55'), `Online · independent chat\nindependent Claude Code chat\n${off}`,
    'an unnamed chip shows its address, so the hover leaves it out')
  assert.equal(hubAddressTitle('@net:link.19356f'),
    `Offline · independent chat\nPenelope\nWaiting to be linked to a Hubchat identity\n@net:link.19356f\n${off}`)
  assert.equal(hubAddressTitle('@net:both.o.9999'), `Online · org\nBoth\n@net:both.o.9999\n${off}`, 'online on any hub that lists it')
  assert.equal(hubAddressTitle('@net:stranger.999999'), `Network address\n${off}`, 'an address no hub lists keeps its kind line')
})

test('past ten rows the list scrolls in a ten-row window and mounts only the rows near the view', async t => {
  const urls = serve(t, url => url === '/api/orgs/acme/net/recent' ? { recent: {} } : undefined)
  const roster: NetPeer[] = Array.from({ length: 200 }, (_, i) => ({
    slug: `peer${String(i).padStart(3, '0')}.x.${i}`, org_name: `Peer ${String(i).padStart(3, '0')}`, kind: 'org', online: false,
    picture: { revision: `${String(i).padStart(20, '0')}-${'0'.repeat(32)}`, sha256: 'a'.repeat(64), width: 3, height: 3, bytes: 3 },
  }))
  const view = await mountTab(t, netOf(roster))
  const box = list(view.el)
  assert.equal(box.classList.contains('scrolls'), true)
  assert.equal(box.style.height, '300px', 'ten rows of the default 30 px (jsdom measures nothing)')
  let mounted = rows(view.el)
  assert.ok(mounted.length >= 10 && mounted.length <= 20, `${mounted.length} rows mounted of 200`)
  assert.deepEqual([mounted[0]!.getAttribute('aria-posinset'), mounted[0]!.getAttribute('aria-setsize')], ['1', '200'])
  const pictures = () => urls.filter(u => u.includes('/net/profile-picture')).map(u => decodeURIComponent(u.split('address=')[1]!))
  assert.ok(pictures().length > 0 && pictures().every(a => mounted.some(r => addressOf(r) === a)),
    'pictures are asked for only for mounted rows')
  await inAct(async () => { box.scrollTop = 3000; box.dispatchEvent(new window.Event('scroll')); await flush(4) })
  mounted = rows(view.el)
  const at = mounted.map(r => Number(r.getAttribute('aria-posinset')))
  assert.ok(at.includes(101) && !at.includes(1) && mounted.length <= 25, `the window follows the scroll: ${at[0]}..${at.at(-1)}`)
  assert.equal(addressOf(mounted[at.indexOf(101)]!), '@net:peer100.x.100', 'the sorted list is what is paged')
  const gap = box.firstElementChild as HTMLElement
  assert.equal(gap.getAttribute('aria-hidden'), 'true')
  assert.equal(gap.style.height, `${(at[0]! - 1) * 30}px`, 'the rows above the window keep their height')
  assert.ok(pictures().length < 60, `${pictures().length} pictures asked for, not 200`)
})

test('rows keep their places while the pointer is over the list; the dots change at once', async t => {
  serve(t, () => ({ recent: {} }))
  const peers = (bOnline: boolean, cOnline: boolean): NetPeer[] => [
    { slug: 'a.x.1', org_name: 'A', kind: 'org', online: true },
    { slug: 'b.x.2', org_name: 'B', kind: 'org', online: bOnline },
    { slug: 'c.x.3', org_name: 'C', kind: 'org', online: cOnline },
    { slug: 'd.x.4', org_name: 'D', kind: 'org', online: false },
  ]
  const before = netOf(peers(true, false))
  const view = await mountTab(t, before)
  const order = () => rows(view.el).map(addressOf).map(a => a.slice(5, 6))
  const dots = () => rows(view.el).map(r => r.firstElementChild!.classList.contains('online'))
  assert.deepEqual(order(), ['a', 'b', 'c', 'd'])
  await inAct(async () => { list(view.el).dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })); await flush(2) })
  const after = netOf(peers(false, true))
  await inAct(async () => { setNetRoster('acme', after); await flush(2) })
  await view.render(<Fixture tree={treeOf(after)} />)
  await inAct(async () => { await flush(4) })
  assert.deepEqual(order(), ['a', 'b', 'c', 'd'], 'held while the pointer is over it')
  assert.deepEqual(dots(), [true, false, true, false], 'the dots are already current')
  await inAct(async () => {
    list(view.el).dispatchEvent(new window.MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })); await flush(4)
  })
  assert.deepEqual(order(), ['a', 'c', 'b', 'd'], 'the new order applies once the pointer leaves')
})

test("App settings › Mail hub: the hub's status, then everyone on the hub; no intro or migration reports; the phone section after", async t => {
  resetNetMentions()
  const hub = {
    version: 2, port: 7370, bind: '127.0.0.1', name: 'desk', retention_days: null, org_retention_days: 45,
    public_listener: false, public_listener_port: 7371,
    status: { running: true, healthy: true, address: 'http://127.0.0.1:7370', exposed: false, hub_name: 'maurdekye-net',
      hub_version: '2.2.0', orgs: 3, queued: 1 },
    data_migration: { messages: 0, attachments: 0, orgs_copied: 0, orgs_skipped: [] },
    v2_import: { orgs: 16, messages: 86, attachments: 2 },
  }
  const urls = serve(t, url => url === '/api/desktop/hub' ? hub : url === '/api/desktop/hub/connections' ? {
    running: true,
    connections: [
      { slug: 'chat.c.1', username: 'orgtree-coordinator-opus', kind: 'chat', online: false, blurb: 'independent Claude Code chat' },
      { slug: 'home.o.2', org_name: 'Maurdekye Works', kind: 'org', online: true },
      { slug: 'neoja.p.3', username: 'neoja', kind: 'person', online: true },
    ],
    recent: { 'home.o.2': ago(120), 'neoja.p.3': ago(5), 'chat.c.1': ago(1) },
  } : undefined)
  const view = await mountView(<MailHubSettings />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(10) })
  const text = view.el.textContent!
  assert.match(text, /Running at http:\/\/127\.0\.0\.1:7370 · hub version 2\.2\.0 · 3 registered, 1 queued/)
  for (const gone of [/carries correspondence/, /was migrated/, /moved into its new database/, /kept untouched/]) {
    assert.doesNotMatch(text, gone, 'the intro and the migration reports are gone from view')
  }
  assert.ok(urls.includes('/api/desktop/hub/connections'), "the list is the hub's own, read through the engine")
  assert.deepEqual(rows(view.el).map(addressOf), ['@net:neoja.p.3', '@net:home.o.2', '@net:chat.c.1'],
    'online first by newest mail, then offline')
  assert.equal(rows(view.el)[2]!.querySelector<HTMLElement>('[data-hub-address]')!.title.split('\n')[0], 'Offline · independent chat',
    "the hub's rows describe their chips where no org's rosters list them")
  const status = view.el.querySelector('[role="status"]')!, rowsList = list(view.el)
  const phone = view.el.querySelector('.phone-settings')!, hosting = view.el.querySelector('[aria-label="Mail hub name"]')!
  const before = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  assert.ok(before(status, rowsList) && before(rowsList, phone) && before(phone, hosting),
    'status, then the connections, then Chat from your phone, then the hosting settings')
})

declare const __SRC_DIR__: string
/** The declarations of one CSS rule, by its exact selector. */
function rule(file: string, selector: string): string {
  const css = readFileSync(path.join(__SRC_DIR__, file), 'utf8')
  const m = new RegExp('(?:^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css)
  assert(m, `${file} has a rule for ${selector}`)
  return m[1] ?? ''
}

test('offline is a hollow grey ring, the grey of an app that is off; online stays a filled green dot', () => {
  const offline = rule('canvas/connectionlist.css', '.presence-dot.offline')
  assert.match(offline, /border:\s*2px solid var\(--dim\)/, 'a 2 px ring in the theme grey')
  assert.match(offline, /background:\s*transparent/, 'hollow')
  assert.doesNotMatch(offline, /--bad|red/, 'no red')
  assert.match(rule('canvas/connectionlist.css', '.presence-dot.online'), /background:\s*var\(--ok\)/)
  // the custom app's off light is the same hollow grey ring
  assert.match(rule('canvas/apps/apps.css', '.custom-app-dot'), /border:1px solid currentColor;[^;]*;color:var\(--dim\)/)
})
