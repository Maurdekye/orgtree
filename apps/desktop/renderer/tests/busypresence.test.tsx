// Busy presence (Mail hub 2.3.0; docket
// org-presence-busy-orange-when-no-org-inbox-holde): an org none of whose
// org-inbox holders can start a turn "appears as "busy" with an orange marker,
// instead of online" (USER 2026-10-30 23:03Z ma662ce2d2385), and so does a
// person away from Hubchat for an hour (23:05Z mcb9aa2c7e4af, 23:06Z
// mac1516a71553); the colour is "Amber (existing caution colour)" (23:19Z
// mfb051a00d947). An address a hub lists online can be busy instead: the same
// presence dot, filled through one token (--busy, the caution --warn), with
// the word Busy, in the Connections lists and in every chip's hover. Lists go
// online, then busy, then offline. A hub before 2.3.0 sends no busy, so its
// addresses stay online.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { Connections } from '../src/canvas/connections'
import { setHubchatInstalled } from '../src/canvas/agentmentions'
import { hubAddressTitle, resetNetMentions, setNetRoster } from '../src/canvas/netmentions'
import type { NetBlock, NetPeer, TreePayload } from '../src/types'

const NOW = Date.parse('2026-10-30T23:30:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

/** Route the renderer's reads: this org's newest mail per address, and the phone panel. */
function serve(t: TestContext, recent: Record<string, string> = {}) {
  const old = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.endsWith('/api/desktop/phone') ? { hubchat_pc: false } : url === '/api/orgs/acme/net/recent' ? { recent } : {}
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(async () => {
    globalThis.fetch = old
    await inAct(async () => { resetNetMentions(); setHubchatInstalled(false); await flush(2) })
  })
}

const hub = (id: string, address: string, roster: NetPeer[]): NetBlock['hubs'][number] =>
  ({ id, address, name: id, version: '2.3.0', enabled: true, connected: true, queued: 0, roster })
const netOf = (...hubs: NetBlock['hubs']): NetBlock => ({ slug: 'acme.home.a1b2c3', hubs })
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

const rows = (el: HTMLElement) => [...el.querySelector<HTMLElement>('[role="list"]')!.querySelectorAll<HTMLElement>('[role="listitem"]')]
const addressOf = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-hub-address]')!.dataset.hubAddress!

test('a busy address wears the same presence dot, filled, with the word Busy', async t => {
  serve(t)
  const view = await mountTab(t, netOf(hub('local', 'http://127.0.0.1:7370', [
    { slug: 'acme2.o.12ab34', org_name: 'Acme Labs', kind: 'org', online: true, busy: true },
    { slug: 'alice.p.77ded7', username: 'Alice', kind: 'person', online: true, busy: false },
    { slug: 'gone.o.000001', org_name: 'Gone', kind: 'org', online: false, busy: false },
  ])))
  const dot = (slug: string) => {
    const el = rows(view.el).find(r => addressOf(r) === '@net:' + slug)!.firstElementChild as HTMLElement
    return [[...el.classList].join(' '), el.title, el.getAttribute('aria-label')]
  }
  assert.deepEqual(dot('acme2.o.12ab34'), ['presence-dot busy', 'Busy', 'Busy'], 'busy: its own class, hover and name')
  assert.deepEqual(dot('alice.p.77ded7'), ['presence-dot online', 'Online', 'Online'])
  assert.deepEqual(dot('gone.o.000001'), ['presence-dot offline', 'Offline', 'Offline'])
})

test('lists go online, then busy, then offline; within each the newest mail first, none last A-Z', async t => {
  serve(t, { 'busy.new': ago(5), 'busy.old': ago(500), 'on.old': ago(900), 'off.new': ago(1) })
  const view = await mountTab(t, netOf(hub('local', 'http://127.0.0.1:7370', [
    { slug: 'off.none', org_name: 'Off none', kind: 'org', online: false },
    { slug: 'busy.old', org_name: 'Busy old', kind: 'org', online: true, busy: true },
    { slug: 'on.none', org_name: 'On none', kind: 'person', online: true, busy: false },
    { slug: 'busy.none', org_name: 'Busy none', kind: 'person', online: true, busy: true },
    { slug: 'off.new', org_name: 'Off new', kind: 'org', online: false },
    { slug: 'busy.new', org_name: 'Busy new', kind: 'org', online: true, busy: true },
    { slug: 'on.old', org_name: 'On old', kind: 'org', online: true },
  ])))
  assert.deepEqual(rows(view.el).map(addressOf).map(a => a.slice(5)),
    ['on.old', 'on.none', 'busy.new', 'busy.old', 'busy.none', 'off.new', 'off.none'])
})

test("the chip's hover leads with Busy; online and not busy on any hub wins, and a hub before busy says online", () => {
  setHubchatInstalled(false)
  setNetRoster('acme', netOf(
    hub('local', 'http://127.0.0.1:7370', [
      { slug: 'acme2.o.12ab34', org_name: 'Acme Labs', kind: 'org', online: true, busy: true },
      { slug: 'alice.p.77ded7', username: 'Alice', kind: 'person', online: true, busy: true },
      { slug: 'both.o.9999', org_name: 'Both', kind: 'org', online: true, busy: true },
      { slug: 'half.o.8888', org_name: 'Half', kind: 'org', online: true, busy: true },
      { slug: 'old.o.7777', org_name: 'Old', kind: 'org', online: true },
    ]),
    hub('far', 'https://far.example', [
      { slug: 'both.o.9999', org_name: 'Both', kind: 'org', online: true, busy: false },
      { slug: 'half.o.8888', org_name: 'Half', kind: 'org', online: false },
    ])))
  try {
    const off = "Hubchat isn't installed"
    assert.equal(hubAddressTitle('@net:acme2.o.12ab34'), `Busy · org\nAcme Labs\n@net:acme2.o.12ab34\n${off}`)
    assert.equal(hubAddressTitle('@net:alice.p.77ded7'), `Busy · person\nAlice\n@net:alice.p.77ded7\n${off}`)
    assert.equal(hubAddressTitle('@net:both.o.9999'), `Online · org\nBoth\n@net:both.o.9999\n${off}`, 'online and not busy on one hub: online')
    assert.equal(hubAddressTitle('@net:half.o.8888'), `Busy · org\nHalf\n@net:half.o.8888\n${off}`, 'busy where it is online, offline elsewhere: busy')
    assert.equal(hubAddressTitle('@net:old.o.7777'), `Online · org\nOld\n@net:old.o.7777\n${off}`, 'no busy from the hub: online, as before')
  } finally {
    resetNetMentions()
  }
})

declare const __SRC_DIR__: string
/** The declarations of one CSS rule, by its exact selector. */
function rule(file: string, selector: string): string {
  const css = readFileSync(path.join(__SRC_DIR__, file), 'utf8')
  const m = new RegExp('(?:^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css)
  assert(m, `${file} has a rule for ${selector}`)
  return m[1] ?? ''
}

test('busy is filled with one token, the caution amber', () => {
  assert.match(rule('canvas/connectionlist.css', '.presence-dot.busy'), /background:\s*var\(--busy\)/, 'the dot reads the token')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const tokens = [...css.matchAll(/--busy:\s*([^;]+);/g)].map(m => m[1]!.trim())
  assert.deepEqual(tokens, ['var(--warn)'], 'declared once, as the caution amber of both themes: one line to change')
})
