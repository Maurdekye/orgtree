import { flush, inAct, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { legacyAppBackend } from './appfeed-fixture'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { QuickChat } from '../src/QuickChatBox'
import { clearProviderDiscovery } from '../src/api'
import { setMuseProvider, setOpenRouterTiers, setLangServerTiers } from '../src/canvas/shared'
import { resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import { bumpLive, flushLive } from '../src/livebus'
import type { OrgAccountLane, ProviderInfo, ProvidersPayload, TreePayload } from '../src/types'

const noop = () => {}
const samples = { claude: 'opus', openai: 'sol', google: 'flash', muse: 'wonder',
  openrouter: 'or-fixture-model', langserver: 'ls-fixture-model' } as const
const ids = Object.keys(samples) as (keyof typeof samples)[]
const tree = (slug: string) => ({ slug, name: slug, roots: [], dirs: [],
  max_top_grant: 1000, default_top_grant: 50, default_effort: 'high',
  credit_requests: [], audiences: [], audience_requests: [],
  audit: { live_nodes: 0, top_level_holds: 0, no_overdraft: true, problems: [] },
  cascade_hire: true, cascade_alloc: true }) as unknown as TreePayload
const lane = (provider: string, allowed = true, enabled = true, suffix = 'primary'): OrgAccountLane => ({
  id: `${provider}:${suffix}`, provider, label: `${provider} ${suffix}`, allowed, enabled,
})
const all = () => ids.map(id => lane(id))
const payload = (signedOut?: string): ProvidersPayload => ({ checking: false,
  providers: ids.map(id => ({ id, label: id, cli: id,
    status: { installed: true, connected: id !== signedOut },
    hire_enabled: id !== signedOut, reason: id === signedOut ? 'sign in' : null,
    tiers: [{ tier: samples[id], provider: id, model: `fixture/${samples[id]}`, seat: 2, letter: 'F' }],
  } as ProviderInfo)),
})
const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
})
const settle = () => inAct(async () => { await flush(12) })
const changed = () => inAct(async () => { bumpLive(); flushLive(); await flush(12) })
const tokens = (scope: ParentNode, id: keyof typeof samples) =>
  [...scope.querySelectorAll<HTMLButtonElement>(`.hsof button.t-${samples[id]}`)]

async function fixture(t: TestContext, surface: 'canvas' | 'quickchat', options: {
  lanes?: (slug: string) => Promise<Response> | Response
  providers?: ProvidersPayload
} = {}) {
  const oldFetch = globalThis.fetch
  clearProviderDiscovery(); resetStaffingOptionsForTests(); localStorage.clear()
  const providers = options.providers ?? payload()
  // These are the same registries the app feed adopts before rendering.
  setMuseProvider(providers.providers.find(p => p.id === 'muse') ?? null)
  setOpenRouterTiers(providers.providers.find(p => p.id === 'openrouter')?.tiers)
  setLangServerTiers(providers.providers.find(p => p.id === 'langserver')?.tiers)
  const reads: string[] = []
  globalThis.fetch = legacyAppBackend(async input => {
    const url = String(input)
    const match = url.match(/^\/api\/orgs\/([^/]+)\/accounts-allowed$/)
    if (match) {
      reads.push(match[1])
      return options.lanes?.(match[1]) ?? json({ org: match[1], accounts: all() })
    }
    return json(url === '/api/providers' ? providers
      // A cached staffing offer must not override freshly changed org access.
      : url.includes('staffing-options') ? { tiers: Object.values(samples).map(tier => ({
          tier, seat: 2, efforts: ['high'], accounts: [], default_ok: true,
        })), loading: false, stale: false, errors: [], at: 0, generation: 0 }
      : url.includes('accounts') ? { accounts: [] }
      : url.includes('charters') ? { charters: [] }
      : { ok: true, tiers: [], entries: [], items: [], documents: [], refs: [], live: [], pending_mail: [] })
  })
  const op = async () => { throw Error('fixture must never hire or call a live engine') }
  const element = (slug: string) => surface === 'canvas'
    ? <OrgCanvas tree={tree(slug)} slug={slug} op={op} toast={noop} mailEvt={null} onAccounts={noop} />
    : <QuickChat tree={tree(slug)} slug={slug} op={op} toast={noop} onHired={noop} />
  const view = await mountView(element('first'), el => el)
  t.after(async () => {
    await view.unmount(); globalThis.fetch = oldFetch
    clearProviderDiscovery(); resetStaffingOptionsForTests(); localStorage.clear()
    setMuseProvider(null); setOpenRouterTiers([]); setLangServerTiers([])
  })
  await settle()
  if (surface === 'quickchat') await inAct(() => view.el.querySelector<HTMLButtonElement>('.quickchat-model')!.click())
  const scope = () => surface === 'canvas' ? view.el : document.querySelector('.quickchat-pop')!
  const expand = async () => inAct(() => {
    for (const button of scope().querySelectorAll<HTMLButtonElement>('.hire-expand[aria-expanded="false"]')) button.click()
  })
  await settle(); await expand()
  assert.ok(scope()?.querySelector('.hsof'), 'actual hire strip is mounted')
  return { view, scope, reads, expand, switchOrg: async (slug: string) => {
    await view.render(element(slug)); await settle(); await expand()
  } }
}

for (const surface of ['canvas', 'quickchat'] as const) for (const id of ids) {
  test(`${surface}: ${id} hides when all org accounts are off; one enabled secondary restores it`, async t => {
    let lanes = all().map(row => row.provider === id ? { ...row, allowed: false } : row)
    lanes.push(lane(id, false, true, 'secondary'))
    const f = await fixture(t, surface, { lanes: slug => json({ org: slug, accounts: lanes }) })
    assert.equal(tokens(f.scope(), id).length, 0, `${id} must be hidden`)
    for (const other of ids.filter(p => p !== id)) assert.ok(tokens(f.scope(), other).length > 0, other)
    lanes = lanes.map(row => row.id === `${id}:secondary` ? { ...row, allowed: true } : row)
    await changed(); await f.expand()
    assert.ok(tokens(f.scope(), id).length > 0, 'enabled secondary is sufficient')
    lanes = lanes.map(row => row.provider === id ? { ...row, enabled: false } : row)
    await changed(); await f.expand()
    assert.equal(tokens(f.scope(), id).length, 0, 'an org tick cannot enable an app-disabled account')
    assert.ok(f.reads.length >= 3, 'the canonical org lane endpoint supplied each decision')
  })
}

for (const surface of ['canvas', 'quickchat'] as const) {
  test(`${surface}: all providers allowed keeps every family; sign-out stays a disabled preview`, async t => {
    const f = await fixture(t, surface, { providers: payload('openai') })
    for (const id of ids) {
      const buttons = tokens(f.scope(), id)
      assert.ok(buttons.length > 0, `${id} remains visible`)
      assert.ok(buttons.every(b => b.disabled === (id === 'openai')), `${id} existing sign-in gate`)
    }
  })

  test(`${surface}: unknown account list preserves discovery until the org response arrives`, async t => {
    const pending: ((r: Response) => void)[] = []
    const f = await fixture(t, surface, { lanes: () => new Promise(resolve => pending.push(resolve)) })
    for (const id of ids) assert.ok(tokens(f.scope(), id).length > 0, `${id} loading behavior`)
    await inAct(async () => { for (const resolve of pending) resolve(json({ org: 'first', accounts: [] })); await flush(12) })
    for (const id of ids) assert.equal(tokens(f.scope(), id).length, 0, `${id} has no permitted lane`)
  })

  test(`${surface}: org switch and out-of-order replies cannot restore another org's denied chips`, async t => {
    const pending: { slug: string; resolve: (r: Response) => void }[] = []
    const f = await fixture(t, surface, { lanes: slug => new Promise(resolve => pending.push({ slug, resolve })) })
    await f.switchOrg('second')
    await inAct(async () => {
      for (const p of pending.filter(p => p.slug === 'second')) p.resolve(json({ org: 'second', accounts: [] }))
      await flush(12)
    })
    await inAct(async () => {
      for (const p of pending.filter(p => p.slug === 'first')) p.resolve(json({ org: 'first', accounts: all() }))
      await flush(12)
    })
    for (const id of ids) assert.equal(tokens(f.scope(), id).length, 0, `${id}: late other-org response ignored`)
  })

  test(`${surface}: newest same-org permission read wins over a delayed older response`, async t => {
    const pending: ((r: Response) => void)[] = []
    const f = await fixture(t, surface, { lanes: () => new Promise(resolve => pending.push(resolve)) })
    const old = pending.splice(0)
    await changed()
    assert.ok(pending.length > 0, 'saved settings refreshed org access')
    await inAct(async () => { for (const resolve of pending) resolve(json({ org: 'first', accounts: [] })); await flush(12) })
    await inAct(async () => { for (const resolve of old) resolve(json({ org: 'first', accounts: all() })); await flush(12) })
    for (const id of ids) assert.equal(tokens(f.scope(), id).length, 0, `${id}: delayed response ignored`)
  })
}
