// tierlisting.test.tsx — the one listing rule (user 2026-10-13): wherever the
// models of a provider are listed together, the dearest comes first and
// equal seats keep the order they had. User 2026-10-14 excepted hire tokens:
// each provider row/column is cheapest-first; selectors and defaults stay as below.
//
//   Claude  fable, opus, sonnet, haiku        Muse  wonder-full, wonder, spark
//   Codex   astra, [terra], sol, luna         Antigravity  agy-opus, [pro, argon, barium, carbon,]
//                                                          agy-sonnet, flash
//   OpenRouter's chosen models: output price (then input price, then name)
//   descending, free ones after the priced, unknown prices last.
//
//   §1 the rule: bySeatDesc is stable, never reads a missing seat as the dearest
//   §2 the family lists, and the DEFAULT order (the first offered model) that did not move
//   §3 hireTierChoices: menus read the listing order, Quick chat's fallback the default order
//   §4 the OpenRouter order: priced, free, unknown
//   §5 every chooser: the canvas hire chips, the hire sheet (and what it opens on), the
//      agent settings model switch and the rehire list

import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_TIERS, ANTIGRAVITY_TIERS, ANTIGRAVITY_TIERS_LISTED, bySeatDesc, byOpenrouterPriceDesc, CODEX_TIERS,
  CODEX_TIERS_LISTED, hireTierChoices, MUSE_TIERS, MUSE_TIERS_LISTED, openrouterPriceClass,
  setMuseProvider, setOfferedConditionalTiers, setOpenRouterTiers, setLangServerTiers, TIERS, TIERS_LISTED, USER,
} from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import { quickChatTier } from '../src/quickchat'
import { NodeSquare, SpawnChips } from '../src/canvas/cards'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { NodeConfig } from '../src/canvas/modals'
import { LineagePanel } from '../src/canvas/desk'
import type { LineageEntry, OpResult, ProviderInfo, ProviderTier, TreePayload } from '../src/types'

const noop = () => {}
const SEATS = { haiku: 0.5, sonnet: 2, opus: 4, fable: 10, 'gpt-reserve': 0.2,
  luna: 0.1, terra: 2, sol: 2, astra: 10, flash: 1, pro: 2, argon: 2, barium: 2, carbon: 2,
  'agy-sonnet': 2, 'agy-opus': 4, wonder: 4, 'wonder-full': 10, spark: 2 }
const ON: HireState = { enabled: true, installed: true, reason: null }
const ABSENT: HireState = { enabled: false, installed: false, reason: 'not installed' }
const MUSE_ROWS = ['wonder', 'wonder-full', 'spark']
const museHire: HireState = { ...ON, offeredTiers: MUSE_ROWS }
const museProvider: ProviderInfo = {
  id: 'muse', label: 'Muse', cli: 'muse', hire_enabled: true, reason: null,
  status: { installed: true, connected: true },
  tiers: MUSE_ROWS.map((tier) => ({ tier, provider: 'muse', seat: SEATS[tier as keyof typeof SEATS], model: tier, letter: 'W' })),
  muse: { logins: [] },
} as unknown as ProviderInfo

function fresh(t: TestContext) {
  localStorage.clear()
  installFetch(new FakeServer())
  setOfferedConditionalTiers([])
  setMuseProvider(museProvider)
  t.after(() => { setOfferedConditionalTiers([]); setMuseProvider(null) })
}

function agent(tier = 'haiku', lineage: LineageEntry[] = []): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier, model_id: tier,
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [], lineage,
  } as unknown as CanvasNode
}

const tierOf = (el: Element): string =>
  el.className.split(/\s+/).find((c) => c.startsWith('t-'))?.slice(2) ?? ''
const within = (seen: string[], family: readonly string[]) => seen.filter((t) => family.includes(t))

/* ── §1 the rule ─────────────────────────────────────────────────────────── */

test('§1 bySeatDesc: the dearest first, equal seats keep their order, a missing seat is never the dearest', () => {
  const seat: Record<string, number> = { a: 2, b: 10, c: 2, d: 0.5, e: 10 }
  assert.deepEqual(bySeatDesc(['a', 'b', 'c', 'd', 'e'], (t) => seat[t]!), ['b', 'e', 'a', 'c', 'd'])
  // the same ties in another input order keep THAT order (stable, not alphabetical)
  assert.deepEqual(bySeatDesc(['e', 'c', 'b', 'a'], (t) => seat[t]!), ['e', 'b', 'c', 'a'])
  // a tier with no seat (undefined, NaN) lists after every priced one
  assert.deepEqual(bySeatDesc(['x', 'a', 'y', 'd'], (t) => seat[t] as number), ['a', 'd', 'x', 'y'])
  // it returns a new array and leaves its input alone
  const input = ['d', 'b']
  assert.deepEqual(bySeatDesc(input, (t) => seat[t]!), ['b', 'd'])
  assert.deepEqual(input, ['d', 'b'])
})

/* ── §2 the family lists and the defaults ────────────────────────────────── */

test('§2 each provider lists its models dearest first, and the provider-neutral list follows', () => {
  assert.deepEqual(TIERS_LISTED, ['fable', 'opus', 'sonnet', 'haiku'])
  // terra and sol tie at 2: the order the family already had (terra, then sol)
  assert.deepEqual(CODEX_TIERS_LISTED, ['astra', 'terra', 'sol', 'gpt-reserve', 'luna'])
  // Claude-backed tiers are one group, followed by Gemini tiers.
  assert.deepEqual(ANTIGRAVITY_TIERS_LISTED, ['agy-opus', 'agy-sonnet', 'pro', 'argon', 'barium', 'carbon', 'flash'])
  assert.deepEqual(MUSE_TIERS_LISTED, ['wonder-full', 'wonder', 'spark'])
  assert.deepEqual(ALL_TIERS, [...TIERS_LISTED, ...CODEX_TIERS_LISTED, ...ANTIGRAVITY_TIERS_LISTED, ...MUSE_TIERS_LISTED])
})

test('§2 the order a DEFAULT is taken from did not move (the hire sheet and Quick chat open on the first offered)', () => {
  assert.deepEqual(TIERS, ['haiku', 'sonnet', 'opus', 'fable'])
  assert.deepEqual(CODEX_TIERS, ['gpt-reserve', 'luna', 'terra', 'sol', 'astra'])
  assert.deepEqual(ANTIGRAVITY_TIERS, ['flash', 'pro', 'argon', 'barium', 'carbon', 'agy-sonnet', 'agy-opus'])
  assert.deepEqual(MUSE_TIERS, ['wonder', 'wonder-full', 'spark'])
})

/* ── §3 hireTierChoices ───────────────────────────────────────────────────── */

test('§3 menus list the dearest first; Quick chat\'s "first offered" fallback keeps the default order', (t: TestContext) => {
  fresh(t)
  const only = { claudeHire: ABSENT, codexHire: ABSENT, antigravityHire: ABSENT, openrouterHire: ABSENT, langserverHire: ABSENT }
  const offered = (order?: 'listed' | 'default') =>
    hireTierChoices({ ...only, museHire }, order).filter((c) => c.offer === 'offer').map((c) => c.tier)
  assert.deepEqual(offered(), ['wonder-full', 'wonder', 'spark'], 'the menus')
  assert.deepEqual(offered('listed'), ['wonder-full', 'wonder', 'spark'])
  assert.deepEqual(offered('default'), ['wonder', 'wonder-full', 'spark'], 'the default order')
  // Muse alone: Quick chat still opens on Wonder, not on the dearest model
  assert.equal(quickChatTier(undefined, offered('default')), 'wonder')
  assert.equal(quickChatTier(undefined, offered('listed')), 'wonder-full', 'control: the listing order WOULD have moved it')
  // a model chosen before is still the one shown
  assert.equal(quickChatTier('spark', offered('default')), 'spark')
  // every provider at once: each family in listing order, families in the order they were
  const all = hireTierChoices({ claudeHire: ON, codexHire: ON, antigravityHire: ON, museHire }).filter((c) => c.offer === 'offer').map((c) => c.tier)
  assert.deepEqual(within(all, TIERS), ['fable', 'opus', 'sonnet', 'haiku'])
  assert.deepEqual(within(all, CODEX_TIERS), ['astra', 'sol', 'luna'].filter((x) => all.includes(x)))
  assert.deepEqual(within(all, MUSE_TIERS), ['wonder-full', 'wonder', 'spark'])
  assert.ok(all.indexOf('fable') < all.indexOf('astra') && all.indexOf('astra') < all.indexOf('flash')
    && all.indexOf('flash') < all.indexOf('wonder-full'), 'the provider order did not change')
})

/* ── §4 the OpenRouter order ──────────────────────────────────────────────── */

const or = (name: string, prompt: number | undefined, completion: number | undefined, unknown?: string[]): ProviderTier => ({
  tier: 'or-' + name, provider: 'openrouter', seat: 1, model: 'v/' + name, letter: 'X', name, prompt, completion,
  ...(unknown ? { price_unknown: unknown } : {}),
} as ProviderTier)

test('§4 the chosen OpenRouter models: the dearest output price first, then input price, then name', () => {
  const order = (...v: ProviderTier[]) => [...v].sort(byOpenrouterPriceDesc).map((x) => x.name)
  assert.deepEqual(order(or('Cheap', 0.1, 0.4), or('Dear', 5, 25), or('MidB', 1, 5), or('MidA', 1, 5), or('MidIn', 3, 5)),
    ['Dear', 'MidIn', 'MidA', 'MidB', 'Cheap'])
  // the same models given in another order list the same way
  assert.deepEqual(order(or('MidIn', 3, 5), or('Cheap', 0.1, 0.4), or('MidA', 1, 5), or('Dear', 5, 25), or('MidB', 1, 5)),
    ['Dear', 'MidIn', 'MidA', 'MidB', 'Cheap'])
})

test('§4 free models follow the priced ones and an unknown price is last, never $0', () => {
  const list = [or('Unknown', 0, 0, ['prompt', 'completion']), or('FreeB', 0, 0), or('Tiny', 0, 0.01),
    or('Half', 2, 0, ['completion']), or('FreeA', 0, 0), or('Dear', 1, 2), or('NoRates', undefined, undefined)]
  assert.deepEqual([...list].sort(byOpenrouterPriceDesc).map((x) => x.name),
    ['Dear', 'Tiny', 'FreeA', 'FreeB', 'Half', 'NoRates', 'Unknown'])
  assert.deepEqual(list.map(openrouterPriceClass), [2, 1, 0, 2, 1, 0, 2])
})

/* ── §5 every chooser ─────────────────────────────────────────────────────── */

function card(node: CanvasNode) {
  return mountView(
    <NodeSquare node={node as Parameters<typeof NodeSquare>[0]['node']}
      pos={{ x: 0, y: 0 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={SEATS}
      map={new Map()} op={() => Promise.resolve({} as never)} slug="org"
      toast={noop} pxc={1} zoom={1}
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
      onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
      onRecenter={noop} onJump={noop} cascadeAlloc
      maxTop={100} onMailLink={noop} onWorkLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      onDragCancel={noop}
      claudeHire={ON} codexHire={ON}
      antigravityHire={{ ...ON, offeredTiers: ['flash', 'pro', 'argon', 'barium', 'carbon', 'agy-sonnet', 'agy-opus'] }} onNoHarness={noop} />,
    (el) => el)
}

test('§5 canvas hire chips: each family cheapest first', async (t: TestContext) => {
  fresh(t)
  const v = await card(agent())
  t.after(() => v.unmount())
  const strip = v.el.querySelector<HTMLElement>('.hsof:not(.side)')!
  const expand = strip.querySelector<HTMLButtonElement>('.hire-expand')
  if (expand) await inAct(() => expand.click())
  const seen = [...v.el.querySelectorAll<HTMLButtonElement>('.hsof:not(.side) button')].map(tierOf)
  assert.deepEqual(within(seen, TIERS), ['haiku', 'sonnet', 'opus', 'fable'])
  assert.deepEqual(within(seen, CODEX_TIERS), ['luna', 'sol', 'astra'])
  assert.deepEqual(within(seen, ANTIGRAVITY_TIERS), ['agy-sonnet', 'agy-opus', 'flash', 'argon', 'barium', 'carbon'])
  assert.deepEqual(within(seen, MUSE_TIERS), ['spark', 'wonder', 'wonder-full'])
})

for (const side of [undefined, 'left', 'right', 'top'] as const) {
  test(`hire price ${side ?? 'bottom'}: payload seats, stable ties, family order and actions stay truthful`, async t => {
    fresh(t)
    const custom = { ...SEATS, haiku: 8, sonnet: 1, opus: 1, fable: .25,
      luna: 6, sol: 2, astra: .5, spark: 11, wonder: 4, 'wonder-full': .75 }
    const hired: string[] = []
    const v = await mountView(<SpawnChips side={side} seats={custom} onSpawn={tier => hired.push(tier)}
      claudeHire={ON} codexHire={ON} antigravityHire={{ ...ON, offeredTiers: ['flash', 'carbon', 'agy-sonnet', 'agy-opus'] }} />, el => el)
    t.after(() => v.unmount())
    const rows = [...v.el.querySelectorAll('.hs-fam')].map(row => [...row.querySelectorAll('button')].map(tierOf))
    const expected = [
      ['fable', 'sonnet', 'opus', 'haiku'], ['agy-sonnet', 'agy-opus', 'flash', 'carbon'],
      ['astra', 'sol', 'luna'], ['wonder-full', 'wonder', 'spark'],
    ]
    assert.deepEqual(rows, side === 'top' || side === 'left' ? [...expected].reverse() : expected)
    const sonnet = [...v.el.querySelectorAll<HTMLButtonElement>('button')].find(button => tierOf(button) === 'sonnet')!
    assert.ok(sonnet.title.endsWith('(-1)'))
    await inAct(() => sonnet.click()); assert.deepEqual(hired, ['sonnet'])
    // A price refresh reorders the existing strip without changing groups.
    await v.render(<SpawnChips side={side} seats={{ ...custom, haiku: .1 }} onSpawn={tier => hired.push(tier)}
      claudeHire={ON} codexHire={ON} antigravityHire={{ ...ON, offeredTiers: ['flash', 'carbon', 'agy-sonnet', 'agy-opus'] }} />)
    const claude = [...v.el.querySelectorAll('.hs-fam')].find(row => row.querySelector('.t-haiku'))!
    assert.deepEqual([...claude.querySelectorAll('button')].map(tierOf), ['haiku', 'fable', 'sonnet', 'opus'])
    assert.equal(v.el.querySelector('.t-pro'), null, 'legacy hidden remains hidden')
    assert.equal(v.el.querySelector('.t-argon'), null, 'conditional unoffered remains hidden')
  })
}

test('hire price: disabled and far-expanded rows retain ascending order and conditional price slots', async t => {
  fresh(t)
  const disabled = { ...ON, enabled: false, reason: 'signed out' }
  const v = await mountView(<SpawnChips seats={SEATS} onSpawn={noop} zoom={.1} expanded
    claudeHire={disabled} codexHire={disabled} antigravityHire={{ ...disabled, offeredTiers: ['flash', 'argon', 'barium', 'agy-sonnet', 'agy-opus'] }} />, el => el)
  t.after(() => v.unmount())
  assert.ok(v.el.querySelector('.hire-compact.is-expanded'))
  const rows = [...v.el.querySelectorAll('.hs-fam')]
  const google = rows.find(row => row.querySelector('.t-argon'))!
  assert.deepEqual([...google.querySelectorAll('button')].map(tierOf), ['agy-sonnet', 'agy-opus', 'flash', 'argon', 'barium'])
  assert.ok([...google.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled))
  const claude = rows.find(row => row.querySelector('.t-haiku'))!
  assert.deepEqual([...claude.querySelectorAll('button')].map(tierOf), ['haiku', 'sonnet', 'opus', 'fable'])
})

test('hire price: registry rows sort by seat credits and keep ties in incoming order', async t => {
  fresh(t)
  const rows = (provider: string, prefix: string) => [
    { tier: `${prefix}-high`, provider, seat: 7, model: 'high', letter: 'H' },
    { tier: `${prefix}-low`, provider, seat: 1, model: 'low', letter: 'L' },
    { tier: `${prefix}-tie`, provider, seat: 1, model: 'tie', letter: 'T' },
  ] as ProviderTier[]
  setOpenRouterTiers(rows('openrouter', 'or'))
  setLangServerTiers(rows('langserver', 'ls'))
  t.after(() => { setOpenRouterTiers([]); setLangServerTiers([]) })
  const v = await mountView(<SpawnChips seats={{}} onSpawn={noop} claudeHire={ABSENT} codexHire={ABSENT}
    antigravityHire={ABSENT} openrouterHire={ON} langserverHire={ON} />, el => el)
  t.after(() => v.unmount())
  for (const prefix of ['or', 'ls']) {
    const row = [...v.el.querySelectorAll('.hs-fam')].find(row => row.querySelector(`.t-${prefix}-low`))!
    assert.deepEqual([...row.querySelectorAll('button')].map(tierOf), [`${prefix}-low`, `${prefix}-tie`, `${prefix}-high`])
  }
})

test('§5 hire sheet: each family dearest first, and it still opens on the first model of the default order', async (t: TestContext) => {
  fresh(t)
  const v = await mountView(
    <HireSheet anchor={agent()} seats={SEATS} defaultGrant={0}
      claudeHire={ON} codexHire={ON} antigravityHire={{ ...ON, offeredTiers: ['flash', 'pro', 'argon', 'barium', 'carbon', 'agy-sonnet', 'agy-opus'] }}
      museHire={museHire} onHire={noop} onClose={noop} />, (el) => el)
  t.after(() => v.unmount())
  await flush()
  const rows = [...document.querySelectorAll('.hs-tiers')].map((r) => [...r.querySelectorAll<HTMLButtonElement>('.hs-tier')].map(tierOf))
  const family = (tier: string) => rows.find((r) => r.includes(tier))!
  assert.deepEqual(family('haiku'), ['fable', 'opus', 'sonnet', 'haiku'])
  assert.deepEqual(family('luna'), ['astra', 'sol', 'luna'])
  assert.deepEqual(family('flash'), ['agy-opus', 'agy-sonnet', 'argon', 'barium', 'carbon', 'flash'])
  assert.deepEqual(family('spark'), ['wonder-full', 'wonder', 'spark'])
  // the pre-selected model is the first OFFERED one in the old order (haiku), not the first on screen (fable)
  const on = [...document.querySelectorAll<HTMLButtonElement>('.hs-tier.on')].map(tierOf)
  assert.deepEqual(on, ['haiku'], 'the default did not move to the dearest model')
})

function config(node: CanvasNode) {
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const google: ProviderInfo = { id: 'google', label: 'Antigravity', cli: 'agy',
    tiers: ['flash', 'pro', 'agy-sonnet', 'agy-opus'].map((tier) => ({ tier, provider: 'google', seat: SEATS[tier as keyof typeof SEATS], model: tier, letter: 'A' })),
    status: { installed: true, connected: true, kind: 'google' }, hire_enabled: true, reason: null } as unknown as ProviderInfo
  return mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={null} antigravityProvider={google} museProvider={museProvider} close={noop} />,
    (el) => el)
}

test('§5 agent settings model switch: every group dearest first', async (t: TestContext) => {
  fresh(t)
  const v = await config(agent('flash'))
  t.after(() => v.unmount())
  const group = (label: string) => [...v.el.querySelectorAll<HTMLOptGroupElement>('.model-switch optgroup')]
    .find((g) => g.label === label)
  const values = (label: string) => [...(group(label)?.querySelectorAll<HTMLOptionElement>('option') ?? [])].map((o) => o.value)
  assert.deepEqual(values('Claude'), ['fable', 'opus', 'sonnet', 'haiku'])
  assert.deepEqual(values('Antigravity'), ['agy-opus', 'agy-sonnet', 'flash'].filter((x) => values('Antigravity').includes(x)))
  assert.deepEqual(values('Muse'), ['wonder-full', 'wonder', 'spark'])
  assert.ok(values('Antigravity').includes('flash') && values('Antigravity').indexOf('flash') === values('Antigravity').length - 1,
    'flash (the cheapest Antigravity model) is last')
})

test('§5 lineage rehire list: the provider-neutral list in listing order', async (t: TestContext) => {
  fresh(t)
  const node = agent('flash', [{ id: 'agent@1', generation: 1, state: 'archived',
    bearer_state: 'knowledge', tier: 'flash' } as LineageEntry])
  const v = await mountView(
    <LineagePanel node={node} slug="org" close={noop}
      op={() => Promise.resolve({} as OpResult)} />, (el) => el)
  t.after(() => v.unmount())
  const values = [...v.el.querySelectorAll<HTMLOptionElement>('.lin-row select option')].map((o) => o.value).filter(Boolean)
  assert.deepEqual(within(values, TIERS), ['fable', 'opus', 'sonnet', 'haiku'])
  assert.deepEqual(within(values, MUSE_TIERS), ['wonder-full', 'wonder', 'spark'].filter((x) => values.includes(x)))
})
