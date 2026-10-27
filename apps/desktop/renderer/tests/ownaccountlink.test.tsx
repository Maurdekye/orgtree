import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { HubContactChip, setHubchatInstalled } from '../src/canvas/agentmentions'
import { RefMdBody } from '../src/canvas/refmd'
import { RefProse } from '../src/canvas/reflinks'
import { resetNetMentions, setNetRoster } from '../src/canvas/netmentions'
import type { RefWorld } from '../src/canvas/reflinks'
import type { NetBlock } from '../src/types'
import { CONTACT_NET, ContactLists } from './net-contact-lists.fixture'

// USER 2026-10-27 21:29:15Z m17f65d1effdf: "if i click a net link to my own account and it opens hubchat, it
// should open the dm with the org the link is rendered in, not my personal settings page". Hubchat opens its
// settings page for a self-target (`hubchat://chat?to=<own address>`), so Orgtree opens the on-screen org's own
// address instead. Every other @net: link keeps `hubchat://chat?to=<its address>`.

const ME = 'me.77ded7'
const world: RefWorld = { org: 'alpha', agents: new Map(), items: new Map() }
const net = (slug: string | null): NetBlock => ({ slug, hubs: [] })
const dm = (address: string) => 'hubchat://chat?to=' + encodeURIComponent(address)
const linked = (address: string | null) => ({ hubchat_pc: true, link: address && { org: 'alpha', address, name: 'Me', at: '2026-10-27T21:00:00Z', via: 'code' } })
let now = 1_800_000_000_000

function fixture(t: TestContext, answer: unknown = linked(ME)) {
  t.mock.method(Date, 'now', () => now)
  setHubchatInstalled(false)
  now += 61_000
  const oldFetch = globalThis.fetch, oldOpen = window.open
  const requests: string[] = [], opened: string[] = []
  let current = answer
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    const body = String(input).endsWith('/api/desktop/phone') ? current : { entries: [], total: 0, transfers: [] }
    return { ok: true, status: 200, headers: new Headers(), json: async () => body }
  }) as typeof fetch
  window.open = ((url: string | URL) => { opened.push(String(url)); return null }) as typeof window.open
  t.after(async () => {
    globalThis.fetch = oldFetch; window.open = oldOpen
    await inAct(async () => { resetNetMentions(); setHubchatInstalled(false); await flush(2) })
  })
  return { requests, opened, answer: (v: unknown) => { current = v } }
}

const chip = (el: Element, address: string) => el.querySelector<HTMLButtonElement>(`[data-hub-address="${address}"]`)!
const click = (b: HTMLElement) => inAct(async () => { b.click(); await flush(2) })

test('the user\'s own @net: link opens the DM with the org it is shown in, in each org', async t => {
  const f = fixture(t)
  setNetRoster('alpha', net('alpha.111111'))
  const view = await mountView(<div><HubContactChip address={'@net:' + ME} /><HubContactChip address="@net:alice.123456" /></div>, h => h)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })
  const own = chip(view.el, '@net:' + ME)
  assert.equal(own.hasAttribute('aria-disabled'), false)
  await click(own)
  await click(chip(view.el, '@net:alice.123456'))
  assert.deepEqual(f.opened, [dm('@net:alpha.111111'), dm('@net:alice.123456')],
    'own account: the org\'s DM; someone else: their own conversation, unchanged')
  // the same link in another org opens that org's DM
  await inAct(async () => { setNetRoster('beta', net('beta.222222')); await flush(2) })
  await click(chip(view.el, '@net:' + ME))
  assert.equal(f.opened[2], dm('@net:beta.222222'))
  assert.match(chip(view.el, '@net:' + ME).title, /Open your chat with this org in Hubchat/)
  assert.doesNotMatch(chip(view.el, '@net:alice.123456').title, /your chat with this org/)
})

test('the same rule holds in Markdown, prose, the link\'s menu and a case-different spelling', async t => {
  const f = fixture(t)
  setNetRoster('alpha', net('alpha.111111'))
  const view = await mountView(<div>
    <RefMdBody html={{ __html: `<p>Ask @net:${ME}</p>` }} world={world} />
    <RefProse text={`Ask @net:${ME.toUpperCase()}`} world={world} />
    <HubContactChip address={'@net:' + ME} />
  </div>, h => h)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })
  const chips = [...view.el.querySelectorAll<HTMLButtonElement>('[data-hub-address]')]
  assert.equal(chips.length, 3)
  for (const c of chips) await click(c)
  assert.deepEqual(f.opened, Array(3).fill(dm('@net:alpha.111111')))
  // Open in Hubchat in the right-click menu goes to the DM; Copy identity still names the mentioned address
  await inAct(async () => { chips[2]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  const items = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
  assert.deepEqual(items.map(n => n.textContent), ['Open in Hubchat', 'Copy identity'])
  assert.equal(items[1]!.title, '@net:' + ME)
  await click(items[0]!)
  assert.equal(f.opened[3], dm('@net:alpha.111111'))
})

test('a roster list shows the user\'s own account as a link to the DM with that org', async t => {
  const f = fixture(t, linked('alice.fixture.aa0011'))
  setNetRoster('contact-fixture', CONTACT_NET)
  const view = await mountView(<ContactLists surface="connections" />, h => h)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })
  await click(chip(view.el, '@net:alice.fixture.aa0011'))
  await click(chip(view.el, '@net:unnamed.fixture.cc0033'))
  assert.deepEqual(f.opened, [dm('@net:home.fixture.123abc'), dm('@net:unnamed.fixture.cc0033')])
})

test('an org with no network address has no DM to open: the own-account link is inert, not the settings page', async t => {
  const f = fixture(t)
  setNetRoster('gamma', net(null))
  const view = await mountView(<div><HubContactChip address={'@net:' + ME} /><HubContactChip address="@net:alice.123456" /></div>, h => h)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })
  const own = chip(view.el, '@net:' + ME)
  assert.equal(own.getAttribute('aria-disabled'), 'true')
  assert.match(own.title, /no network address/i)
  await click(own)
  await inAct(async () => { own.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  const open = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')].find(n => n.textContent === 'Open in Hubchat')!
  assert.equal(open.disabled, true)
  await click(chip(view.el, '@net:alice.123456'))
  assert.deepEqual(f.opened, [dm('@net:alice.123456')], 'nothing opened for the own account; the other link is unchanged')
})

test('only the linked account counts: unlinked, or without Hubchat, the link behaves as it always did', async t => {
  const f = fixture(t, linked(null))
  setNetRoster('alpha', net('alpha.111111'))
  const view = await mountView(<HubContactChip address={'@net:' + ME} />, h => h)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(5) })
  await click(chip(view.el, '@net:' + ME))
  assert.deepEqual(f.opened, [dm('@net:' + ME)], 'no phone linked: an ordinary contact link')
  // a link made in the phone panel is picked up by the next shared read
  now += 61_000
  f.answer(linked(ME))
  await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush(5) })
  await click(chip(view.el, '@net:' + ME))
  assert.equal(f.opened[1], dm('@net:alpha.111111'))
  // unlinked again
  now += 61_000
  f.answer(linked(null))
  await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush(5) })
  await click(chip(view.el, '@net:' + ME))
  assert.equal(f.opened[2], dm('@net:' + ME))
  // no Hubchat installed: inert, as every contact link
  now += 61_000
  f.answer({ hubchat_pc: false, link: { address: ME } })
  await inAct(async () => { window.dispatchEvent(new Event('focus')); await flush(5) })
  const own = chip(view.el, '@net:' + ME)
  assert.equal(own.getAttribute('aria-disabled'), 'true')
  assert.match(own.title, /Hubchat isn't installed/)
  await click(own)
  assert.equal(f.opened.length, 3)
})
