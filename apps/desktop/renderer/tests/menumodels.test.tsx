import { flush, inAct, mountView, FakeServer, installFetch } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { legacyAppBackend } from './appfeed-fixture'
import { OrgCanvas, HireSheet } from '../src/canvas/OrgCanvas'
import { SpawnChips } from '../src/canvas/cards'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import { clearProviderDiscovery } from '../src/api'
import { hireOf, setMuseProvider, setOpenRouterTiers, setLangServerTiers, USER, tierLabel } from '../src/canvas/shared'
import type { CanvasNode, HireProviders } from '../src/canvas/shared'
import { resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import { pinModal, rememberModalOpen, forgetModalPins, forgetModalOpenCache } from '../src/canvas/modalpin'
import type { ProviderInfo, ProvidersPayload, TreePayload } from '../src/types'

const noop = () => {}
const samples = { claude: 'opus', openai: 'sol', google: 'flash', muse: 'wonder',
  openrouter: 'or-fixture', langserver: 'ls-fixture' } as const
const ids = Object.keys(samples) as (keyof typeof samples)[]
const props = { claude: 'claudeHire', openai: 'codexHire', google: 'antigravityHire',
  muse: 'museHire', openrouter: 'openrouterHire', langserver: 'langserverHire' } as const
const agent = (tier = 'haiku'): CanvasNode => ({ id: 'worker', title: 'Worker', generation: 1,
  state: 'live', tier, model_id: tier, parent: USER, children: [], seat: 1, grant: 10, free: 10,
  scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: { bash: true, edit: true, web: true, subagents: true, mcp: [] }, org_visibility: 'team' },
  charter: '', team_charter: '', turns: [], audiences_held: [] }) as unknown as CanvasNode
const tree = (tier: string) => ({ slug: 'menu-org', name: 'Menu org', roots: [agent(tier)], dirs: [],
  max_top_grant: 1000, default_top_grant: 50, default_effort: 'high',
  credit_requests: [], audiences: [], audience_requests: [],
  audit: { live_nodes: 1, top_level_holds: 0, no_overdraft: true, problems: [] },
  cascade_hire: true, cascade_alloc: true }) as unknown as TreePayload
const payload = (): ProvidersPayload => ({ checking: false, providers: ids.map(id => ({ id, label: id, cli: id,
  status: { installed: true, connected: true }, hire_enabled: true,
  tiers: [{ tier: samples[id], provider: id, model: samples[id], seat: 2, letter: 'F' }],
} as ProviderInfo)) })
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const settle = () => inAct(async () => { await flush(12) })
function adopt(p: ProvidersPayload) {
  setMuseProvider(p.providers.find(v => v.id === 'muse') ?? null)
  setOpenRouterTiers(p.providers.find(v => v.id === 'openrouter')?.tiers)
  setLangServerTiers(p.providers.find(v => v.id === 'langserver')?.tiers)
}
async function config(t: TestContext, providers: ProvidersPayload, off?: string, current = 'haiku') {
  const before = globalThis.fetch
  clearProviderDiscovery(); resetStaffingOptionsForTests(); localStorage.clear(); adopt(providers)
  forgetModalPins(); forgetModalOpenCache()
  // Restore the real settings panel: the canvas intentionally omits card gear
  // buttons at its default far zoom, so a gear query is not a stable entry point.
  pinModal('node-config', { x: 10, y: 10, w: 930, h: 630 }, 'menu-org')
  rememberModalOpen('node-config', 'menu-org', { agent: 'worker', generation: 1 })
  globalThis.fetch = legacyAppBackend(async input => {
    const url = String(input)
    return json(url === '/api/providers' ? providers : url.endsWith('/accounts-allowed')
      ? { org: 'menu-org', accounts: ids.map(provider => ({ id: `${provider}/primary`, provider,
          allowed: provider !== off, enabled: true })) }
      : url.includes('accounts') ? { accounts: [] } : url.includes('charters') ? { charters: [] }
      : { ok: true, entries: [], items: [], documents: [], refs: [], live: [], pending_mail: [] })
  })
  const view = await mountView(<OrgCanvas tree={tree(current)} slug="menu-org"
    op={async () => { throw Error('no mutations in a menu test') }} toast={noop} mailEvt={null} onAccounts={noop} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = before; clearProviderDiscovery();
    resetStaffingOptionsForTests(); localStorage.clear(); forgetModalPins(); forgetModalOpenCache(); adopt({ providers: [] }) })
  await settle()
  const modelTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === 'Model')
  assert.ok(modelTab, 'the same configuration panel opened by desk/composer')
  await inAct(() => modelTab.click()); await settle()
  const select = document.querySelector<HTMLSelectElement>('.model-switch select, select.model-switch')
  assert.ok(select, 'real model switch select')
  return select
}

for (const id of ids) for (const condition of ['org-off', 'absent'] as const) {
  test(`canvas model switch: ${id} ${condition} hides other choices and retains its current model`, async t => {
    const p = payload()
    if (condition === 'absent') p.providers = p.providers.filter(v => v.id !== id)
    const select = await config(t, p, condition === 'org-off' ? id : undefined, samples[id])
    assert.equal(select.value, samples[id], 'current value stays selected')
    // Every other family stays available; the unavailable family contains only its selected model.
    const values = [...select.options].map(o => o.value)
    for (const other of ids.filter(v => v !== id)) assert.ok(values.includes(samples[other]), `${other} control`)
    const ownGroup = select.selectedOptions[0]!.parentElement!
    assert.deepEqual([...ownGroup.querySelectorAll('option')].map(o => o.value), [samples[id]])
  })
  test(`canvas model switch: ${id} ${condition} is absent when another model is current`, async t => {
    const p = payload()
    if (condition === 'absent') p.providers = p.providers.filter(v => v.id !== id)
    const select = await config(t, p, condition === 'org-off' ? id : undefined, id === 'claude' ? 'sol' : 'haiku')
    assert.ok(![...select.options].some(o => o.value === samples[id]))
  })
}
test('canvas model switch: incomplete discovery preserves native choices', async t => {
  const select = await config(t, { providers: [], checking: true })
  for (const tier of ['opus', 'sol', 'flash']) assert.ok([...select.options].some(o => o.value === tier))
})
test('canvas model switch: installed signed-out providers remain disabled previews', async t => {
  const p = payload()
  p.providers = p.providers.map(v => ({ ...v, hire_enabled: false, reason: 'sign in', status: { ...v.status, connected: false } }))
  const select = await config(t, p)
  for (const id of ids) {
    const option = [...select.options].find(o => o.value === samples[id])
    assert.ok(option, `${id} remains listed`); assert.equal(option.disabled, true, id)
  }
})

// These active surfaces already consume HireProviders. Cover their actual lists,
// including the popover body used by DraftCard, against both exclusion reasons.
for (const surface of ['sheet', 'draft', 'agent-menu', 'project-menu'] as const)
  for (const condition of ['org-off', 'absent'] as const) test(`${surface}: every provider respects ${condition}`, async t => {
    const before = globalThis.fetch; installFetch(new FakeServer()); adopt(payload())
    t.after(() => { globalThis.fetch = before; adopt({ providers: [] }) })
    for (const id of ids) {
      const hires: HireProviders = {}
      for (const p of payload().providers) hires[props[p.id as keyof typeof props]] = hireOf(
        p.id === id && condition === 'absent' ? { ...p, hire_enabled: false, status: { installed: false, connected: false } } : p,
        false, !(p.id === id && condition === 'org-off'))
      if (surface.endsWith('menu')) {
        const n = surface === 'project-menu' ? { ...agent(), kind: 'project', tier: 'project' } as CanvasNode : agent()
        const entries = agentMenuEntries(n, { onInbox: noop, onSettings: noop, onHire: noop }, hires)
        const hire = entries.find(e => e !== 'sep' && e.label.startsWith('Hire'))
        assert.ok(hire && hire !== 'sep')
        assert.ok(!hire.children?.some(e => e !== 'sep' && e.label === tierLabel(samples[id])))
        continue
      }
      const view = await mountView(surface === 'sheet'
        ? <HireSheet {...hires} anchor={agent()} seats={{}} defaultGrant={0} onHire={noop} onClose={noop} />
        : <SpawnChips {...hires} onSpawn={noop} seats={{}} soleHire />, el => el)
      try {
        assert.ok(!document.querySelector(`button.t-${samples[id]}`), id)
        for (const other of ids.filter(v => v !== id)) assert.ok(document.querySelector(`button.t-${samples[other]}`), other)
      } finally { await view.unmount() }
    }
  })
