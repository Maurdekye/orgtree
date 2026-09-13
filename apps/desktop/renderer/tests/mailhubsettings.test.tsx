import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { AccountsPanel } from '../src/canvas/accounts'
import { ConnectHub } from '../src/canvas/connections'
import type { AccountsPayload, ProvidersPayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>
const HUB_CONFIG = {
  version: 1, enabled: true, bind_host: '127.0.0.1', port: 7370,
  advertise_host: 'mail.example', tls_configured: false,
  status: { ready: true, port: 7370, address: 'http://mail.example:7370', public: false },
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

test('address-only connection submits one field and preserves validation and errors', async () => {
  const sent: unknown[] = []
  g.fetch = async (_input: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    return new Response('hub unavailable', { status: 502 })
  }
  function Fixture() {
    const [address, setAddress] = useState('https://hub.example')
    return <ConnectHub slug="org" address={address} setAddress={setAddress} toast={() => {}} />
  }
  const view = await mountView(<Fixture />, el => el)
  try {
    const input = view.el.querySelector<HTMLInputElement>('input[required]')!
    assert.equal(view.el.querySelectorAll('form input').length, 1)
    await type(input, 'https://hub.example')
    await inAct(async () => { view.el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await flush(8) })
    assert.deepEqual(sent, [{ address: 'https://hub.example' }])
    assert.match(view.el.querySelector('[role="alert"]')!.textContent!, /502|hub unavailable/)
  } finally { await view.unmount(); delete g.fetch }
})
