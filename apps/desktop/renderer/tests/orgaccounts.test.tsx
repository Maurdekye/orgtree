import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgAccountsTab } from '../src/orgaccounts'
import type { OrgAccountLane } from '../src/types'

const g = globalThis as unknown as { fetch?: typeof fetch }
function fixture(lanes: OrgAccountLane[], fail = false) {
  const writes: { url: string; body: { disabled_accounts: string[] } }[] = []
  g.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      writes.push({ url: String(url), body })
      if (fail) throw new Error('synthetic refusal')
      lanes.forEach(l => { l.allowed = !body.disabled_accounts.includes(l.id) })
    }
    return new Response(JSON.stringify(init?.method === 'POST' ? { warnings: [] } : { accounts: lanes }),
      { headers: { 'Content-Type': 'application/json' } })
  }
  return writes
}
const lane = (id: string, enabled = true, allowed = true): OrgAccountLane => ({
  id: `langserver:${id}`, provider: 'langserver', label: id, enabled, allowed,
  disabled_reason: enabled ? null : 'this server is off in App settings',
})
const click = async (el: HTMLInputElement) => inAct(async () => { el.click(); await flush(8) })
const mount = async (toasts: string[][] = []) => {
  const view = await mountView(<OrgAccountsTab slug="fixture" toast={t => toasts.push(t)} />, e => e)
  await inAct(async () => { await flush(8) })
  return view
}

test('org server switches preserve other denied lanes and only update this org access', async () => {
  const lanes = [lane('first'), lane('second'), { id: 'openrouter', label: 'Key', provider: 'openrouter', allowed: false }]
  const writes = fixture(lanes)
  const view = await mount()
  try {
    const toggle = (name: string) => view.el.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
    await click(toggle('first'))
    assert.deepEqual(writes[0], { url: '/api/orgs/fixture/settings', body: { disabled_accounts: ['langserver:first', 'openrouter'] } })
    assert.equal(toggle('first').checked, false)
    assert.equal(toggle('second').checked, true)
    assert.equal(lanes[0].enabled, true, 'org switch does not disable the global server')
    await click(toggle('first'))
    assert.deepEqual(writes[1].body, { disabled_accounts: ['openrouter'] })
    assert.equal(toggle('first').checked, true)
  } finally { await view.unmount(); delete g.fetch }
})

test('globally disabled server or key cannot be enabled by an org; existing access may still be revoked', async () => {
  const lanes = [lane('off', false, false), lane('previously allowed', false),
    { ...lane('key', false, false), id: 'openrouter-2', provider: 'openrouter' }]
  const writes = fixture(lanes)
  const view = await mount()
  try {
    const off = view.el.querySelector<HTMLInputElement>('input[aria-label="off"]')!
    assert.equal(off.disabled, true)
    assert.equal(view.el.querySelector<HTMLInputElement>('input[aria-label="key"]')!.disabled, true)
    assert.ok(view.el.textContent?.includes('this server is off in App settings'))
    await click(off)
    assert.equal(writes.length, 0)
    const revoke = view.el.querySelector<HTMLInputElement>('input[aria-label="previously allowed"]')!
    assert.equal(revoke.disabled, false)
    await click(revoke)
    assert.equal(revoke.checked, false)
    assert.equal(revoke.disabled, true)
    assert.deepEqual(writes[0].body.disabled_accounts, ['langserver:off', 'langserver:previously allowed', 'openrouter-2'])
  } finally { await view.unmount(); delete g.fetch }
})

test('older lane payloads retain org switches; rejected save does not change the checkbox', async () => {
  const writes = fixture([{ id: 'langserver:legacy', provider: 'langserver', label: 'Legacy', allowed: true }], true)
  const toasts: string[][] = []
  const view = await mount(toasts)
  try {
    const toggle = view.el.querySelector<HTMLInputElement>('input')!
    assert.equal(toggle.disabled, false)
    await click(toggle)
    assert.equal(writes.length, 1)
    assert.equal(toggle.checked, true)
    assert.ok(toasts.flat().some(t => t.includes('synthetic refusal')))
  } finally { await view.unmount(); delete g.fetch }
})
