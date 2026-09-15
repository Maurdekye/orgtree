import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { AccountsPanel } from '../src/canvas/accounts'
import { AddHub } from '../src/canvas/connections'
import type { AccountsPayload, ProvidersPayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>
const HUB_CONFIG = {
  version: 2, port: 7370, bind: '127.0.0.1', name: 'desk', retention_days: null,
  org_retention_days: 45, public_listener: false, public_listener_port: 7371,
  status: { running: true, healthy: true, address: 'http://127.0.0.1:7370', exposed: false, hub_name: 'desk', orgs: 1, queued: 0 },
}
const ACCOUNTS: AccountsPayload = { version: 2, primary: { id: 'primary', signed_in: true, email: 'me@example.test' }, keys: [], assignments: {} } as unknown as AccountsPayload
const PROVIDERS: ProvidersPayload = { providers: [] }

async function type(field: HTMLInputElement, value: string) {
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('Mail hub settings are compact and contain no authentication controls', async () => {
  const seen: string[] = []
  g.fetch = async (input: unknown) => {
    const url = String(input); seen.push(url)
    const body = url === '/api/desktop/hub' ? HUB_CONFIG
      : url.startsWith('/api/accounts') ? ACCOUNTS
      : url.startsWith('/api/providers') ? PROVIDERS
      : url.startsWith('/api/runtime-settings') ? { warming_enabled: true } : {}
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  }
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  try {
    await inAct(async () => { await flush(8) })
    const tab = [...view.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.trim() === 'Mail hub')!
    await inAct(async () => { tab.click(); await flush(8) })
    const text = view.el.querySelector('.host-hub')!.textContent!
    assert.match(text, /Mail hub.*Running/s)
    for (const retired of ['credential', 'invitation', 'allowed to connect', 'revoke access', 'token', 'key']) {
      assert.doesNotMatch(text.toLowerCase(), new RegExp(retired), `${retired} is not in the compact surface`)
    }
    assert.equal(view.el.querySelector('.hub-peers'), null)
    assert.ok(seen.includes('/api/desktop/hub'))
    assert.ok(!seen.some(url => url.includes('/hub/peers')))
  } finally { await view.unmount(); delete g.fetch }
})

test('adding a hub is one address field; the reachability test reports without gating', async () => {
  const probes: string[] = []
  g.fetch = async (input: unknown) => {
    probes.push(String(input))
    return new Response(JSON.stringify({ ok: true, name: 'office' }), { headers: { 'Content-Type': 'application/json' } })
  }
  const patches: unknown[] = []
  function Fixture() {
    const [address, setAddress] = useState('https://hub.example')
    return <AddHub slug="org" address={address} setAddress={setAddress} toast={() => {}}
      current={[{ id: 'r1', address: 'http://old.example:7370', enabled: true }]} busy={false}
      apply={async patch => { patches.push(patch); return true }} />
  }
  const view = await mountView(<Fixture />, el => el)
  try {
    assert.equal(view.el.querySelectorAll('form input').length, 1)
    await inAct(async () => {
      const buttons = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      buttons.find(b => b.textContent === 'Test')!.click(); await flush(8)
    })
    assert.ok(probes.some(u => String(u).includes('/api/net/probe?address=')))
    assert.match(view.el.querySelector('[role="status"]')!.textContent!, /Reachable — office/)
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await flush(8) })
    // the existing list rides along untouched; the new entry is appended
    assert.deepEqual(patches, [{ net_hubs: [
      { id: 'r1', address: 'http://old.example:7370', enabled: true },
      { address: 'https://hub.example', enabled: true },
    ] }])
  } finally { await view.unmount(); delete g.fetch }
})
