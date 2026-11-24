/** Account rows as a remote member is sent them (report 2026-11-24, a 4.6.9 client on a
 * 4.7.0-alpha.1 host: App settings crashed at `row.bound.length`).
 *
 * The hosting engine takes away where else an account is used before it answers a member
 * (engine remote_access/shown.rs): up to 4.7.0-alpha.1 the row has no `bound` at all, from
 * alpha.2 on it has `bound: []` with `bound_hidden: true`. Both inputs of the registry carry
 * such rows: GET /api/accounts and the pushed `accounts` value. A row is never trusted to be
 * whole: a missing list is empty, a missing field reads as unknown, and a binding that is not
 * shown is said to be not shown, never "unused".
 */
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { legacyAppBackend } from './appfeed-fixture'
import { AccountsPanel } from '../src/canvas/accounts'
import { normalizeAccountRows } from '../src/canvas/accountsregistry'

const whole = (id: string, extra: Record<string, unknown> = {}) => ({
  id, provider: 'claude', label: id, name: id, credential: { kind: 'managed', path: 'C:/fixture/' + id },
  identity: { email: null }, tint_ordinal: 1, standing: { auth: 'authenticated', state: 'ready', marks: {} }, ...extra,
})
/** What a member is sent: an older host's row, a 4.7.0 host's row, one with little in it, and what is no row. */
const MEMBER_ROWS: unknown[] = [
  whole('claude-0', { ambient: true, name: 'claude/primary' }),
  whole('claude-1'),
  whole('claude-2', { bound: [], bound_hidden: true }),
  { id: 'claude-3', provider: 'claude' },
  null, 'claude-9', { provider: 'claude' },
  whole('claude-4', { bound: [{ org: 'here', node: 'alpha', state: 'live' }, null, 'x'] }),
]
const providers = { providers: ['claude', 'openai', 'google'].map((id, i) => ({
  id, label: ['Claude', 'Codex', 'Antigravity'][i], cli: id, status: { installed: true, connected: true }, tiers: [], hire_enabled: true })) }

const lane = () => document.querySelector('.prov-claude')!.closest('.acct-provider-group')!
const rowFor = (id: string) => [...lane().querySelectorAll('.account-row')].find(r => r.textContent?.includes(id))
const removeIn = (root: ParentNode) => [...root.querySelectorAll('button')].find(b => b.textContent === 'Remove')!

function shownAsAMemberSeesThem() {
  for (const id of ['claude-1', 'claude-2', 'claude-3', 'claude-4']) assert.ok(rowFor(id), `${id} is listed`)
  assert.equal(lane().querySelectorAll('.account-row').length >= 4, true)
  for (const id of ['claude-1', 'claude-2', 'claude-3']) {
    const row = rowFor(id)!
    assert.match(row.textContent!, /Agents not shown/, `${id}: the binding is said to be not shown`)
    assert.doesNotMatch(row.textContent!, /\d+ agent\(s\)/)
    const remove = removeIn(row)
    assert.equal(remove.disabled, true, `${id}: no removal while its agents are not shown`)
    assert.match(remove.title, /not shown to this computer/)
    assert.doesNotMatch(remove.title, /^Remove this account$/)
  }
  assert.match(rowFor('claude-3')!.textContent!, /Sign-in not verified/, 'a row without a standing reads as unknown')
  // a row that says what it is bound to is unchanged, and what is no binding in its list is not counted
  assert.match(rowFor('claude-4')!.textContent!, /1 agent\(s\)/)
  assert.equal(removeIn(rowFor('claude-4')!).disabled, false)
}

test('rows without their bindings, from GET /api/accounts, are listed and do not break the panel', async (t: TestContext) => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = legacyAppBackend((async (url: string) => {
    const body = String(url).endsWith('/providers') ? providers : String(url) === '/api/accounts' ? { accounts: MEMBER_ROWS } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch)
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }), getPreferences: async () => ({}), onEvent: () => () => {} }
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; delete desk.orgtreeDesktop })
  await inAct(async () => { await flush() })
  shownAsAMemberSeesThem()
})

test('the same rows, pushed as the accounts value, are listed and do not break the panel', async (t: TestContext) => {
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = { fetch: globals.fetch, WebSocket: globals.WebSocket }
  const sockets: Socket[] = []
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(readonly url: string) { sockets.push(this) }
    close() { this.onclose?.() }
    frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
  }
  const copy = { type: 'app_snapshot', epoch: 'member', seq: 1,
    registry: { type: 'registry_snapshot', epoch: 'member', cursor: { app_uuid: 'app', incarnation: 'member', rev: 1 }, records: [] },
    summaries: {}, notices: {}, runtime: { values: {}, orgs: {} } }
  const requests: string[] = []
  globals.WebSocket = Socket
  globals.fetch = async (input: unknown) => {
    requests.push(String(input))
    return new Response(JSON.stringify(String(input) === '/api/app/records' ? copy : {}), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }), getPreferences: async () => ({}), onEvent: () => () => {} }
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); Object.assign(globals, saved); delete desk.orgtreeDesktop })
  await inAct(() => flush(8))
  assert.ok(sockets.length >= 1, 'the panel reads the pushed values')
  await inAct(() => sockets[0].frame(copy))
  await inAct(() => sockets[0].frame({ type: 'app_runtime', epoch: 'member', seq: 2,
    values: Object.fromEntries(Object.entries({ providers, accounts: { accounts: MEMBER_ROWS } }).map(([key, value]) => [key, { epoch: 'member', seq: 2, value }])) }))
  await inAct(() => flush(8))
  // every request but the first copy is answered without an account list: the rows below can only be the pushed ones
  assert.ok(requests.includes('/api/app/records'))
  shownAsAMemberSeesThem()
})

test('a row is made whole before anything reads it', () => {
  assert.deepEqual(normalizeAccountRows(undefined), [])
  assert.deepEqual(normalizeAccountRows({ accounts: [] }), [], 'only a list is a list of rows')
  const rows = normalizeAccountRows(MEMBER_ROWS)
  assert.deepEqual(rows.map(row => row.id), ['claude-0', 'claude-1', 'claude-2', 'claude-3', 'claude-4'], 'what has no id is no row')
  assert.deepEqual(rows.map(row => [row.bound.length, row.bound_hidden === true]), [[0, true], [0, true], [0, true], [0, true], [1, false]])
  const bare = rows[3]
  assert.deepEqual([bare.label, bare.credential, bare.identity, bare.standing, bare.tint_ordinal],
    ['claude-3', { kind: 'unknown' }, {}, { auth: 'unknown' }, 0])
  // a whole row comes through as it was sent
  const sent = whole('claude-7', { bound: [{ org: 'here', node: 'alpha', state: 'live' }], origin_org: 'here', mode: 'apikey', enabled: false })
  assert.deepEqual(normalizeAccountRows([sent])[0], sent)
})
