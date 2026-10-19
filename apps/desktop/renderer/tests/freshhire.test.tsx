import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { legacyAppBackend } from './appfeed-fixture'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { QuickChat } from '../src/QuickChatBox'
import { clearProviderDiscovery } from '../src/api'
import { setMuseProvider } from '../src/canvas/shared'
import { resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import type { ProviderInfo, ProvidersPayload, TreePayload } from '../src/types'

// Rust providers::payload omits uninstalled harnesses. The older availability
// tests supplied explicit installed:false rows, so never exercised this shape.
const noop = () => {}
const tree = { slug: 'fresh-hire', name: 'Fresh hire', roots: [], dirs: [],
  max_top_grant: 1000, default_top_grant: 50, default_effort: 'high',
  credit_requests: [], audiences: [], audience_requests: [],
  audit: { live_nodes: 0, top_level_holds: 0, no_overdraft: true, problems: [] },
  cascade_hire: true, cascade_alloc: true } as unknown as TreePayload
const samples = { claude: 'opus', openai: 'sol', google: 'flash' } as const
function provider(id: string, connected = true): ProviderInfo {
  return { id, label: id, cli: id, status: { installed: true, connected },
    hire_enabled: connected, reason: connected ? null : 'sign in to this harness',
    tiers: [] }
}

const scenarios: { name: string; payload: ProvidersPayload; visible: string[]; disabled?: boolean }[] = [
  { name: 'fresh machine with no harnesses', payload: { providers: [], checking: false }, visible: [] },
  ...Object.keys(samples).map(id => ({ name: `only ${id} installed`,
    payload: { providers: [provider(id)], checking: false }, visible: [id] })),
  { name: 'installed but signed out', payload: { providers: [provider('openai', false)], checking: false },
    visible: ['openai'], disabled: true },
  { name: 'first probe still checking', payload: { providers: [], checking: true }, visible: Object.keys(samples) },
  { name: 'legacy payload without checking', payload: { providers: [] }, visible: Object.keys(samples) },
]

for (const surface of ['canvas', 'quickchat'] as const) for (const scenario of scenarios) {
  test(`${surface}: ${scenario.name} uses sparse discovery, without changing Muse`, async t => {
    const oldFetch = globalThis.fetch
    clearProviderDiscovery(); resetStaffingOptionsForTests(); setMuseProvider(null); localStorage.clear()
    let providerReads = 0
    globalThis.fetch = legacyAppBackend(async input => {
      const url = String(input)
      const body = url === '/api/providers' ? (providerReads++, scenario.payload)
        // 4.4 Quick chat additionally filters by staffing. A cached offer must
        // never override this machine's completed absence observation.
        : url.includes('staffing-options') ? { tiers: Object.values(samples).map(tier => ({
            tier, seat: 2, efforts: ['high'], accounts: [], default_ok: true,
          })), loading: false, stale: false, errors: [], at: 0, generation: 0 }
        : url.includes('accounts') ? { accounts: [] }
        : url.includes('charters') ? { charters: [] }
        : { ok: true, tiers: [], entries: [], items: [], documents: [], refs: [], live: [], pending_mail: [] }
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    })
    const op = async () => { throw new Error('availability must not hire or call a live engine') }
    const view = await mountView(surface === 'canvas'
      ? <OrgCanvas tree={tree} slug={tree.slug} op={op} toast={noop} mailEvt={null} onAccounts={noop} />
      : <QuickChat tree={tree} slug={tree.slug} op={op} toast={noop} onHired={noop} />, el => el)
    t.after(async () => {
      await view.unmount(); globalThis.fetch = oldFetch
      clearProviderDiscovery(); resetStaffingOptionsForTests(); setMuseProvider(null); localStorage.clear()
    })
    await inAct(async () => { await flush(10) })
    assert.ok(providerReads > 0, 'the real provider reader consumed the fixture')
    if (surface === 'quickchat') {
      await inAct(() => view.el.querySelector<HTMLButtonElement>('.quickchat-model')!.click())
      await inAct(async () => { await flush(4) })
    }
    // Exercise the actual rendered strips, expanding any compact canvas tray.
    await inAct(() => {
      for (const button of document.querySelectorAll<HTMLButtonElement>('.hire-expand[aria-expanded="false"]')) button.click()
    })
    const scope = surface === 'canvas' ? view.el : document.querySelector('.quickchat-pop')!
    assert.ok(scope, 'the hire surface exists')
    assert.ok(scope.querySelector('.hsof'), 'at least one actual token strip was rendered')
    for (const [id, tier] of Object.entries(samples)) {
      const tokens = [...scope.querySelectorAll<HTMLButtonElement>(`.hsof button.t-${tier}`)]
      assert.equal(tokens.length > 0, scenario.visible.includes(id), `${id} presence`)
      if (scenario.visible.includes(id)) for (const token of tokens)
        assert.equal(token.disabled, !!scenario.disabled, `${id} sign-in gate`)
    }
    assert.equal(scope.querySelector('.hsof button.t-wonder') === null, true,
      'Muse still requires its catalog, even while other discovery is unknown')
    if (!scenario.visible.length) assert.ok(scope.querySelector('.hs-none'), 'no-harness remedy remains reachable')
  })
}
