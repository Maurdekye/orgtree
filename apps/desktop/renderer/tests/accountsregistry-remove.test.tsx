/** Removing a secondary account from the panel (user ticket 2026-09-21).
 *
 * The control used to be DISABLED whenever the row had bound agents, which is
 * the defect: the operator could not remove the account without first moving
 * every binding by hand. These assert the new contract — the button is live
 * with agents bound, one DELETE runs the coordinated operation, the list is
 * re-read so the removed row disappears and the moved agents show the primary
 * account, the toast says how many moved, a refusal is reported verbatim and
 * changes nothing, and the primary row itself stays unremovable.
 */
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'

type Bound = { org: string; node: string; state: string }
const account = (id: string, provider = 'claude', bound: Bound[] = [], ambient = false) => ({
  id, provider, label: id, name: ambient ? provider + '/primary' : id, ambient,
  credential: { kind: 'managed', path: 'C:/fixture/' + id },
  identity: { email: id + '@example.test' }, auth: 'authenticated', tint_ordinal: 1,
  standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound,
})

const BOUND: Bound[] = [
  { org: 'orgtree', node: 'alpha', state: 'live' },
  { org: 'orgtree', node: 'bearer', state: 'archived' },
]

async function setup(t: TestContext, opts: { refuse?: string } = {}) {
  const oldFetch = globalThis.fetch
  const calls: { url: string; method: string }[] = []
  const notices: string[][] = []
  const state = {
    rows: [account('claude-0', 'claude', [], true), account('claude-1', 'claude', BOUND)],
    reads: 0,
  }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    calls.push({ url: String(url), method })
    if (String(url).endsWith('/providers')) {
      return new Response(JSON.stringify({ providers: ['claude', 'openai', 'google'].map((id, i) => ({
        id, label: ['Claude', 'Codex', 'Antigravity'][i], cli: id,
        status: { installed: true, connected: true }, tiers: [], hire_enabled: true,
      })) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (method === 'DELETE') {
      if (opts.refuse) return new Response(JSON.stringify({ detail: opts.refuse }), { status: 422 })
      // the backend rebinds first, then removes: the next list read is what
      // shows both halves of that one operation
      state.rows = state.rows.filter(r => r.id !== 'claude-1')
      return new Response(JSON.stringify({
        removed: 'claude-1', orgs: ['orgtree'],
        rebound: BOUND.map(b => ({ org: b.org, node: b.node, state: b.state, in_flight_turn: false })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (String(url) === '/api/accounts') { state.reads++; return new Response(JSON.stringify({ accounts: state.rows }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }), getPreferences: async () => ({}), onEvent: () => () => {} }
  const view = await mountView(<AccountsPanel toast={lines => { notices.push(lines) }} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; delete desk.orgtreeDesktop })
  await inAct(async () => { await flush() })
  return { view, state, calls, notices }
}

const lane = () => document.querySelector('.prov-claude')!.closest('.acct-provider-group')!
const rowFor = (id: string) => [...lane().querySelectorAll('.account-row')]
  .find(r => r.textContent?.includes(id))
const removeIn = (root: ParentNode) =>
  [...root.querySelectorAll('button')].find(b => b.textContent === 'remove')!

test('remove is live on an account with bound agents and says what will move', async t => {
  await setup(t)
  const button = removeIn(rowFor('claude-1')!)
  assert.equal(button.disabled, false, 'bound agents no longer disable the control')
  assert.match(button.title, /move its 2 agent\(s\) to the Claude default account/)
  assert.match(rowFor('claude-1')!.textContent!, /2 agent\(s\)/)
})

test('one click removes the account, re-reads the list and reports what moved', async t => {
  const { calls, notices, state } = await setup(t)
  const before = state.reads
  await inAct(async () => { removeIn(rowFor('claude-1')!).click(); await flush() })
  const deletes = calls.filter(c => c.method === 'DELETE')
  assert.deepEqual(deletes.map(c => c.url), ['/api/accounts/claude-1'])
  assert.equal(state.reads, before + 1, 'the panel re-reads the registry after the removal')
  assert.equal(rowFor('claude-1'), undefined, 'the removed account is gone from the panel')
  assert.ok(rowFor('claude-0'), 'the primary account is still listed')
  assert.deepEqual(notices.at(-1), ['claude-1 · claude-1@example.test removed — 2 agent(s) moved to Claude default'])
})

test('a refusal is reported verbatim and leaves the account in place', async t => {
  const { notices, state } = await setup(t, {
    refuse: 'account claude-1 cannot be removed yet — 1 blocker(s):\n  · orgtree/alpha is running a turn',
  })
  await inAct(async () => { removeIn(rowFor('claude-1')!).click(); await flush() })
  assert.ok(rowFor('claude-1'), 'the account is still listed')
  assert.equal(state.rows.length, 2)
  assert.match(String(notices.at(-1)), /orgtree\/alpha is running a turn/)
})

test('the primary account keeps an unremovable control', async t => {
  await setup(t)
  const button = removeIn(rowFor('claude-0')!)
  assert.equal(button.disabled, true)
  assert.match(button.title, /default account cannot be removed/)
})
