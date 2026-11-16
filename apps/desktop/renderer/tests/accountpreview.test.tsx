/** The "preview" tag on a provider's head in App settings > Accounts.
 *
 *  It marks a provider that is installed and switched on but cannot be hired
 *  yet. An engine before 4.6.0 says so by its own sign-in alone, so on a
 *  remote organization of such an engine Claude and Codex wore the tag while
 *  their hire tokens were offered on a signed-in registered account. The tag
 *  goes by the same rule as the tokens (`providersWithAccounts`). */
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'

const account = (id: string, provider: string, patch: Record<string, unknown> = {}) => ({
  id, provider, label: id, name: id,
  credential: { kind: 'managed', path: '/srv/orgtree/data/profiles/' + id },
  identity: {}, auth: 'authenticated', tint_ordinal: 1, enabled: true,
  standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound: [], ...patch,
})

async function tags(t: TestContext, accounts: unknown[]) {
  const oldFetch = globalThis.fetch
  const json = (v: unknown) => new Response(JSON.stringify(v),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = (async (url: string) => {
    const u = String(url)
    // as an engine before 4.6.0 answers: signed out by its own sign-in
    if (u.endsWith('/providers')) {
      return json({ providers: ['claude', 'openai', 'google'].map((id, i) => ({
        id, label: ['Claude', 'Codex', 'Antigravity'][i], cli: id, tiers: [], user_enabled: true,
        status: { installed: true, connected: false }, hire_enabled: false, hire_reason: 'signed_out',
        reason: 'installed but not signed in' })) })
    }
    if (u === '/api/accounts') return json({ accounts })
    if (/^\/api\/accounts\/[^/]+\/marks$/.test(u)) return json({ account: u.split('/')[3], marks: [] })
    return json({})
  }) as typeof fetch
  const desk = window as unknown as { orgtreeDesktop?: unknown }
  desk.orgtreeDesktop = { getProviderLoginStatus: async () => ({ phase: 'idle' }), getPreferences: async () => ({}), onEvent: () => () => {} }
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; delete desk.orgtreeDesktop })
  await inAct(async () => { await flush() })
  await inAct(async () => { await flush() })
  const out: Record<string, boolean> = {}
  for (const id of ['claude', 'openai', 'google']) {
    const head = document.querySelector('.acct-provider-head.prov-' + id)
    assert.ok(head, id + ' has a head')
    out[id] = !!head.querySelector('.acct-preview-tag')
  }
  return out
}

test('with no account to go by, a signed-out provider wears the preview tag', async (t) => {
  assert.deepEqual(await tags(t, []), { claude: true, openai: true, google: true })
})

test('a signed-in registered account takes the preview tag off Claude and Codex, each by its own accounts', async (t) => {
  assert.deepEqual(await tags(t, [account('claude-2', 'claude')]), { claude: false, openai: true, google: true })
})

test('both signed in on accounts: only the provider the rule does not cover keeps the tag', async (t) => {
  assert.deepEqual(await tags(t, [account('claude-2', 'claude'), account('openai-1', 'openai'), account('google-1', 'google')]),
    { claude: false, openai: false, google: true })
})

test('an account that is switched off or signed out leaves the tag', async (t) => {
  assert.deepEqual(await tags(t, [account('claude-2', 'claude', { enabled: false }), account('openai-1', 'openai', { auth: 'unauthenticated' })]),
    { claude: true, openai: true, google: true })
})
