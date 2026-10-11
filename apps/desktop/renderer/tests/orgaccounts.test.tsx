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

for (const scenario of ['refresh', 'save'] as const) test(`stale account read cannot overwrite a newer ${scenario}`, async () => {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket }
  const reads: ((lanes: OrgAccountLane[]) => void)[] = []
  const writes: { disabled_accounts: string[] }[] = []
  let approve!: () => void
  const sockets: Socket[] = []
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    constructor() { sockets.push(this) }
    close() { this.onclose?.() }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const epoch = `accounts-${scenario}`
  const snapshot = { type: 'app_snapshot', epoch, seq: 1,
    registry: { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'app', incarnation: epoch, rev: 1 }, records: [] },
    summaries: {}, notices: {}, runtime: { values: {}, orgs: {} } }
  const bump = async (seq: number) => inAct(async () => {
    sockets[0].frame({ type: 'app_runtime', epoch, seq,
      values: { providers: { epoch, seq, value: { revision: seq } } } })
    await flush(8)
  })
  globals.WebSocket = Socket
  globals.fetch = async (url: unknown, init?: RequestInit) => {
    if (String(url) === '/api/app/records') return new Response(JSON.stringify(snapshot))
    if (init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)))
      return new Promise<Response>(resolve => { approve = () => resolve(new Response('{"warnings":[]}')) })
    }
    return new Promise<Response>(resolve => reads.push(lanes => resolve(new Response(JSON.stringify({ accounts: lanes })))))
  }
  const view = await mount()
  try {
    await inAct(async () => { sockets[0].frame(snapshot); await flush(8) })
    await inAct(async () => { reads.at(-1)!([lane('first'), lane('second')]); await flush(8) })
    await bump(2)
    const old = reads.at(-1)!
    if (scenario === 'refresh') {
      await bump(3)
      await inAct(async () => { reads.at(-1)!([lane('first', false, false), lane('second')]); await flush(8) })
    } else {
      await click(view.el.querySelector<HTMLInputElement>('input[aria-label="first"]')!)
      const duringSave = reads.length
      await bump(3)
      assert.equal(reads.length, duringSave, 'provider refresh waits for the save instead of reading pre-commit state')
      await inAct(async () => { approve(); await flush(8) })
      await inAct(async () => { reads.at(-1)!([lane('first', false, false), lane('second')]); await flush(8) })
    }
    await inAct(async () => { old([lane('first'), lane('second')]); await flush(8) })
    const first = view.el.querySelector<HTMLInputElement>('input[aria-label="first"]')!
    assert.equal(first.checked, false, 'late GET must not restore revoked org access')
    assert.equal(first.disabled, true, 'late GET must not make a globally-off lane available')
    const before = writes.length
    await click(first)
    assert.equal(writes.length, before, 'cannot reallow globally disabled lane')
    await click(view.el.querySelector<HTMLInputElement>('input[aria-label="second"]')!)
    assert.deepEqual(writes.at(-1)?.disabled_accounts, ['langserver:first', 'langserver:second'],
      'next full allowlist write must preserve the revoked first lane')
    await inAct(async () => { approve(); await flush(8); reads.at(-1)!([lane('first', false, false), lane('second', true, false)]); await flush(8) })
  } finally { await view.unmount(); Object.assign(globals, saved) }
})
