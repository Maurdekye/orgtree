// musesession0.test.tsx — the Muse harness card says plainly what a Muse
// agent runs with while the engine is in Windows Session 0.
//
// Docket `muse-shell-works-when-the-engine-runs-in-the-win`. The user
// (2026-10-13 20:16Z) chose to run Muse's write seats without its OS sandbox
// in Session 0, knowing (measured that day) that Muse then asks Orgtree about
// no command and its file tools can write outside the agent's folders, and
// asked for that to be stated plainly on the Harnesses page (App settings ›
// Providers). The engine says when it applies (`/api/providers` ›
// `muse.session0`); the card shows the note then and only then.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs musesession0

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel, MUSE_SESSION0_NOTE } from '../src/canvas/accounts'
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

test('the note states the measured trade-off in plain words', () => {
  for (const part of ['Session 0', 'can run any command', 'write outside their folders',
    'without Orgtree being asked', 'Read-only Muse agents have no shell', 'stay inside the agent’s folders']) {
    assert.ok(MUSE_SESSION0_NOTE.includes(part), `the note lacks "${part}"`)
  }
})

test('in Session 0 the Muse card carries the note, and only the Muse card', async (t: TestContext) => {
  const { panel, notes } = await mountWith(t, [provider('openai', 'Codex'),
    provider('muse', 'Muse', { muse: { session0: true, logins: [] } })])
  assert.ok(panel()?.textContent?.includes('Codex'), 'positive control: the Codex card rendered')
  assert.equal(notes().length, 1, 'one Session 0 note')
  assert.equal(notes()[0]!.textContent, MUSE_SESSION0_NOTE)
  assert.equal(notes()[0]!.getAttribute('role'), 'note')
  assert.ok(notes()[0]!.closest('.acct-provider-group')?.querySelector('.prov-muse'), 'the note sits on the Muse card')
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
