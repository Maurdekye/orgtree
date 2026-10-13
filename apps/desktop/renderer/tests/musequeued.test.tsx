// musequeued.test.tsx — the agent settings window lists a Muse seat's effort
// levels for the login its next turn runs on (independent review R3
// 2026-10-13): an account change queued behind a running turn, as the engine
// judges a level saved there (`accounts::next_turn_login`), and a login picked
// in the window itself wins over the queued one.
//
// Each claim has its control: the same window with nothing queued, and the
// inverse direction, so a list that ignored the queue (or always showed every
// level) cannot pass.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs musequeued

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NodeConfig } from '../src/canvas/modals'
import { setMuseProvider } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import type { MuseLoginDoc, ProviderInfo, TreePayload } from '../src/types'

const ALL = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const row = (model: string, efforts = ALL) => ({ model, efforts, default_effort: 'high' })
const login = (account: string | null, efforts: string[]): MuseLoginDoc => ({ account, kind: 'subscription', state: 'ready',
  tiers: { wonder: { latest: row('muse-wonder-1.0', efforts), versions: {} } } })
/** PV: Wonder through high only; PF: Wonder with every level */
const PV = login('muse-pv', ['low', 'medium', 'high'])
const PF = login('muse-pf', ALL)
const OWN = login(null, ALL)

setMuseProvider({ id: 'muse', label: 'Muse', cli: 'muse', hire_enabled: true, reason: null,
  status: { installed: true, connected: true }, tiers: [{ tier: 'wonder', provider: 'muse', seat: 4, model: 'wonder', letter: 'W' }],
  muse: { logins: [OWN, PV, PF] } } as ProviderInfo)

async function mount(t: { after: (fn: () => Promise<void> | void) => void }, account: string, queued: string | null) {
  const old = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const result = path === '/api/accounts' ? { accounts: ['muse-pv', 'muse-pf'].map((id) => ({
      id, provider: 'muse', name: id, label: id, standing: { state: 'ready' } })) } : { servers: [], turns: [], warnings: [] }
    return { ok: true, status: 200, headers: new Headers(), json: async () => result }
  }) as typeof fetch
  const node = { id: 'agent', title: 'agent', state: 'live', tier: 'wonder', model_id: 'muse-wonder-1.0',
    parent: 'USER', children: [], seat: 4, grant: 10, free: 10, account,
    pending_account: queued ? { account: queued, from: account, by: 'user', at: '2026-10-13T12:00:00Z' } : null,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
      org_visibility: 'team' }, charter: '', team_charter: '', turns: [], audiences_held: [],
  } as unknown as CanvasNode
  const tree = { slug: 'org', dirs: [], tiers: { wonder: 4 }, max_top_grant: 100, default_effort: '', effort_default: 'high',
    cascade_hire: true } as unknown as TreePayload
  const view = await mountView(<NodeConfig node={node} map={new Map([[node.id, node]])}
    tree={tree} slug="org" op={async () => ({})} toast={() => {}} close={() => {}} />, (el) => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = old })
  await inAct(async () => { await flush(8) })
  return view
}

const levels = (el: Element) => [...el.querySelectorAll('.effort-bar-dot')].map((d) => d.getAttribute('data-level'))

test('a queued move PV → PF lists PF\'s levels (max included)', async (t) => {
  const view = await mount(t, 'muse-pv', 'muse-pf')
  assert.deepEqual(levels(view.el), ALL)
})

test('the inverse, PF → PV queued, lists PV\'s levels (no max)', async (t) => {
  const view = await mount(t, 'muse-pf', 'muse-pv')
  assert.deepEqual(levels(view.el), ['low', 'medium', 'high'])
})

test('control: with nothing queued the bound login\'s levels are listed', async (t) => {
  assert.deepEqual(levels((await mount(t, 'muse-pv', null)).el), ['low', 'medium', 'high'])
})

test('a queued `primary` is the own login', async (t) => {
  assert.deepEqual(levels((await mount(t, 'muse-pv', 'primary')).el), ALL)
})

test('a login picked in the window wins over the queued one', async (t) => {
  const view = await mount(t, 'muse-pv', 'muse-pf')
  const select = view.el.querySelector<HTMLSelectElement>('select[aria-label="Account"]')!
  assert.ok(select, 'the account select')
  await inAct(async () => {
    select.value = 'muse-pv'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  assert.deepEqual(levels(view.el), ['low', 'medium', 'high'])
})
