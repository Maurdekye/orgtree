// Ownership of the mail hub settings.
//
// One installation hosts at most one mail hub. Hosting it and deciding which
// organizations may connect to it therefore belong to App settings; an
// organization's Connections tab keeps only that organization's own address
// and its outgoing connections. These drive the real components, because the
// whole defect being fixed was WHERE a control is rendered — a check that
// reads a module export would pass with the control still in the wrong panel.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import { Connections } from '../src/canvas/connections'
import type { AccountsPayload, ProvidersPayload, TreePayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>

const HUB_CONFIG = {
  version: 1, enabled: true, bind_host: '127.0.0.1', port: 7370,
  advertise_host: 'mail.example', tls_configured: false,
  status: { ready: true, port: 7370, address: 'http://mail.example:7370', public: false },
}
const PEERS = {
  version: 1, address: 'http://mail.example:7370', peers: [
    { peer_id: 'grant-a', slug: 'research.user.a3f9c1', created_at: '2026-09-01T00:00:00Z', revoked_at: null, allowed: true },
    { peer_id: 'grant-b', slug: 'office.user.b7c2d4', created_at: '2026-09-02T00:00:00Z', revoked_at: '2026-09-03T00:00:00Z', allowed: false },
  ],
}
const ACCOUNTS: AccountsPayload = {
  version: 2, primary: { id: 'primary', signed_in: true, email: 'me@example.test' },
  keys: [], assignments: {},
} as unknown as AccountsPayload
const PROVIDERS: ProvidersPayload = { providers: [] }

interface Seen { method: string; url: string; body: unknown }

/** Answers exactly the routes App settings reaches, and records every one, so
 *  a request carrying an organization slug is visible rather than silently
 *  served. */
function stubFetch(seen: Seen[], peers: typeof PEERS = PEERS) {
  g.fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    const json = (value: unknown) => new Response(JSON.stringify(value),
      { headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/desktop/hub') return json(HUB_CONFIG)
    if (url === '/api/desktop/hub/peers' && method === 'GET') return json(peers)
    if (url === '/api/desktop/hub/peers' && method === 'POST') {
      return json({ version: 1, address: peers.address, peer_id: 'grant-c', slug: 'new.user.c1',
        peer_slug: 'new.user.c1', peer_token: 'issued-secret-token', one_time: true })
    }
    if (url.endsWith('/replace')) {
      return json({ version: 1, address: peers.address, peer_id: 'grant-a', slug: 'research.user.a3f9c1',
        peer_slug: 'research.user.a3f9c1', peer_token: 'replacement-secret-token', one_time: true })
    }
    if (url.startsWith('/api/desktop/hub/peers/') && method === 'DELETE') {
      return json({ revoked: true, peer_id: url.split('/').pop() })
    }
    if (url.startsWith('/api/accounts')) return json(ACCOUNTS)
    if (url.startsWith('/api/providers')) return json(PROVIDERS)
    if (url.startsWith('/api/runtime-settings')) return json({ warming_enabled: true })
    return json({})
  }
}

const openMailHub = async (el: HTMLElement) => {
  const tab = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(b => b.textContent?.trim() === 'Mail hub')
  assert.ok(tab, 'App settings offers a Mail hub tab')
  await inAct(async () => { tab.click(); await flush(8) })
}

const tree = (slug: string, hub: string): TreePayload => ({
  slug, net: {
    slug: `${slug}.user.aaaaaa`,
    hubs: [{ id: hub, address: `https://${hub}.example`, name: hub, enabled: true, connected: true, queued: 0, roster: [] }],
  },
} as unknown as TreePayload)

test('App settings owns installation-wide hosting and grants, and asks for them with no organization in the request', async () => {
  localStorage.clear()
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.ok(!seen.some(r => r.url.startsWith('/api/desktop/hub')),
      'an unopened Mail hub tab fetches no hub state')

    await openMailHub(view.el)
    const text = view.el.textContent!
    assert.match(text, /Host this installation's mail hub/)
    assert.ok(view.el.querySelector('[aria-label="Enable mail hub"]'), 'hosting controls are here')
    assert.ok(view.el.querySelector('[aria-label="Advertised mail hub host"]'))
    assert.ok(view.el.querySelector('[aria-label="TLS certificate file"]') === null,
      'TLS paths stay hidden until network hosting is selected')
    assert.match(text, /research\.user\.a3f9c1.*Allowed/s, 'the allowed-organization list is here')
    assert.match(text, /office\.user\.b7c2d4.*Revoked/s, 'a revoked grant is still listed, as revoked')

    // The whole point of the move: nothing here is scoped to an organization.
    const hubCalls = seen.filter(r => r.url.startsWith('/api/desktop/hub'))
    assert.ok(hubCalls.length >= 2, 'hosting config and grants are both fetched')
    assert.ok(seen.every(r => !r.url.startsWith('/api/orgs/')),
      'App settings reaches no per-organization route')
  } finally { await view.unmount(); delete g.fetch }
})

test('revoking and replacing a grant uses the installation route and reloads the list', async () => {
  localStorage.clear()
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    await openMailHub(view.el)
    const rows = [...view.el.querySelectorAll('.hub-peer-row')]
    assert.equal(rows.length, 2)
    const button = (row: Element, label: string) =>
      [...row.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!

    assert.equal(button(rows[1]!, 'Revoke access').disabled, true,
      'an already revoked grant cannot be revoked again')

    await inAct(async () => { button(rows[0]!, 'Revoke access').click(); await flush(8) })
    const revoke = seen.find(r => r.method === 'DELETE')!
    assert.equal(revoke.url, '/api/desktop/hub/peers/grant-a')
    assert.equal(seen.filter(r => r.url === '/api/desktop/hub/peers' && r.method === 'GET').length, 2,
      'the list is re-read so the shown state is the hub\'s, not the click\'s')

    await inAct(async () => { button(rows[0]!, 'Replace credential').click(); await flush(8) })
    const replace = seen.find(r => r.url.endsWith('/replace'))!
    assert.equal(replace.method, 'POST')
    assert.equal(replace.url, '/api/desktop/hub/peers/grant-a/replace')
    const shown = view.el.querySelector<HTMLTextAreaElement>('textarea[aria-label="New connection credential"]')!
    assert.ok(shown, 'the replacement details are shown once, here')
    assert.match(shown.value, /replacement-secret-token/)
    await inAct(async () => {
      [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Hide credential')!.click()
    })
    assert.equal(view.el.querySelector('textarea[aria-label="New connection credential"]'), null)
  } finally { await view.unmount(); delete g.fetch }
})

test('issuing a grant names the organization being allowed, not the organization that is open', async () => {
  localStorage.clear()
  const seen: Seen[] = []
  stubFetch(seen)
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    await openMailHub(view.el)
    const set = async (label: string, value: string) => {
      const field = view.el.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
      await inAct(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const create = () => [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent === 'Create credential')!
    assert.equal(create().disabled, true, 'both fields are required')
    await set('Credential ID', 'grant-c')
    await set('Allowed organization address', 'new.user.c1')
    assert.equal(create().disabled, false)
    await inAct(async () => { create().click(); await flush(8) })
    const issue = seen.find(r => r.url === '/api/desktop/hub/peers' && r.method === 'POST')!
    assert.deepEqual(issue.body, { peer_id: 'grant-c', slug: 'new.user.c1' })
    assert.match(view.el.querySelector<HTMLTextAreaElement>('textarea[aria-label="New connection credential"]')!.value,
      /issued-secret-token/)
  } finally { await view.unmount(); delete g.fetch }
})

test('an organization\'s Connections tab holds only that organization, and changing organization changes nothing installation-wide', async () => {
  localStorage.clear()
  const seen: Seen[] = []
  stubFetch(seen)
  const first = await mountView(
    <Connections tree={tree('research', 'office')} toast={() => {}} adding="" setAdding={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const text = first.el.textContent!
    assert.match(text, /research\.user\.aaaaaa/, "the organization's own address is here")
    assert.match(text, /Copy address/)
    assert.match(text, /Connect this organization to a hub/)
    assert.doesNotMatch(text, /Host this installation's mail hub|Enable mail hub|Organizations allowed to connect/,
      'no installation-wide hosting or grant control is rendered per organization')
    assert.equal(first.el.querySelector('.host-hub'), null)
    assert.equal(first.el.querySelector('.hub-peers'), null)
    assert.equal(first.el.querySelector('[aria-label="Advertised mail hub host"]'), null)
    assert.ok(seen.every(r => !r.url.startsWith('/api/desktop/hub')),
      'opening an organization does not read or write installation hub configuration')
  } finally { await first.unmount() }

  const second = await mountView(
    <Connections tree={tree('office', 'partner')} toast={() => {}} adding="" setAdding={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    assert.match(second.el.textContent!, /office\.user\.aaaaaa/)
    assert.match(second.el.textContent!, /partner\.example/)
    assert.doesNotMatch(second.el.textContent!, /office\.example/,
      "a second organization shows its own connections, not the first organization's")
    assert.ok(seen.every(r => !r.url.startsWith('/api/desktop/hub')),
      'switching organization still touches no installation-wide hub state')
  } finally { await second.unmount(); delete g.fetch }
})
