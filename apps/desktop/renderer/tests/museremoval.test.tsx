// museremoval.test.tsx — removing a registered Muse login (independent review
// R3 2026-10-13): its agents go to a login whose own catalog offers their
// model (the default first, else another subscription login) or wait frozen
// when none can run it. The button's title says so before the click and the
// toast says where each went, from the engine's `rebound` answer.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs museremoval

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountRegistrySection } from '../src/canvas/accountsregistry'
import type { AccountRegistry } from '../src/canvas/accountsregistry'

const BOUND = ['m1', 'm2', 'm3', 'm4'].map((node) => ({ org: 'acme', node, state: 'live' }))
const account = (id: string, provider: string, bound = BOUND) => ({
  id, provider, label: id, name: id, ambient: false, mode: 'managed', enabled: true,
  credential: { kind: 'managed', path: 'C:/fixture/' + id }, identity: { email: id + '@example.test' },
  auth: 'authenticated', tint_ordinal: 1, standing: { auth: 'authenticated', state: 'ready', marks: {} }, bound })

async function setup(t: { after: (fn: () => Promise<void> | void) => void }, provider: string, rebound: unknown[]) {
  const old = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: RequestInit) => new Response(
    JSON.stringify((init?.method ?? 'GET') === 'DELETE' ? { removed: `${provider}-7`, orgs: ['acme'], rebound } : {}),
    { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  const notices: string[][] = []
  const registry = { rows: [account(`${provider}-7`, provider)], error: null, reload: async () => {} } as unknown as AccountRegistry
  const view = await mountView(<AccountRegistrySection provider={provider as 'muse'} registry={registry}
    toast={(lines) => { notices.push(lines) }} />, (el) => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = old })
  await inAct(async () => { await flush() })
  const button = [...view.el.querySelectorAll('button')].find((b) => b.textContent === 'remove')!
  return { view, notices, button }
}

test('a Muse login\'s removal says where its agents went: the default, another login, or frozen', async (t) => {
  const { notices, button } = await setup(t, 'muse', [
    { org: 'acme', node: 'm1', state: 'live', account: 'muse/primary', frozen: false },
    { org: 'acme', node: 'm2', state: 'live', account: 'muse-2', frozen: false },
    { org: 'acme', node: 'm3', state: 'live', account: 'muse-2', frozen: false },
    { org: 'acme', node: 'm4', state: 'live', account: 'muse/primary', frozen: true, reason: 'no Muse login this org may use can run muse-wonder-full-1.0 now' },
  ])
  assert.match(button.title, /move its 4 agent\(s\) to a Muse login that offers their model \(the default account first\); one no login can run waits frozen/)
  await inAct(async () => { button.click(); await flush() })
  assert.match(notices.at(-1)?.[0] ?? '', /removed — 1 agent\(s\) moved to Muse default — 2 agent\(s\) moved to muse-2 — 1 agent\(s\) wait frozen: no Muse login they may use can run their model now$/)
})

test('control: another provider\'s removal still moves every agent to its default', async (t) => {
  const { notices, button } = await setup(t, 'claude', BOUND.map((b) => ({ ...b, account: 'claude/primary' })))
  assert.match(button.title, /move its 4 agent\(s\) to the Claude default account/)
  await inAct(async () => { button.click(); await flush() })
  assert.match(notices.at(-1)?.[0] ?? '', /removed — 4 agent\(s\) moved to Claude default$/)
})
