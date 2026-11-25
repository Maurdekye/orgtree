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
  const row = (name: string) => [...view.el.querySelectorAll('.oi-net > .oi-hub .conn-row')].find(p => p.textContent?.includes(name)) ?? assert.fail(`no roster row for ${name}: ${view.el.querySelector('.oi-net')?.textContent}`)
  assert.equal(row('@net:alice.').querySelector('.oi-locked')?.getAttribute('aria-label'), "in lockdown, can't be messaged", 'closed: the lock replaces the status')
  assert.equal(row('@net:alice.').querySelector('.oi-lockbadge'), null, 'and no dot with a badge')
  assert.ok(row('@net:bob.').querySelector('.oi-lockbadge .oi-lockbadge-lock'), 'open: the dot keeps a small lock')
  assert.equal(row('@net:cy.').querySelector('.oi-locked, .oi-lockbadge'), null, 'not locked: as before')
  const section = view.el.querySelector('.oi-lockdown')?.textContent ?? ''
  assert.match(section, /lockdown/); assert.match(section, /Org decides/); assert.match(section, /2 refused/); assert.match(section, /Fixture hub: enforced/)
  // LIST UX REDESIGN (USER 2026-11-25 21:48:05Z m6f4d40461dde): no allow/unlist links in the hub lists, only the block ×
  for (const who of ['@net:alice.', '@net:bob.']) {
    assert.deepEqual([...row(who).querySelectorAll('button')].filter(b => !b.matches('[data-hub-address]')).map(b => b.textContent), ['×'])
  }
  assert.equal(posts.length, 0)
})

// LIST UX REDESIGN (USER 2026-11-25 21:48:05Z m6f4d40461dde "make it a list you edit under lockdown that appears only
// when lockdown is enabled ... should look like the connected list underneath mailhubs"; 21:49:37Z m8ee22829e340 "use
// the same list for each hub, and add a small red cancel button by each entry to manually block them"; 21:50:37Z
// m706c3054c21d the × is part of the general list component; 21:51:09Z md60a3e7803d1 "the allowlist add opens a
// dropdown with searchable names").
const mountLockdown = async (t: { after: (f: () => void) => void }, lockdown: unknown, blocked: string[] = []) => {
  const original = globalThis.fetch
  const posts: unknown[] = []
  const blockPosts: unknown[] = []
  let blocks = { blocked: blocked.map(address => ({ address, set_by: '@user', reason: null, at: '2026-11-25T15:00:00Z' })), blocked_by: [] as string[] }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/net/lockdown')) {
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)))
      return ok(lockdown)
    }
    if (url.endsWith('/net/blocks')) {
      if (init?.method === 'POST') {
        const b = JSON.parse(String(init.body)) as { address: string; blocked: boolean }
        blockPosts.push(b)
        blocks = { ...blocks, blocked: b.blocked ? [...blocks.blocked, { address: b.address, set_by: '@user', reason: null, at: '2026-11-25T15:00:00Z' }]
          : blocks.blocked.filter(x => x.address !== b.address) }
      }
      return ok(blocks)
    }
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
  return { view, posts, blockPosts }
}
const GONE = { hub: 'a', hub_name: 'Fixture hub', address: 'gone.fixture.dd0044', added_by: '@user', at: '2026-11-25T15:00:00Z' }
const rowOf = (root: Element, address: string) => [...root.querySelectorAll('.conn-rows .conn-row')]
  .find(c => c.querySelector(`[data-hub-address="@net:${address}"]`)) as HTMLElement | undefined
const xOf = (row: Element) => row.querySelector<HTMLButtonElement>('button.conn-x')

test('lockdown on: the list shows in the shared connections list, each with a × that takes it off; no address box', async t => {
  const { view, posts } = await mountLockdown(t, { ...LOCKDOWN, allow: [...LOCKDOWN.allow, GONE] })
  const section = view.el.querySelector('.oi-lockdown') ?? assert.fail('no lockdown section')
  const list = section.querySelector('.oi-lock-list') ?? assert.fail('no list while lockdown is on')
  assert.ok(list.querySelector('.conn-rows[role="list"]'), 'the same list component the hubs use')
  assert.ok(list.textContent?.includes('Fixture hub'), 'under its hub')
  assert.deepEqual([...list.querySelectorAll('.conn-row [data-hub-address]')].map(c => c.getAttribute('data-hub-address')).sort(),
    ['@net:bob.fixture.bb0022', '@net:gone.fixture.dd0044'], 'listed contacts, connected or not')
  assert.equal(section.querySelector('input[aria-label="Address to allow"]'), null, 'no address box')
  assert.equal([...section.querySelectorAll('button')].some(b => /^(allow|unlist)$/.test(b.textContent ?? '')), false, 'no allow/unlist links')
  const x = xOf(rowOf(list, 'gone.fixture.dd0044')!) ?? assert.fail('no × on a listed card')
  assert.equal(x.title, 'Take @net:gone.fixture.dd0044 off the lockdown list')
  await inAct(() => x.click()); await flush(4)
  assert.deepEqual(posts, [{ remove: [{ hub: 'a', address: 'gone.fixture.dd0044' }] }], '× removes, it does not block')
  // every hub's own list is the same component
  assert.ok(view.el.querySelector('.oi-net > .oi-hub .conn-rows[role="list"]'), 'the hub roster uses the shared list')
})

test('lockdown off: no list and no Add', async t => {
  const { view } = await mountLockdown(t, { ...LOCKDOWN, on: false, org_on: false })
  const section = view.el.querySelector('.oi-lockdown') ?? assert.fail('no lockdown section')
  assert.equal(section.querySelector('.oi-lock-list'), null)
  assert.equal([...section.querySelectorAll('button')].some(b => b.textContent === 'Add'), false)
})

test('Add opens a searchable dropdown of connected contacts not yet listed; choosing one adds it at once', async t => {
  const { view, posts } = await mountLockdown(t, LOCKDOWN)
  const add = [...view.el.querySelectorAll<HTMLButtonElement>('.oi-lockdown button')].find(b => b.textContent === 'Add') ?? assert.fail('no Add')
  await inAct(() => add.click()); await flush(4)
  const drop = view.el.querySelector('.oi-lock-add') ?? assert.fail('no dropdown')
  const options = () => [...drop.querySelectorAll<HTMLElement>('[role="option"]')]
  assert.deepEqual(options().map(o => o.dataset.address), ['alice.fixture.aa0011', 'cy.fixture.cc0033'], 'bob is listed already')
  const search = drop.querySelector<HTMLInputElement>('input[aria-label="Search contacts"]') ?? assert.fail('no search box')
  await inAct(async () => {
    const w = search.ownerDocument.defaultView!
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!.call(search, 'cy')
    search.dispatchEvent(new w.Event('input', { bubbles: true })); await flush(2)
  })
  assert.deepEqual(options().map(o => o.dataset.address), ['cy.fixture.cc0033'], 'the search filters by name or address')
  await inAct(() => options()[0].click()); await flush(4)
  assert.deepEqual(posts, [{ add: [{ hub: 'a', address: 'cy.fixture.cc0033' }] }])
  assert.equal(view.el.querySelector('.oi-lock-add'), null, 'the dropdown closes after a choice')
})

test('each hub list entry has a small red × that blocks at once; a blocked one shows the badge and unblock', async t => {
  const { view, blockPosts } = await mountLockdown(t, { ...LOCKDOWN, on: false }, ['cy.fixture.cc0033'])
  const hub = view.el.querySelector('.oi-net > .oi-hub') ?? assert.fail('no hub')
  const x = xOf(rowOf(hub, 'alice.fixture.aa0011') ?? assert.fail('no alice row')) ?? assert.fail('no × on alice')
  assert.equal(x.title, 'Block @net:alice.fixture.aa0011: no messages either way')
  assert.equal(x.textContent, '×')
  const cy = rowOf(hub, 'cy.fixture.cc0033')!
  assert.equal(xOf(cy), null, 'a blocked entry has no ×')
  assert.ok(cy.querySelector('.oi-blocked'), 'it wears the blocked badge')
  assert.deepEqual([...cy.querySelectorAll('button.link')].map(b => b.textContent), ['unblock'])
  await inAct(() => x.click()); await flush(4)
  assert.deepEqual(blockPosts, [{ address: 'alice.fixture.aa0011', blocked: true }], 'no confirm step')
  const after = rowOf(view.el.querySelector('.oi-net > .oi-hub')!, 'alice.fixture.aa0011')!
  assert.ok(after.querySelector('.oi-blocked'))
  assert.deepEqual([...after.querySelectorAll('button.link')].map(b => b.textContent), ['unblock'])
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
