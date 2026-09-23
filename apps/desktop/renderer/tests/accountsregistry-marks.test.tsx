/** Clearing an account capacity mark from the panel (docket item
 * add-agent-tool-and-ui-to-clear-account-limit-mar).
 *
 * The contract: an account row lists its active marks with pool, reset time,
 * provenance and age; `clear…` opens a confirmation naming the exact account,
 * pool and reset time and saying clearing adds no capacity and resumes nobody;
 * Cancel sends nothing; Confirm posts the mark exactly as shown; a mark that
 * changed meanwhile is refused by the backend and the dialog shows the new
 * state and asks again instead of clearing.
 */
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'

const NOW = Date.now() / 1000
const account = (id: string, ambient = false, state = 'ready') => ({
  id, provider: 'claude', label: id, name: ambient ? 'claude/primary' : id, ambient,
  credential: { kind: 'managed', path: 'C:/fixture/' + id },
  identity: { email: id + '@example.test' }, auth: 'authenticated', tint_ordinal: 1,
  standing: { auth: 'authenticated', state, marks: {} }, bound: [],
})
const mark = (until: number, provenance = 'observed') => ({
  account: 'claude-4', source: 'registry', pool: 'pooled', state: 'active',
  until, remaining_s: until - NOW, observed_at: NOW - 600, age_s: 600,
  provenance, window: 'weekly',
  expected: { until, observed_at: NOW - 600, provenance, window: 'weekly' },
  companion: { pool: 'fable', cleared_with_this: true,
    expected: { until, observed_at: NOW - 600, provenance: 'inferred', window: 'weekly' } },
})

type Opts = { changeOnFirstClear?: boolean }
async function setup(t: TestContext, opts: Opts = {}) {
  const oldFetch = globalThis.fetch
  const posts: { url: string; body: Record<string, unknown> }[] = []
  const notices: string[][] = []
  const state = { marks: [mark(NOW + 7200)], clears: 0 }
  const json = (v: unknown) => new Response(JSON.stringify(v),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url), method = init?.method || 'GET'
    if (u.endsWith('/providers')) {
      return json({ providers: ['claude', 'openai', 'google'].map((id, i) => ({
        id, label: ['Claude', 'Codex', 'Antigravity'][i], cli: id,
        status: { installed: true, connected: true }, tiers: [], hire_enabled: true })) })
    }
    if (u === '/api/accounts') return json({ accounts: [account('claude-0', true), account('claude-4', false, 'limited')] })
    if (u === '/api/accounts/claude-4/marks') return json({ account: 'claude-4', marks: state.marks })
    if (u === '/api/accounts/claude-0/marks') return json({ account: 'claude-0', marks: [] })
    if (u === '/api/accounts/claude-4/marks/clear' && method === 'POST') {
      posts.push({ url: u, body: JSON.parse(String(init?.body)) })
      state.clears++
      if (opts.changeOnFirstClear && state.clears === 1) {
        state.marks = [mark(NOW + 20000)]           // a newer wall landed
        return json({ result: 'changed' })
      }
      state.marks = []
      return json({ result: 'cleared', kept: {} })
    }
    return json({})
  }) as typeof fetch
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }), getPreferences: async () => ({}), onEvent: () => () => {} }
  const view = await mountView(<AccountsPanel toast={lines => { notices.push(lines) }} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; delete desk.orgtreeDesktop })
  await inAct(async () => { await flush() })
  await inAct(async () => { await flush() })
  return { posts, notices, state }
}

const rowFor = (id: string) => [...document.querySelectorAll('.account-row')]
  .find(r => r.textContent?.includes(id))!
const button = (root: ParentNode, text: string | RegExp) =>
  [...root.querySelectorAll('button')].find(b =>
    typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? ''))
const dialog = () => document.querySelector('.clear-mark-dialog')
const click = async (b: HTMLButtonElement | undefined) => {
  assert.ok(b, 'button present')
  await inAct(async () => { b!.click(); await flush() })
  await inAct(async () => { await flush() })
}

test('an account row lists its mark with pool, reset, provenance and age', async t => {
  await setup(t)
  const text = rowFor('claude-4').textContent!
  assert.match(text, /Haiku\/Sonnet\/Opus limited until/)
  assert.match(text, /observed/)
  assert.match(text, /recorded 10m ago/)
  assert.ok(button(rowFor('claude-4'), 'clear…'))
  assert.equal(button(rowFor('claude-0'), 'clear…'), undefined, 'no mark, no control')
})

test('the dialog names the exact mark and warns; cancel sends nothing', async t => {
  const { posts } = await setup(t)
  await click(button(rowFor('claude-4'), 'clear…'))
  const d = dialog()!
  assert.ok(d, 'confirmation opened')
  assert.match(d.textContent!, /claude-4/)
  assert.match(d.textContent!, /Haiku\/Sonnet\/Opus/)
  assert.match(d.textContent!, /measured from the provider/)
  assert.match(d.textContent!, /also clears the inferred Fable mark/)
  assert.match(d.textContent!, /does not add capacity/)
  assert.match(d.textContent!, /Frozen agents stay frozen until you resume them/)
  await click(button(d, 'Cancel'))
  assert.equal(dialog(), null)
  assert.equal(posts.length, 0)
})

test('confirm posts the mark exactly as shown and reports the clear', async t => {
  const { posts, notices } = await setup(t)
  await click(button(rowFor('claude-4'), 'clear…'))
  await click(button(dialog()!, /^Clear Haiku\/Sonnet\/Opus mark on claude-4$/))
  assert.equal(posts.length, 1)
  const shown = mark(NOW + 7200)
  assert.deepEqual(posts[0].body.expected, shown.expected)
  assert.deepEqual(posts[0].body.companion_expected, shown.companion.expected)
  assert.equal(posts[0].body.source, 'registry')
  assert.equal(posts[0].body.pool, 'pooled')
  assert.equal(dialog(), null)
  assert.match(notices.flat().join(' '), /mark cleared\. Frozen agents still need to be resumed/)
  assert.equal(button(rowFor('claude-4'), 'clear…'), undefined, 'list re-read after the clear')
})

test('a mark that changed meanwhile is not cleared; the dialog shows it and asks again', async t => {
  const { posts } = await setup(t, { changeOnFirstClear: true })
  await click(button(rowFor('claude-4'), 'clear…'))
  await click(button(dialog()!, /^Clear /))
  const d = dialog()!
  assert.ok(d, 'dialog stays open')
  assert.match(d.textContent!, /changed since you opened this dialog\. Nothing was cleared/)
  await click(button(d, /^Clear /))
  assert.equal(posts.length, 2)
  assert.equal((posts[1].body.expected as { until: number }).until, NOW + 20000,
    'the second confirmation carries the NEW mark, not the stale one')
})
