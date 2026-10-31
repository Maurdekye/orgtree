// Do not disturb presence (Mail hub 2.3.0; docket
// org-presence-busy-orange-when-no-org-inbox-holde, the addition of USER
// 2026-10-31 08:51Z md63cf5e0960f: "when an org's outside operations are set
// to do not disturb, it should show a red status icon in hubchat /
// elsewhere"). An org whose outside mail is set to Do not disturb wears the
// same presence dot, filled through one token (--dnd, the danger red --bad),
// with the words Do not disturb, in the Connections lists and in every chip's
// hover. Lists go online, then busy, then Do not disturb, then offline. The
// hub lists a DND address in busy too (a hub or client that knows busy only
// shows it busy), and offline wins over DND (USER 2026-10-31 09:03Z
// m65f544179c74, "Offline for both").
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

const NOW = Date.parse('2026-10-31T09:30:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const NL = String.fromCharCode(10)

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

test('a Do not disturb address wears the same presence dot, filled, with the words Do not disturb', async t => {
  serve(t)
  const view = await mountTab(t, netOf(hub('local', 'http://127.0.0.1:7370', [
    { slug: 'acme2.o.5e1f00', org_name: 'Acme Labs', kind: 'org', online: true, busy: true, dnd: true },
    { slug: 'beta.o.5e1f01', org_name: 'Beta Works', kind: 'org', online: true, busy: true },
    { slug: 'cara.p.5e1f02', username: 'Cara', kind: 'person', online: true },
  ])))
  const dot = (slug: string) => {
    const el = rows(view.el).find(r => addressOf(r) === '@net:' + slug)!.firstElementChild as HTMLElement
    return [[...el.classList].join(' '), el.title, el.getAttribute('aria-label')]
  }
  assert.deepEqual(dot('acme2.o.5e1f00'), ['presence-dot dnd', 'Do not disturb', 'Do not disturb'], 'DND: its own class, hover and name')
  assert.deepEqual(dot('beta.o.5e1f01'), ['presence-dot busy', 'Busy', 'Busy'])
  assert.deepEqual(dot('cara.p.5e1f02'), ['presence-dot online', 'Online', 'Online'])
})

test('lists go online, then busy, then Do not disturb, then offline; within each the newest mail first', async t => {
  // a DND org's newer mail does not lift it among the busy: each group comes whole, then the newest mail within it
  serve(t, { 'dnd.new': ago(1), 'dnd.old': ago(500), 'busy.new': ago(5), 'busy.old': ago(900), 'off.new': ago(2) })
  const view = await mountTab(t, netOf(hub('local', 'http://127.0.0.1:7370', [
    { slug: 'off.new', org_name: 'Off new', kind: 'org', online: false },
    { slug: 'dnd.old', org_name: 'DND old', kind: 'org', online: true, busy: true, dnd: true },
    { slug: 'busy.new', org_name: 'Busy new', kind: 'org', online: true, busy: true },
    { slug: 'dnd.new', org_name: 'DND new', kind: 'org', online: true, busy: true, dnd: true },
    { slug: 'busy.old', org_name: 'Busy old', kind: 'org', online: true, busy: true },
    { slug: 'on.none', org_name: 'On none', kind: 'person', online: true },
  ])))
  assert.deepEqual(rows(view.el).map(addressOf).map(a => a.slice(5)), ['on.none', 'busy.new', 'busy.old', 'dnd.new', 'dnd.old', 'off.new'])
})

test("the chip's hover leads with Do not disturb; offline wins over it, and the most available presence on any hub wins", () => {
  setHubchatInstalled(false)
  setNetRoster('acme', netOf(
    hub('local', 'http://127.0.0.1:7370', [
      { slug: 'acme2.o.5e1f00', org_name: 'Acme Labs', kind: 'org', online: true, busy: true, dnd: true },
      { slug: 'gone.o.5e1f03', org_name: 'Gone', kind: 'org', online: false, busy: false, dnd: true },
      { slug: 'both.o.5e1f04', org_name: 'Both', kind: 'org', online: true, busy: true, dnd: true },
      { slug: 'alpha.o.5e1f05', org_name: 'Alpha', kind: 'org', online: true, busy: true },
    ]),
    hub('far', 'https://far.example', [
      { slug: 'both.o.5e1f04', org_name: 'Both', kind: 'org', online: true, busy: true },
    ])))
  try {
    const title = (...lines: string[]) => [...lines, "Hubchat isn't installed"].join(NL)
    assert.equal(hubAddressTitle('@net:acme2.o.5e1f00'), title('Do not disturb · org', 'Acme Labs', '@net:acme2.o.5e1f00'))
    assert.equal(hubAddressTitle('@net:gone.o.5e1f03'), title('Offline · org', 'Gone', '@net:gone.o.5e1f03'),
      'offline wins over DND, even from a row that says both')
    assert.equal(hubAddressTitle('@net:both.o.5e1f04'), title('Busy · org', 'Both', '@net:both.o.5e1f04'),
      'busy on another hub: the most available presence wins, as for busy')
    assert.equal(hubAddressTitle('@net:alpha.o.5e1f05'), title('Busy · org', 'Alpha', '@net:alpha.o.5e1f05'),
      'a hub that knows busy but not DND says busy')
  } finally {
    resetNetMentions()
  }
})

declare const __SRC_DIR__: string
/** The declarations of one CSS rule, by its exact selector (`<selector> {`). */
function rule(file: string, selector: string): string[] {
  const css = readFileSync(path.join(__SRC_DIR__, file), 'utf8')
  const at = css.indexOf(selector + ' {')
  assert(at >= 0, `${file} has a rule for ${selector}`)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open)).split(';').map(s => s.trim()).filter(Boolean)
}

test('Do not disturb is filled with one token, the danger red', () => {
  assert.ok(rule('canvas/connectionlist.css', '.presence-dot.dnd').includes('background: var(--dnd)'), 'the dot reads the token')
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const tokens = css.split(';').filter(s => s.includes('--dnd:')).map(s => s.slice(s.indexOf('--dnd:') + 6).trim())
  assert.deepEqual(tokens, ['var(--bad)'], 'declared once, as the danger red of both themes: one line to change')
})
