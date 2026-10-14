// musesession0.test.tsx — user 2026-10-14 removed the long Muse warning
// from Providers, superseding the October13 request to display it there.
// Session metadata must not restore it; ordinary provider status stays visible.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs musesession0

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import { clearProviderDiscovery } from '../src/api'

const noop = () => {}

function provider(id: string, label: string, extra: Record<string, unknown> = {}) {
  return { id, label, cli: id, status: { installed: true, connected: true }, hire_enabled: true, reason: null,
    tiers: [], ...extra }
}

async function mountWith(t: TestContext, providers: unknown[]) {
  clearProviderDiscovery()
  t.after(() => clearProviderDiscovery())
  const real = globalThis.fetch
  t.after(() => { globalThis.fetch = real })
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost').pathname
    if (path === '/api/providers') {
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ providers }) }
    }
    return real(url, init)
  }) as typeof fetch
  const v = await mountView(<AccountsPanel toast={noop} close={noop} />, (el) => el)
  t.after(() => v.unmount())
  await inAct(async () => { await flush(10) })
  const panel = () => document.getElementById('app-settings-panel-providers')
  const notes = () => [...(panel()?.querySelectorAll('.acct-provider-session0') ?? [])]
  return { panel, notes }
}

test('in Session 0 the Muse card stays compact and retains its ordinary status', async (t: TestContext) => {
  const { panel, notes } = await mountWith(t, [provider('openai', 'Codex'),
    provider('muse', 'Muse', { reason: 'Sign in to use this harness.', muse: { session0: true, logins: [] } })])
  assert.ok(panel()?.textContent?.includes('Codex'), 'positive control: the Codex card rendered')
  assert.ok(panel()?.querySelector('.prov-muse'), 'positive control: the Muse card rendered')
  assert.equal(notes().length, 0, 'the obsolete Session 0 paragraph is absent')
  assert.doesNotMatch(panel()?.textContent ?? '', /can run any command|write outside their folders|without Orgtree being asked/)
  assert.equal(panel()?.querySelector('.prov-muse')?.closest('.acct-provider-group')
    ?.querySelector('.acct-provider-note')?.textContent, 'Sign in to use this harness.', 'ordinary provider status stays')
})

// one test per case: each mounts its own panel and unmounts it after
for (const muse of [{ session0: false, logins: [] }, { logins: [] }, null]) {
  test(`outside Session 0 (or with no word from the engine) there is no note: muse = ${JSON.stringify(muse)}`,
    async (t: TestContext) => {
      const { panel, notes } = await mountWith(t, [provider('muse', 'Muse', { muse })])
      assert.ok(panel()?.querySelector('.prov-muse'), 'positive control: the Muse card rendered')
      assert.equal(notes().length, 0)
    })
}
