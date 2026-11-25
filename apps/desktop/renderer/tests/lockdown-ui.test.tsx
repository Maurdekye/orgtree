import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal } from '../src/canvas/mail'
import { SettingsPanel } from '../src/App'
import type { TreePayload } from '../src/types'
import { orgDndTree, orgDndResponse } from './orgdnd-fixture'

// Org mailbox lockdown (USER 2026-11-25 13:26Z m0388b64a9372 "a little lock icon in the corner of their status
// while enabled to anyone with access, and to anyone without access, their whole status symbol is replaced with a
// lock"; settings 14:10Z m16ef9bb35e25 + m405b44961ff5 "on, off, and org decides"; docket
// org-mailbox-lockdown-allow-list-mode-that-denies).
const NET = { slug: 'home.fixture.123abc', hubs: [{ id: 'a', address: 'http://hub-a.invalid', name: 'Fixture hub', version: '2.6.0',
  enabled: true, connected: true, queued: 0, blocks: [], blocked_by: [],
  locked: { 'alice.fixture.aa0011': 'closed', 'bob.fixture.bb0022': 'open' },
  roster: [{ slug: 'alice.fixture.aa0011', org_name: 'Alice', kind: 'org', online: true },
    { slug: 'bob.fixture.bb0022', org_name: 'Bob', kind: 'org', online: true },
    { slug: 'cy.fixture.cc0033', org_name: 'Cy', kind: 'person', online: true }] }] } as unknown as TreePayload['net']
const LOCKDOWN = { setting: 'org', on: true, org_on: true, set_aside: false, rev: 3, set_by: 'front', set_at: '2026-11-25T15:00:00Z', refused: 2,
  agents_may_change: true, coverage: 'enforced',
  allow: [{ hub: 'a', hub_name: 'Fixture hub', address: 'bob.fixture.bb0022', added_by: 'front', at: '2026-11-25T15:00:00Z' }],
  hubs: [{ hub: 'a', hub_name: 'Fixture hub', state: 'enforced', rev: 3, detail: null }] }
const ok = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'X-Orgtree-Instance': 'fixture' } })

test('the mailservers tab shows a closed contact only the lock, an open one a lock badge, and the lockdown list', async t => {
  const original = globalThis.fetch
  const posts: unknown[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/net/lockdown')) {
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)))
      return ok(LOCKDOWN)
    }
    if (url.endsWith('/net/blocks')) return ok({ blocked: [], blocked_by: [] })
    return ok(url.endsWith('/org_inbox') ? { entries: [], total: 0, unread: 0 } : { transfers: [] })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  HTMLElement.prototype.scrollIntoView ??= () => {}
  const view = await mountView(<OrgInboxModal slug="mine" map={new Map()} toast={() => {}} close={() => {}}
    inbox={{ entries: [], total: 0, unread: 0, visible: true, holders: [] } as unknown as TreePayload['org_inbox']} net={NET} />, host => host)
  t.after(() => view.unmount())
  await flush(6)
  const tab = [...view.el.querySelectorAll('button')].find(b => b.textContent?.trim().toLowerCase().startsWith('mailservers'))
  await inAct(() => tab!.click()); await flush(8)
  const row = (name: string) => [...view.el.querySelectorAll('.oi-roster .oi-peer')].find(p => p.textContent?.includes(name)) ?? assert.fail(`no roster row for ${name}: ${view.el.querySelector('.oi-net')?.textContent}`)
  assert.equal(row('@net:alice.').querySelector('.oi-locked')?.getAttribute('aria-label'), "in lockdown, can't be messaged", 'closed: the lock replaces the status')
  assert.equal(row('@net:alice.').querySelector('.oi-lockbadge'), null, 'and no dot with a badge')
  assert.ok(row('@net:bob.').querySelector('.oi-lockbadge .oi-lockbadge-lock'), 'open: the dot keeps a small lock')
  assert.equal(row('@net:cy.').querySelector('.oi-locked, .oi-lockbadge'), null, 'not locked: as before')
  const section = view.el.querySelector('.oi-lockdown')?.textContent ?? ''
  assert.match(section, /lockdown/); assert.match(section, /Org decides/); assert.match(section, /2 refused/); assert.match(section, /Fixture hub: enforced/)
  assert.deepEqual([...row('@net:bob.').querySelectorAll('button.link')].map(b => b.textContent), ['unlist', 'block'])
  const allow = [...row('@net:alice.').querySelectorAll('button.link')].find(b => b.textContent === 'allow')!
  await inAct(() => allow.click()); await flush(4)
  assert.deepEqual(posts.at(-1), { add: [{ hub: 'a', address: 'alice.fixture.aa0011' }] })
})

test('settings: Org decides is the default for outside communication and the lockdown, each showing what is in force', async t => {
  const original = globalThis.fetch
  const posts: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' && init.body) posts.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(url.endsWith('/net/lockdown') ? LOCKDOWN : orgDndResponse(url)), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  const tree = { ...orgDndTree, org_inbox: { ...orgDndTree.org_inbox, mode: 'closed', enabled: false, setting: 'org', org_choice: 'closed',
    lockdown: { setting: 'org', on: true, coverage: 'partial', set_aside: false, set_aside_unread: 0 } } } as unknown as TreePayload
  const view = await mountView(<SettingsPanel tree={tree} initialTab="mailserver" toast={() => {}} close={() => {}} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(8) })
  const outside = view.el.querySelector<HTMLSelectElement>('select[aria-label="Org mailbox mode"]')!
  assert.deepEqual([...outside.options].map(o => o.text), ['Org decides', 'Normal operations', 'Do not disturb', 'Closed off mailbox'])
  assert.equal(outside.value, 'org')
  assert.equal(view.el.querySelector('#org-inbox-actual')?.textContent, " Now closed (the org's choice).")
  const lock = view.el.querySelector<HTMLSelectElement>('select[aria-label="Org mailbox lockdown"]')!
  assert.deepEqual([...lock.options].map(o => o.text), ['Org decides', 'On', 'Off'])
  assert.equal(lock.value, 'org')
  assert.equal(view.el.querySelector('#org-lockdown-actual')?.textContent, ' Now on, on some hubs only.')
  await inAct(async () => {
    const w = lock.ownerDocument.defaultView!
    Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')!.set!.call(lock, 'off')
    lock.dispatchEvent(new w.Event('change', { bubbles: true })); await flush(4)
  })
  assert.deepEqual(posts.find(p => p.url.endsWith('/net/lockdown'))?.body, { setting: 'off' }, 'the lockdown setting saves at once')
})
