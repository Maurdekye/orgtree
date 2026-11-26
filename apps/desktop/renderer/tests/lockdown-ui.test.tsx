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
  assert.match(section, /Lockdown/); assert.match(section, /Org decides/); assert.match(section, /2 refused/)
  // point 13 (USER 2026-11-26 10:46:43Z md10751788f2e "this ui is ugly, clean it up"): plain-word hub lines
  assert.match(view.el.querySelector('.oi-lockdown .lk-hub')?.textContent ?? '', /Fixture hub.*enforcing/)
  // LIST UX REDESIGN (USER 2026-11-25 21:48:05Z m6f4d40461dde): no allow/unlist links in the hub lists, only the block ×
  for (const who of ['@net:alice.', '@net:bob.']) {
    assert.deepEqual([...row(who).querySelectorAll('button')].filter(b => !b.matches('[data-hub-address]')).map(b => b.className), ['conn-x block'])
  }
  assert.equal(posts.length, 0)
})

// LIST UX REDESIGN (USER 2026-11-25 21:48:05Z m6f4d40461dde "make it a list you edit under lockdown that appears only
// when lockdown is enabled ... should look like the connected list underneath mailhubs"; 21:49:37Z m8ee22829e340 "use
// the same list for each hub, and add a small red cancel button by each entry to manually block them"; 21:50:37Z
// m706c3054c21d the × is part of the general list component; 21:51:09Z md60a3e7803d1 "the allowlist add opens a
// dropdown with searchable names").
const mountLockdown = async (t: { after: (f: () => void) => void }, lockdown: unknown, blocked: string[] = [], setAside: unknown = null) => {
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
    if (url.includes('/net/lockdown/set-aside') && setAside) return ok(setAside)
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

// point 13 (USER 2026-11-26 10:46:43Z md10751788f2e "this ui is ugly, clean it up"): one tidy section: a header with a
// state chip and the action inline, plain-word hub lines, "Allowed addresses" with Add beside it, the empty state
// inside the list frame, set-aside as a settings toggle and "Show set-aside mail (N)" only when there is some.
test('the lockdown section: header chip with the action inline, Allowed addresses with Add, empty state in the frame', async t => {
  const { view, posts } = await mountLockdown(t, { ...LOCKDOWN, allow: [], hubs: [{ ...LOCKDOWN.hubs[0], state: 'pending' }] })
  const section = view.el.querySelector('.oi-lockdown') ?? assert.fail('no lockdown section')
  const head = section.querySelector('.lk-head') ?? assert.fail('no header line')
  assert.match(head.querySelector('.lk-chip')?.textContent ?? '', /^On · Org decides · set by @front$/)
  const act = [...head.querySelectorAll('button')].find(b => b.textContent === 'Lift lockdown') ?? assert.fail('no inline Lift lockdown')
  assert.match(section.querySelector('.lk-hub')?.textContent ?? '', /Fixture hub.*waiting for the hub/)
  const listHead = section.querySelector('.oi-lock-list-head') ?? assert.fail('no list head')
  assert.match(listHead.textContent ?? '', /^Allowed addresses/)
  assert.ok([...listHead.querySelectorAll('button')].some(b => b.textContent === 'Add'), 'Add beside the sub-header')
  assert.equal(section.querySelector('.lk-frame .lk-empty')?.textContent, 'Nobody outside yet; organizations on this computer can still reach the org')
  const toggle = section.querySelector<HTMLInputElement>('input[role="switch"][aria-label="Set aside mail from unlisted addresses"]') ?? assert.fail('no set-aside toggle')
  assert.equal([...section.querySelectorAll('button')].some(b => /set-aside mail/i.test(b.textContent ?? '')), false, 'no set-aside mail: no button')
  await inAct(() => toggle.click()); await flush(4)
  await inAct(() => act.click()); await flush(4)
  assert.deepEqual(posts, [{ set_aside: true }, { on: false }])
})

test('Show set-aside mail (N) appears only when some is set aside', async t => {
  const { view } = await mountLockdown(t, LOCKDOWN, [], { set_aside: [], total: 2, unread: 1, top_senders: [], next_before: null })
  const b = [...view.el.querySelectorAll<HTMLButtonElement>('.oi-lockdown button')].find(x => x.textContent === 'Show set-aside mail (2)')
  assert.ok(b, 'the button names how many')
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
  // point 14 as corrected on alpha.8 (USER via @coordinator-opus m2d6e12a94c56 "it should look like the red cancel symbol
  // shown for agent statuses when theyve blocked you"): the blocked status sign itself, no Cancel icon, no text ×
  assert.ok(x.querySelector('svg[data-testid="BlockIcon"].oi-blocked'), 'the block control is the blocked status sign')
  assert.equal(x.querySelector('svg[data-testid="CancelIcon"]'), null)
  assert.equal(x.textContent, '')
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

// THE LIST IN SETTINGS (USER 2026-11-26 10:45:12Z m6717cf33b536 "i do not see an searchable contact list for lockdown
// next to the dropdown to enable it"; docket points 10-12): the same list and searchable Add sit directly under the
// Lockdown dropdown in org settings as soon as lockdown is in force, and follow the dropdown at once.
const mountSettingsLockdown = async (t: { after: (f: () => void) => void }, initial: typeof LOCKDOWN) => {
  const original = globalThis.fetch
  const posts: unknown[] = []
  let current = initial
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/net/lockdown')) {
      if (init?.method === 'POST') {
        const c = JSON.parse(String(init.body)) as { setting?: 'org' | 'on' | 'off'; add?: typeof LOCKDOWN.allow }
        posts.push(c)
        if (c.setting) current = { ...current, setting: c.setting, on: c.setting === 'on' || (c.setting === 'org' && current.org_on) }
        if (c.add) current = { ...current, allow: [...current.allow, ...c.add.map(a => ({ ...a, hub_name: 'Fixture hub', added_by: '@user', at: '2026-11-26T11:00:00Z' }))] }
      }
      return new Response(JSON.stringify(current), { status: 200 })
    }
    if (url.endsWith('/net/blocks')) return new Response(JSON.stringify({ blocked: [], blocked_by: [] }), { status: 200 })
    return new Response(JSON.stringify(orgDndResponse(url)), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  const summary = { setting: initial.setting, on: initial.on, coverage: initial.on ? 'enforced' : 'off', set_aside: false, set_aside_unread: 0 }
  const tree = { ...orgDndTree, net: NET, org_inbox: { ...orgDndTree.org_inbox, lockdown: summary } } as unknown as TreePayload
  const view = await mountView(<SettingsPanel tree={tree} initialTab="mailserver" toast={() => {}} close={() => {}} />, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(8) })
  return { view, posts }
}
const settingsList = (root: Element) => root.querySelector('.org-lockdown-list .oi-lock-list')
const pickLock = async (root: Element, value: string) => {
  const lock = root.querySelector<HTMLSelectElement>('select[aria-label="Org mailbox lockdown"]')!
  await inAct(async () => {
    const w = lock.ownerDocument.defaultView!
    Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')!.set!.call(lock, value)
    lock.dispatchEvent(new w.Event('change', { bubbles: true })); await flush(6)
  })
}

test('settings: Lockdown On shows the list under the dropdown with a searchable Add; choosing adds at once', async t => {
  const { view, posts } = await mountSettingsLockdown(t, { ...LOCKDOWN, setting: 'on', on: true, org_on: false })
  const list = settingsList(view.el) ?? assert.fail('no lockdown list under the Lockdown dropdown')
  assert.ok(list.querySelector('.conn-rows[role="list"]'), 'the shared list component')
  assert.deepEqual([...list.querySelectorAll('.conn-row [data-hub-address]')].map(c => c.getAttribute('data-hub-address')), ['@net:bob.fixture.bb0022'])
  assert.equal(xOf(rowOf(list, 'bob.fixture.bb0022')!)?.title, 'Take @net:bob.fixture.bb0022 off the lockdown list')
  const add = [...list.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Add') ?? assert.fail('no Add')
  await inAct(() => add.click()); await flush(4)
  const drop = list.querySelector('.oi-lock-add') ?? assert.fail('no dropdown')
  const search = drop.querySelector<HTMLInputElement>('input[aria-label="Search contacts"]') ?? assert.fail('no search box')
  await inAct(async () => {
    const w = search.ownerDocument.defaultView!
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!.call(search, 'ali')
    search.dispatchEvent(new w.Event('input', { bubbles: true })); await flush(2)
  })
  const options = [...drop.querySelectorAll<HTMLElement>('[role="option"]')]
  assert.deepEqual(options.map(o => o.dataset.address), ['alice.fixture.aa0011'])
  await inAct(() => options[0].click()); await flush(6)
  assert.deepEqual(posts, [{ add: [{ hub: 'a', address: 'alice.fixture.aa0011' }] }])
  assert.deepEqual([...settingsList(view.el)!.querySelectorAll('.conn-row [data-hub-address]')].map(c => c.getAttribute('data-hub-address')).sort(),
    ['@net:alice.fixture.aa0011', '@net:bob.fixture.bb0022'], 'the list shows the added contact at once')
  assert.doesNotMatch(view.el.querySelector('#org-lockdown-actual')?.parentElement?.textContent ?? '', /mailservers tab/, 'the hint points below, not to the tab')
})

test('settings: Lockdown Off shows no list; Org decides while the org has it off shows none either', async t => {
  const { view } = await mountSettingsLockdown(t, { ...LOCKDOWN, setting: 'off', on: false, org_on: false })
  assert.equal(settingsList(view.el), null)
  await pickLock(view.el, 'org')
  assert.equal(settingsList(view.el), null, 'Org decides with the org off: not in force')
})

test('settings: switching Lockdown to On shows the list without a reload, and Off hides it again', async t => {
  const { view, posts } = await mountSettingsLockdown(t, { ...LOCKDOWN, setting: 'org', on: false, org_on: false })
  assert.equal(settingsList(view.el), null)
  await pickLock(view.el, 'on')
  assert.deepEqual(posts, [{ setting: 'on' }])
  assert.ok(settingsList(view.el), 'the list appears as soon as On is chosen')
  await pickLock(view.el, 'off')
  assert.equal(settingsList(view.el), null, 'and goes with Off')
})
