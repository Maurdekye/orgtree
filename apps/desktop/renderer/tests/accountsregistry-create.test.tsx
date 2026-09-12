import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'

const account = (id: string, provider = 'claude', auth = 'authenticated') => ({
  id, provider, label: id, credential: { kind: 'managed', path: 'C:/fixture/' + id },
  identity: { email: id + '@example.test' }, auth, tint_ordinal: 1,
  standing: { auth, state: 'ready', marks: { fable: { until: 2000000000, provenance: 'observed' } } }, bound: [],
})
async function setup(t: TestContext, initial = [account('existing-claude'), account('existing-codex', 'openai')]) {
  const oldFetch = globalThis.fetch
  const calls: { url: string; method: string; body: string }[] = []
  const notices: string[][] = []
  const state = { rows: initial, alien: false, failPost: false, closed: false }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    calls.push({ url: String(url), method, body: String(init?.body || '') })
    let body: unknown = {}
    if (String(url).endsWith('/providers')) body = { providers: ['claude', 'openai', 'google'].map((id,i) => ({
      id, label: ['Claude', 'Codex', 'Antigravity'][i], cli: id, status: { installed: true, connected: true }, tiers: [], hire_enabled: true,
    })) }
    else if (String(url).endsWith('/identity')) body = { auth: 'unauthenticated' }
    else if (method === 'POST') {
      if (state.failPost) return new Response(JSON.stringify({ detail: 'Folder does not exist' }), { status: 422 })
      const input = JSON.parse(String(init?.body))
      const row = account('new-' + input.provider, input.provider, 'unauthenticated')
      state.rows.push(row); body = row
    } else if (String(url) === '/api/accounts') body = state.alien ? {} : { accounts: state.rows }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }), getPreferences: async () => ({}), onEvent: () => () => {} }
  const view = await mountView(<AccountsPanel toast={lines => { notices.push(lines) }} close={() => { state.closed = true }} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; delete desk.orgtreeDesktop })
  await inAct(async () => { await flush() })
  return { view, state, calls, notices }
}
const button = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find(b => b.textContent === label)!
const lane = (provider: string) => document.querySelector('.prov-' + provider)!.closest('.acct-provider-group')!
const dialog = () => document.querySelector<HTMLElement>('.add-account-dialog')!
async function open(provider: string) {
  await inAct(async () => { button(lane(provider), 'Add secondary account').click(); await flush() })
  assert.ok(dialog())
}
async function input(value: string) {
  const field = dialog().querySelector<HTMLInputElement>('input')!
  await inAct(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('three provider headers own add controls and account rows, with one registry read and no usage', async t => {
  const { calls } = await setup(t)
  assert.equal(document.querySelectorAll('.acct-provider-head button:not(.set-toggle)').length >= 3, true)
  for (const provider of ['claude', 'openai', 'google']) assert.ok(button(lane(provider), 'Add secondary account'))
  assert.equal(lane('claude').querySelectorAll('.account-row').length, 1)
  assert.match(lane('claude').textContent!, /existing-claude/)
  assert.doesNotMatch(lane('claude').textContent!, /existing-codex/)
  assert.match(lane('openai').textContent!, /existing-codex/)
  assert.equal(calls.filter(c => c.url === '/api/accounts').length, 1)
  assert.equal(calls.some(c => c.url.endsWith('/usage')), false)
  assert.equal(document.querySelector('.provider-accounts details'), null)
})

test('creating a managed Codex account renders in Codex with sign-in and closes only its dialog', async t => {
  const { state, calls } = await setup(t)
  await open('openai')
  await inAct(async () => { button(dialog(), 'Create managed account').click(); await flush() })
  assert.deepEqual(JSON.parse(calls.find(c => c.method === 'POST')!.body), { provider: 'openai', kind: 'managed' })
  assert.equal(dialog(), null)
  assert.equal(state.closed, false)
  const row = [...lane('openai').querySelectorAll('.account-row')].find(r => r.textContent?.includes('new-openai'))!
  assert.ok(row)
  assert.ok(button(row, 'Sign in'))
  assert.doesNotMatch(lane('claude').textContent!, /new-openai/)
})

test('folder import retains input on failure and creates its row in the selected provider on retry', async t => {
  const { state, calls } = await setup(t)
  await open('claude')
  assert.equal(button(dialog(), 'Import folder').disabled, true)
  await input('  C:/existing-profile  ')
  state.failPost = true
  await inAct(async () => { button(dialog(), 'Import folder').click(); await flush() })
  assert.match(dialog().textContent!, /Folder does not exist/)
  assert.equal(dialog().querySelector('input')!.value, '  C:/existing-profile  ')
  state.failPost = false
  await inAct(async () => { button(dialog(), 'Import folder').click(); await flush() })
  assert.deepEqual(JSON.parse(calls.filter(c => c.method === 'POST').at(-1)!.body), { provider: 'claude', kind: 'imported', path: 'C:/existing-profile' })
  assert.equal(dialog(), null)
  assert.match(lane('claude').textContent!, /new-claude/)
})

test('Escape closes the add dialog without closing settings; changing providers starts with an empty path', async t => {
  const { state } = await setup(t)
  await open('claude'); await input('C:/draft')
  await inAct(() => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })) })
  assert.equal(dialog(), null)
  assert.equal(state.closed, false)
  await open('google')
  assert.equal(dialog().querySelector('input')!.value, '')
  assert.match(dialog().textContent!, /Antigravity/)
})

test('refresh queries stable account id but reports its displayed label', async t => {
  const { calls, notices } = await setup(t, [{ ...account('claude-4'), label: 'claude-0' }])
  await inAct(async () => { button(lane('claude'), 'refresh').click(); await flush() })
  assert.ok(calls.some(c => c.url === '/api/accounts/claude-4/identity'))
  assert.deepEqual(notices, [['claude-4 · claude-4@example.test: unauthenticated']])
})

 test('an unreadable account registry stays visible as an error and retry restores the provider rows', async t => {
  const { state } = await setup(t)
  state.alien = true
  await inAct(async () => { button(lane('claude'), 'refresh').click(); await flush() })
  assert.match(document.body.textContent!, /Could not load the account list/)
  assert.match(lane('claude').textContent!, /existing-claude/)
  state.alien = false
  await inAct(async () => { button(document.body, 'retry').click(); await flush() })
  assert.doesNotMatch(document.body.textContent!, /Could not load the account list/)
  assert.equal(lane('claude').querySelectorAll('.account-row').length, 1)
 })
