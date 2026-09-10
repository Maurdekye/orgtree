import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { clearProviderDiscovery, getProviders, peekProviders, setProviderEnabled } from '../src/api'
import { AccountsPanel } from '../src/canvas/accounts'
import type { ProvidersPayload } from '../src/types'

const payload = (label: string): ProvidersPayload => ({ providers: [{
  id: 'claude', label, cli: 'Claude Code', tiers: [], hire_enabled: true,
  status: { installed: true, connected: true },
}] } as ProvidersPayload)
const response = (body: unknown) => ({ ok: true, headers: new Headers(), json: async () => body }) as Response

test('discovery shares an in-flight read, retains its snapshot, and retries errors', async () => {
  clearProviderDiscovery()
  const old = globalThis.fetch
  let finish!: (value: Response) => void
  let calls = 0
  globalThis.fetch = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  try {
    const first = getProviders(), second = getProviders()
    assert.equal(calls, 1)
    assert.equal(first, second)
    assert.equal(peekProviders(), null)
    finish(response(payload('First')))
    await first
    assert.equal(peekProviders()?.providers[0].label, 'First')
    globalThis.fetch = async () => { calls++; throw new Error('offline') }
    await assert.rejects(getProviders(), /offline/)
    assert.equal(peekProviders()?.providers[0].label, 'First')
    globalThis.fetch = async () => { calls++; return response(payload('Fresh')) }
    await getProviders()
    assert.equal(peekProviders()?.providers[0].label, 'Fresh')
    assert.equal(calls, 3)
  } finally { globalThis.fetch = old; clearProviderDiscovery() }
})

test('a preference write cannot be overwritten by an older discovery response', async () => {
  clearProviderDiscovery()
  const old = globalThis.fetch
  let finish!: (value: Response) => void
  globalThis.fetch = (_url, init) => init?.method === 'PUT'
    ? Promise.resolve(response(payload('Changed')))
    : new Promise(resolve => { finish = resolve })
  try {
    const stale = getProviders()
    await setProviderEnabled('claude', false)
    finish(response(payload('Old')))
    assert.equal((await stale).providers[0].label, 'Changed')
    assert.equal(peekProviders()?.providers[0].label, 'Changed')
  } finally { globalThis.fetch = old; clearProviderDiscovery() }
})

test('Settings displays the last discovery before its slow refresh completes', async () => {
  clearProviderDiscovery()
  const old = globalThis.fetch
  globalThis.fetch = async () => response(payload('Previously found'))
  await getProviders()
  let finish!: (value: Response) => void
  globalThis.fetch = url => String(url) === '/api/providers'
    ? new Promise(resolve => { finish = resolve })
    : Promise.resolve(response(String(url).includes('/accounts') ? { accounts: [], aliases: {} } : {}))
  const view = await mountView(<AccountsPanel close={() => {}} toast={() => {}} />, el => el)
  try {
    assert.match(view.el.textContent!, /Previously found/)
    assert.match(view.el.textContent!, /Showing the last result/)
    await inAct(async () => { finish(response(payload('New result'))); await flush(8) })
    assert.match(view.el.textContent!, /New result/)
    assert.doesNotMatch(view.el.textContent!, /Showing the last result/)
  } finally { await view.unmount(); globalThis.fetch = old; clearProviderDiscovery() }
})
