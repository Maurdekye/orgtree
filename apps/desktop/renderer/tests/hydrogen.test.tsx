// hydrogen.test.tsx — Gemini 4 Hydrogen takes Gemini 3.8 Flash's place.
//
// USER 2026-11-12 m6b3dbb2cfa71: add gemini-4-hydrogen; Flash moves behind the legacy-models toggle.
// USER 2026-11-13 md16909f83245: Flash goes behind the toggle NOW; Hydrogen's price is shown as an estimate.
// USER 2026-11-13 m6258781910ea: "make hydrogen always available unconditionally regardless of the check".
// USER 2026-11-12 m7941d5c20ccc: colour "Near-white / pale silver".
//
//   §1 the rule: Hydrogen is an always-offered Antigravity tier (never conditional); Flash is opt-in legacy
//   §2 the hire chips and the hire sheet: Hydrogen without any payload row; Flash only with the toggle, marked
//   §3 an agent already on Flash keeps its own tier in the switch, its F token and its colour
//   §4 the colour: near-white on every tier surface, with a dark backing on the light themes' hire button
//   §5 the spend badge marks a total that includes an estimated turn
import { FakeServer, flush, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ANTIGRAVITY_TIERS, ANTIGRAVITY_TIERS_LISTED, ANTIGRAVITY_TIER_SEAT, antigravityTierOffer,
  CONDITIONAL_ANTIGRAVITY_TIERS, conditionalTierHidden, legacyMark, OPT_IN_LEGACY_TIERS, optInLegacyHidden,
  setOfferedConditionalTiers, setShowLegacyModelsOn, TIER_LETTER, USER,
} from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import { NodeSquare } from '../src/canvas/cards'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { NodeConfig } from '../src/canvas/modals'
import { SpendBadge } from '../src/canvas/desk'
import type { OpResult, ProviderInfo, TreePayload, TurnStat } from '../src/types'

declare const __SRC_DIR__: string
const noop = () => {}
const SEATS = { haiku: 1, sonnet: 2, opus: 4, fable: 10, 'gpt-reserve': 0.2,
  luna: 0.1, terra: 1, sol: 2, astra: 10, flash: 1, hydrogen: 1, pro: 2 }
const ON: HireState = { enabled: true, installed: true, reason: null }
/** an Antigravity whose payload rows list NOTHING: an account whose `agy models` has no Gemini 4 model at all */
const BARE: HireState = { ...ON, offeredTiers: [] }

function fresh(t: TestContext) {
  localStorage.clear()
  installFetch(new FakeServer())
  setOfferedConditionalTiers([])
  setShowLegacyModelsOn(false)
  t.after(() => { setOfferedConditionalTiers([]); setShowLegacyModelsOn(false); localStorage.clear() })
}

function agent(tier = 'haiku'): CanvasNode {
  return {
    id: 'agent', title: 'agent', state: 'live', tier, model_id: tier,
    parent: USER, children: [], seat: 1, grant: 10, free: 10,
    scope: { permission_mode: 'acceptEdits', add_dirs: [], tools: {
      bash: true, web: true, edit: true, subagents: true, mcp: [],
    }, org_visibility: 'team' },
    charter: '', team_charter: '', turns: [], audiences_held: [], lineage: [],
  } as unknown as CanvasNode
}

const hasClass = (el: Element, c: string) => el.className.split(/\s+/).includes(c)

/* ── §1 the rule ─────────────────────────────────────────────────────────── */

test('§1 hydrogen is always offered, never conditional; flash is an opt-in legacy tier', (t: TestContext) => {
  fresh(t)
  assert.ok(ANTIGRAVITY_TIERS.includes('hydrogen'))
  assert.equal(CONDITIONAL_ANTIGRAVITY_TIERS.includes('hydrogen'), false, 'Hydrogen is offered whatever agy lists')
  assert.equal(TIER_LETTER.hydrogen, 'H')
  assert.equal(ANTIGRAVITY_TIER_SEAT.hydrogen, 1, 'the $1.5 input band, like Flash')
  // right after Flash in the default order, so it takes Flash's place while Flash is hidden
  assert.equal(ANTIGRAVITY_TIERS.indexOf('hydrogen'), ANTIGRAVITY_TIERS.indexOf('flash') + 1)
  assert.equal(ANTIGRAVITY_TIERS_LISTED.indexOf('hydrogen'), ANTIGRAVITY_TIERS_LISTED.length - 1, 'cheapest, listed last')
  // offered with no payload evidence at all, where the conditional tiers hide
  assert.equal(antigravityTierOffer(ON, 'hydrogen'), 'offer')
  assert.equal(antigravityTierOffer(BARE, 'hydrogen'), 'offer')
  assert.equal(antigravityTierOffer(BARE, 'carbon'), 'hide', 'control: a conditional tier needs its row')
  assert.equal(conditionalTierHidden('hydrogen'), false)
  // the family verdict still applies
  assert.equal(antigravityTierOffer({ ...BARE, enabled: false }, 'hydrogen'), 'disable')
  assert.equal(antigravityTierOffer({ ...BARE, userEnabled: false }, 'hydrogen'), 'hide')
  // Flash: hidden by default, back with the toggle, marked legacy like Gemini Pro
  assert.deepEqual(OPT_IN_LEGACY_TIERS, ['pro', 'flash'])
  assert.equal(optInLegacyHidden('flash'), true)
  assert.equal(antigravityTierOffer(ON, 'flash'), 'hide')
  assert.equal(legacyMark('flash'), ' · legacy')
  assert.equal(legacyMark('hydrogen'), '')
  setShowLegacyModelsOn(true)
  assert.equal(optInLegacyHidden('flash'), false)
  assert.equal(antigravityTierOffer(ON, 'flash'), 'offer')
  assert.equal(antigravityTierOffer(ON, 'hydrogen'), 'offer', 'the toggle does not touch Hydrogen')
})

/* ── §2 the hire surfaces ───────────────────────────────────────────────── */

function card(node: CanvasNode, antigravityHire: HireState) {
  return mountView(
    <NodeSquare node={node as Parameters<typeof NodeSquare>[0]['node']}
      pos={{ x: 0, y: 0 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={SEATS}
      map={new Map()} op={() => Promise.resolve({} as never)} slug="org"
      toast={noop} pxc={1} zoom={1}
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
      onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop} onWorkLink={noop}
      onRecenter={noop} onJump={noop} cascadeAlloc
      maxTop={100} onMailLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      onDragCancel={noop}
      claudeHire={ON} codexHire={ON} antigravityHire={antigravityHire} onNoHarness={noop} />,
    (el) => el)
}

test('§2 canvas hire chips: a Hydrogen chip with no payload row; a Flash chip only with the toggle', async (t: TestContext) => {
  fresh(t)
  const chip = (el: HTMLElement, tier: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.hsof button')].find((b) => hasClass(b, 't-' + tier))
  const off = await card(agent(), BARE)
  const hydrogen = chip(off.el, 'hydrogen')
  assert.equal(Boolean(hydrogen), true, 'no Hydrogen chip on an account whose agy lists nothing')
  assert.equal(hydrogen!.disabled, false)
  assert.equal(hydrogen!.textContent, 'H')
  assert.equal(Boolean(chip(off.el, 'flash')), false, 'a Flash chip rendered with "show legacy models" off')
  await off.unmount()
  setShowLegacyModelsOn(true)
  const on = await card(agent(), BARE)
  t.after(() => on.unmount())
  const flash = chip(on.el, 'flash')
  assert.equal(Boolean(flash), true, 'no Flash chip with "show legacy models" on')
  assert.equal(hasClass(flash!, 'legacy'), true, 'the Flash chip is not marked legacy')
  assert.equal(Boolean(chip(on.el, 'hydrogen')), true)
  assert.equal(hasClass(chip(on.el, 'hydrogen')!, 'legacy'), false)
})

test('§2 hire sheet: a Hydrogen button with no payload row; a Flash button only with the toggle, labelled legacy', async (t: TestContext) => {
  fresh(t)
  const btn = (tier: string) => [...document.querySelectorAll<HTMLButtonElement>('.hs-tier')]
    .find((b) => hasClass(b, 't-' + tier))
  const sheet = () => mountView(
    <HireSheet anchor={agent()} seats={SEATS} defaultGrant={0}
      claudeHire={ON} codexHire={ON} antigravityHire={BARE}
      onHire={noop} onClose={noop} />, (el) => el)
  const off = await sheet()
  await flush()
  assert.equal(Boolean(btn('hydrogen')), true, 'the sheet did not offer Hydrogen')
  assert.equal(btn('hydrogen')!.disabled, false)
  assert.doesNotMatch(btn('hydrogen')!.title, /legacy/)
  assert.equal(Boolean(btn('flash')), false, 'the sheet offered Flash with the toggle off')
  await off.unmount()
  setShowLegacyModelsOn(true)
  const on = await sheet()
  t.after(() => on.unmount())
  await flush()
  assert.equal(Boolean(btn('flash')), true, 'the sheet did not offer Flash with the toggle on')
  assert.match(btn('flash')!.title, /legacy/)
})

/* ── §3 an agent already on Flash ───────────────────────────────────────── */

test('§3 an agent already on Flash keeps its own tier in the switch and its F token', async (t: TestContext) => {
  fresh(t)
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const google: ProviderInfo = { id: 'google', label: 'Antigravity', cli: 'agy',
    tiers: [{ tier: 'hydrogen', provider: 'google', seat: 1, model: 'gemini-4-hydrogen', letter: 'H' }],
    status: { installed: true, connected: true, kind: 'google' }, hire_enabled: true, reason: null } as unknown as ProviderInfo
  const node = agent('flash')
  const cfg = await mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={null} antigravityProvider={google} close={noop} />, (el) => el)
  const sel = cfg.el.querySelector<HTMLSelectElement>('.model-switch')!
  const values = [...sel.options].map((o) => o.value)
  assert.equal(values.includes('flash'), true, 'a Flash agent\'s own tier left its settings')
  assert.equal(sel.value, 'flash')
  assert.equal(values.includes('hydrogen'), true, 'Hydrogen is a choice for it')
  await cfg.unmount()
  const v = await card(agent('flash'), BARE)
  t.after(() => v.unmount())
  const token = [...v.el.querySelectorAll('.tier.t-flash')].find((e) => !e.closest('.hsof'))
  assert.equal(Boolean(token), true, 'the Flash agent\'s card has no t-flash tier token')
  assert.equal(token!.textContent, 'F')
})

/* ── §4 the colour ──────────────────────────────────────────────────────── */

test('§4 Hydrogen is near-white on every tier surface, with a dark backing on light themes', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const hex = /--tier-hydrogen:\s*(#[0-9a-f]{6});/i.exec(css)?.[1] ?? ''
  assert.equal(hex.toLowerCase(), '#f7fff0')
  // near-white: every channel in the top tenth
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  assert.equal(Math.min(r!, g!, b!) >= 230, true, `${hex} is not near-white`)
  // every class family krypton has, hydrogen has too (chips, cards, mini, desk, badges, hire buttons)
  for (const sel of ['.chip.agents b.t-hydrogen', '.sq.tier-hydrogen', '.sq.mini.tier-hydrogen',
    '.sq.prov-google.desk.tier-hydrogen', '.tier.t-hydrogen', '.hsof button.t-hydrogen']) {
    assert.equal(css.includes(sel + ' {'), true, `no "${sel}" rule`)
  }
  // a near-white letter on the light themes' white hire buttons would vanish: the dark backing Wonder Full uses
  assert.match(css, /:root:is\(\.contrast-light, \.contrast-solarized-light\) \.hsof button\.t-hydrogen \{\s*color: var\(--tier-hydrogen\); background: #313131;\s*\}/)
})

/* ── §5 the estimate mark ───────────────────────────────────────────────── */

const turn = (over: Partial<TurnStat> = {}): TurnStat => ({
  at: '2026-11-13T10:00:00Z', cost: 0, ms: 1200, denials: 0, ...over,
} as TurnStat)

test('§5 a spend total that includes an estimated turn says est.; a measured one does not', async () => {
  const badge = async (node: Parameters<typeof SpendBadge>[0]['node']) => {
    const view = await mountView(<SpendBadge node={node} />, (el) => el)
    const span = view.el.querySelector<HTMLElement>('span.badge')
    return { view, text: span?.textContent ?? '', title: span?.getAttribute('title') ?? '' }
  }
  const est = await badge({ cost_usd: 0.42, turns: [turn({ cost: 0.3, cost_source: 'priced', estimated: true }), turn({ cost: 0.12, cost_source: 'priced' })] })
  try {
    assert.equal(est.text, '$0.42 est.')
    assert.match(est.title, /\$0\.30 est\. · priced/)
    assert.match(est.title, /est\.: priced from an estimate; this model has no published price yet/)
  } finally { await est.view.unmount() }
  const measured = await badge({ cost_usd: 0.42, turns: [turn({ cost: 0.42, cost_source: 'priced' })] })
  try {
    assert.equal(measured.text, '$0.42')
    assert.doesNotMatch(measured.title, /est\./)
  } finally { await measured.view.unmount() }
})
