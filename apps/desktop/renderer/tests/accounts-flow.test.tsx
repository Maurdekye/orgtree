import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountRegistrySection } from '../src/canvas/accountsregistry'

const account = (id: string, auth = 'authenticated', marks = {}, bound: object[] = []) => ({
  id, provider: 'claude', harness: 'claude-code', label: id,
  credential: { kind: 'imported', path: 'C:/fixture/' + id },
  identity: { email: id + '@example.test' }, auth, tint_ordinal: id === 'one' ? 0 : 1,
  standing: { auth, state: Object.keys(marks).length ? 'limited' : auth === 'authenticated' ? 'ready' : 'unknown', marks }, bound,
})

async function setup(t: TestContext, rows: ReturnType<typeof account>[]) {
  const oldFetch = globalThis.fetch
  const calls: { url: string; method: string; body: string }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: String(init?.body || '') })
    return new Response(JSON.stringify({ accounts: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(<AccountRegistrySection toast={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch })
  await inAct(async () => { await flush() })
  return { el: view.el, calls }
}

test('account rows distinguish unknown authentication from ready accounts', async t => {
  const { el } = await setup(t, [account('one', 'unknown'), account('two')])
  const rows = el.querySelectorAll('.account-row')
  assert.equal(rows.length, 2)
  const saysReady = (row: Element) => [...row.querySelectorAll('span')].some(span => span.textContent?.trim() === 'ready')
  assert.equal(saysReady(rows[0]), false)
  assert.match(rows[0].textContent || '', /unknown|sign in|unauthenticated/i)
  assert.equal(saysReady(rows[1]), true)
})

test('inferred limits stay identified and bound accounts cannot be removed', async t => {
  const { el, calls } = await setup(t, [
    account('one', 'authenticated', { fable: { until: 2000000000, provenance: 'inferred' } }, [{ org: 'mine', node: 'worker' }]),
    account('two'),
  ])
  const rows = el.querySelectorAll<HTMLElement>('.account-row')
  assert.match(rows[0].textContent || '', /inferred/i)
  const remove = (row: HTMLElement) => [...row.querySelectorAll('button')].find(b => /remove/i.test(b.textContent || ''))!
  assert.equal(remove(rows[0]).disabled, true)
  assert.equal(remove(rows[1]).disabled, false)
  await inAct(async () => { remove(rows[0]).click(); remove(rows[1]).click(); await flush() })
  assert.deepEqual(calls.filter(c => c.method === 'DELETE').map(c => c.url), ['/api/accounts/two'])
})

test('creating a managed account uses the selected provider and no imported path', async t => {
  const { el, calls } = await setup(t, [])
  const button = [...el.querySelectorAll('button')].find(b => /create managed/i.test(b.textContent || ''))!
  assert.ok(button)
  await inAct(async () => { button.click(); await flush() })
  const create = calls.find(c => c.method === 'POST')
  assert.ok(create)
  assert.equal(create.url, '/api/accounts')
  assert.deepEqual(JSON.parse(create.body), { provider: 'claude', kind: 'managed' })
})


test('usage opens for the selected account without polling every collapsed row', async t => {
  const { el, calls } = await setup(t, [account('one'), account('two')])
  assert.equal(calls.some(c => c.url.endsWith('/usage')), false)
  const detail = el.querySelectorAll('details')[1]!
  await inAct(async () => { detail.open = true; detail.dispatchEvent(new Event('toggle')); await flush() })
  assert.ok(calls.some(c => c.url === '/api/accounts/two/usage'))
  assert.equal(calls.some(c => c.url === '/api/accounts/one/usage'), false)
})
