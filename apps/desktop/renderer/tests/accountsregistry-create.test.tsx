// Create-managed flow of the account registry section, in its OWN file
// (coordinator 2026-09-10) so root's reserve-display edits to shared
// account test files never collide with it. Covers the user defect
// "Create managed does nothing": the visible created row with its sign-in
// action, and honest surfacing of a failed/alien account list.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountRegistrySection } from '../src/canvas/accountsregistry'

const account = (id: string, auth = 'authenticated') => ({
  id, provider: 'claude', harness: 'claude-code', label: id,
  credential: { kind: 'imported', path: 'C:/fixture/' + id },
  identity: { email: id + '@example.test' }, auth, tint_ordinal: 1,
  standing: { auth, state: auth === 'authenticated' ? 'ready' : 'unknown', marks: {} },
  bound: [] as object[],
})

test('refresh identifies the visible account label while querying its stable id', async t => {
  const oldFetch = globalThis.fetch
  const calls: string[] = []
  const notices: string[][] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify(String(url).endsWith('/identity')
      ? { auth: 'unauthenticated' }
      : { accounts: [{ ...account('claude-4'), label: 'claude-0' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const view = await mountView(<AccountRegistrySection toast={lines => { notices.push(lines) }} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch })
  await inAct(async () => { await flush() })
  const refresh = [...view.el.querySelectorAll('button')].find(b => b.textContent === 'refresh')!
  assert.ok(refresh)
  await inAct(async () => { refresh.click(); await flush() })
  assert.ok(calls.includes('/api/accounts/claude-4/identity'))
  assert.deepEqual(notices, [['claude-0: unauthenticated']])
})

test('creating a managed account shows the new row with its sign-in action', async t => {
  // STATEFUL mock (user defect 2026-09-10, "Create managed does nothing"):
  // the POST mints a row the next reload really serves, so the assertion is
  // the VISIBLE outcome — a rendered row exposing sign-in — not merely that
  // a request fired while the section kept showing "No accounts yet".
  const rows: ReturnType<typeof account>[] = []
  const oldFetch = globalThis.fetch
  const calls: { url: string; method: string; body: string }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    calls.push({ url: String(url), method, body: String(init?.body || '') })
    if (method === 'POST') {
      const made = { ...account('fresh-managed', 'unobserved'), label: 'claude-0',
        credential: { kind: 'managed', path: 'C:/fixture/fresh-managed' } }
      rows.push(made)
      return new Response(JSON.stringify(made), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ accounts: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  // ProviderSignIn renders nothing without the desktop bridge (correct in a
  // browser); the installed app has one, so the test supplies the minimal
  // presence the sign-in button's render path needs
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }) }
  const view = await mountView(<AccountRegistrySection toast={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; delete desk.orgtreeDesktop })
  await inAct(async () => { await flush() })
  const el = view.el
  assert.equal(el.querySelectorAll('.account-row').length, 0)
  const button = [...el.querySelectorAll('button')].find(b => /create managed/i.test(b.textContent || ''))!
  assert.ok(button)
  await inAct(async () => { button.click(); await flush() })
  const create = calls.find(c => c.method === 'POST')
  assert.ok(create)
  assert.equal(create.url, '/api/accounts')
  assert.deepEqual(JSON.parse(create.body), { provider: 'claude', kind: 'managed' })
  const row = el.querySelector<HTMLElement>('.account-row')
  assert.ok(row, 'the created account is VISIBLE after the reload')
  assert.equal(row!.querySelector('strong')?.textContent, 'claude-0')
  assert.equal(row!.querySelector('strong')?.title, 'Account ID: fresh-managed')
  assert.ok([...row!.querySelectorAll('button')].some(b => /sign in/i.test(b.textContent || '')),
    'the new profile exposes its sign-in action')
})

test('a failed or alien account list says so instead of posing as empty', async t => {
  // the legacy-readout shadowing served exactly this: HTTP 200 with no
  // accounts array — the section must SAY it, never render "No accounts
  // yet" over a list it could not actually read (coordinator 2026-09-10:
  // the swallowed reload failure)
  const oldFetch = globalThis.fetch
  let alien = true
  globalThis.fetch = (async () => alien
    ? new Response(JSON.stringify({ version: 2, primary: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify({ accounts: [account('one')] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  ) as typeof fetch
  const view = await mountView(<AccountRegistrySection toast={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch })
  await inAct(async () => { await flush() })
  const el = view.el
  assert.equal(/No accounts yet/.test(el.textContent || ''), false,
    'the alien shape must not read as an empty registry')
  assert.match(el.textContent || '', /Could not load the account list/)
  // backend recovers: retry renders the real rows and clears the warning
  alien = false
  const retry = [...el.querySelectorAll('button')].find(b => /retry/i.test(b.textContent || ''))!
  await inAct(async () => { retry.click(); await flush() })
  assert.equal(el.querySelectorAll('.account-row').length, 1)
  assert.equal(/Could not load the account list/.test(el.textContent || ''), false)
})
