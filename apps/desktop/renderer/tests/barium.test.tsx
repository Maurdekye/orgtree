// barium.test.tsx — Gemini 4 Barium appears only once agy lists it, in green.
//
// User 2026-10-05: mirror Argon, hidden until listed, using #8FFF9F.
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ANTIGRAVITY_TIERS, ANTIGRAVITY_TIER_SEAT, antigravityTierOffer,
  CONDITIONAL_ANTIGRAVITY_TIERS, conditionalTierHidden, setOfferedConditionalTiers,
  TIER_LETTER, USER,
} from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import { NodeSquare } from '../src/canvas/cards'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { NodeConfig } from '../src/canvas/modals'
import { LineagePanel } from '../src/canvas/desk'
import type { LineageEntry, OpResult, ProviderInfo, TreePayload } from '../src/types'

declare const __SRC_DIR__: string
const noop = () => {}
const SEATS = { haiku: 1, sonnet: 2, opus: 4, fable: 10, 'gpt-reserve': 0.2,
  luna: 0.1, terra: 2, sol: 2, astra: 10, flash: 1, pro: 2, barium: 2 }
const ON: HireState = { enabled: true, installed: true, reason: null }
/** the Antigravity hire state as `hireOf` builds it from the payload rows */
const google = (barium: boolean): HireState =>
  ({ ...ON, offeredTiers: barium ? ['flash', 'pro', 'barium'] : ['flash', 'pro'] })
const rows = (barium: boolean) => (barium ? ['flash', 'pro', 'barium'] : ['flash', 'pro'])
  .map((tier) => ({ tier, provider: 'google', seat: SEATS[tier as keyof typeof SEATS],
    model: tier === 'barium' ? 'gemini-4-barium' : 'gemini-' + tier,
    letter: TIER_LETTER[tier] }))

function fresh(t: TestContext) {
  localStorage.clear()
  installFetch(new FakeServer())
  setOfferedConditionalTiers([])
  t.after(() => setOfferedConditionalTiers([]))
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

const hasClass = (el: Element, c: string) => el.className.split(/\s+/).includes(c)

/* ── §1 the rule ─────────────────────────────────────────────────────────── */

test('§1 barium is a conditional Antigravity tier; flash and pro are not', (t: TestContext) => {
  fresh(t)
  assert.ok(ANTIGRAVITY_TIERS.includes('barium'))
  assert.deepEqual(CONDITIONAL_ANTIGRAVITY_TIERS, ['argon', 'barium'])
  assert.equal(TIER_LETTER.barium, 'B')
  assert.equal(ANTIGRAVITY_TIER_SEAT.barium, 2, 'placeholder seat copies pro')
  // no payload evidence: hidden
  assert.equal(antigravityTierOffer(null, 'barium'), 'hide')
  assert.equal(antigravityTierOffer(ON, 'barium'), 'hide')
  assert.equal(antigravityTierOffer(google(false), 'barium'), 'hide')
  assert.equal(antigravityTierOffer(google(true), 'barium'), 'offer')
  // the family verdict still applies once listed
  assert.equal(antigravityTierOffer({ ...google(true), enabled: false }, 'barium'), 'disable')
  assert.equal(antigravityTierOffer({ ...google(true), userEnabled: false }, 'barium'), 'hide')
  // flash is unaffected either way; pro keeps its legacy-toggle rule
  assert.equal(antigravityTierOffer(google(false), 'flash'), 'offer')
  assert.equal(antigravityTierOffer(google(false), 'pro'), 'hide')
  // the store for surfaces without a HireState
  assert.equal(conditionalTierHidden('barium'), true)
  setOfferedConditionalTiers(rows(true))
  assert.equal(conditionalTierHidden('barium'), false)
  setOfferedConditionalTiers(rows(false))
  assert.equal(conditionalTierHidden('barium'), true)
  assert.equal(conditionalTierHidden('flash'), false)
})

/* ── §2 through each chooser ────────────────────────────────────────────── */

function card(node: CanvasNode, antigravityHire: HireState) {
  return mountView(
    <NodeSquare node={node as Parameters<typeof NodeSquare>[0]['node']}
      pos={{ x: 0, y: 0 }} lod="norm" focused={false}
      dragging={false} isDrop={false} seats={SEATS}
      map={new Map()} op={() => Promise.resolve({} as never)} slug="org"
      toast={noop} pxc={1} zoom={1}
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop}
      onConfig={noop} onInbox={noop} onLineage={noop} onOpenDoc={noop}
      onRecenter={noop} onJump={noop} cascadeAlloc
      maxTop={100} onMailLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      onDragCancel={noop}
      claudeHire={ON} codexHire={ON} antigravityHire={antigravityHire} onNoHarness={noop} />,
    (el) => el)
}

test('§2 canvas hire chips: no Barium chip until the payload offers it', async (t: TestContext) => {
  fresh(t)
  const chip = (el: HTMLElement, tier: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.hsof button')].find((b) => hasClass(b, 't-' + tier))
  const off = await card(agent(), google(false))
  t.after(() => off.unmount())
  assert.ok(chip(off.el, 'flash'), 'positive control: the Antigravity row rendered')
  assert.equal(Boolean(chip(off.el, 'barium')), false, 'a Barium chip rendered while agy does not list it')
  await off.unmount()
  const on = await card(agent(), google(true))
  t.after(() => on.unmount())
  const barium = chip(on.el, 'barium')
  assert.ok(barium, 'no Barium chip once the payload offers it')
  assert.equal(barium!.disabled, false)
  assert.equal(barium!.textContent, 'B')
})

test('§2 hire sheet: no Barium button until the payload offers it', async (t: TestContext) => {
  fresh(t)
  const btn = (tier: string) => [...document.querySelectorAll<HTMLButtonElement>('.hs-tier')]
    .find((b) => hasClass(b, 't-' + tier))
  const sheet = (h: HireState) => mountView(
    <HireSheet anchor={agent()} seats={SEATS} defaultGrant={0}
      claudeHire={ON} codexHire={ON} antigravityHire={h}
      onHire={noop} onClose={noop} />, (el) => el)
  const off = await sheet(google(false))
  await flush()
  assert.ok(btn('flash'), 'positive control: the Antigravity row rendered')
  assert.equal(Boolean(btn('barium')), false, 'the sheet offered Barium while agy does not list it')
  await off.unmount()
  const on = await sheet(google(true))
  t.after(() => on.unmount())
  await flush()
  assert.ok(btn('barium'), 'the sheet did not offer Barium once listed')
  assert.equal(btn('barium')!.disabled, false)
})

function config(node: CanvasNode, barium: boolean) {
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const provider: ProviderInfo = { id: 'google', label: 'Antigravity', cli: 'agy',
    tiers: rows(barium), status: { installed: true, connected: true, kind: 'google' },
    hire_enabled: true, reason: null } as unknown as ProviderInfo
  return mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={null} antigravityProvider={provider} close={noop} />,
    (el) => el)
}
const switchOption = (el: HTMLElement, tier: string) =>
  [...el.querySelectorAll<HTMLOptionElement>('.model-switch option')].find((o) => o.value === tier)

test('§2 agent settings model switch: no Barium option until the payload offers it',
  async (t: TestContext) => {
    fresh(t)
    const off = await config(agent('flash'), false)
    assert.ok(switchOption(off.el, 'flash'), 'positive control: the Antigravity group rendered')
    assert.equal(Boolean(switchOption(off.el, 'barium')), false,
      'the model switch listed Barium while agy does not list it')
    await off.unmount()
    const on = await config(agent('flash'), true)
    t.after(() => on.unmount())
    const o = switchOption(on.el, 'barium')
    assert.ok(o, 'the model switch did not list Barium once listed')
    assert.equal(o!.disabled, false)
  })

test('§2 lineage rehire list: no "as barium" row until the payload offers it',
  async (t: TestContext) => {
    fresh(t)
    const node = agent('flash', [{ id: 'agent@1', generation: 1, state: 'archived',
      bearer_state: 'knowledge', tier: 'flash' } as LineageEntry])
    const v = await mountView(
      <LineagePanel node={node} slug="org" close={noop}
        op={() => Promise.resolve({} as OpResult)} />, (el) => el)
    t.after(() => v.unmount())
    const opt = (tier: string) => [...v.el.querySelectorAll<HTMLOptionElement>('.lin-row select option')]
      .find((o) => o.value === tier)
    assert.ok(opt('luna'), 'positive control: the rehire list rendered')
    assert.equal(Boolean(opt('barium')), false, 'the rehire list offered Barium while agy does not list it')
    await inAct(() => { setOfferedConditionalTiers(rows(true)) })
    await flush()
    assert.ok(opt('barium'), 'the rehire list did not offer Barium once listed (no re-render?)')
    assert.equal(opt('barium')!.disabled, false, 'a flash bearer may be rehired as barium')
    await inAct(() => { setOfferedConditionalTiers(rows(false)) })
    await flush()
    assert.equal(Boolean(opt('barium')), false, 'Barium stayed after agy stopped listing it')
  })

/* ── §3 an agent already on Barium ───────────────────────────────────────── */

test('§3 an agent already on Barium keeps its own tier in the switch and its B token',
  async (t: TestContext) => {
    fresh(t)
    const cfg = await config(agent('barium'), false)
    const sel = cfg.el.querySelector<HTMLSelectElement>('.model-switch')!
    assert.ok(switchOption(cfg.el, 'barium'), 'a Barium agent\'s own tier left its settings')
    assert.equal(sel.value, 'barium')
    await cfg.unmount()
    const v = await card(agent('barium'), google(false))
    t.after(() => v.unmount())
    const token = [...v.el.querySelectorAll('.tier.t-barium')].find((e) => !e.closest('.hsof'))
    assert.ok(token, 'the Barium agent\'s card has no t-barium tier token')
    assert.equal(token!.textContent, 'B')
    assert.ok(v.el.querySelector('.sq.tier-barium') ?? v.el.matches('.sq.tier-barium'),
      'the card is not classed tier-barium (no accent/glow colour)')
  })

/* ── §4 the colour ──────────────────────────────────────────────────────── */

test('§4 Barium uses the specified barium green on every tier surface', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /--tier-barium:\s*#8fff9f;/i)
  // every class family pro has, barium has too (chips, cards, mini, desk, badges)
  for (const sel of ['.chip.agents b.t-barium', '.sq.tier-barium', '.sq.mini.tier-barium',
    '.sq.prov-google.desk.tier-barium', '.tier.t-barium', '.hsof button.t-barium']) {
    assert.ok(css.includes(sel + ' {'), `no "${sel}" rule`)
  }
})

test('Argon and Barium offers are independent', (t: TestContext) => {
  fresh(t)
  for (const offered of [[], ['argon'], ['barium'], ['argon', 'barium']]) {
    const h = { ...ON, offeredTiers: ['flash', 'pro', ...offered] }
    for (const tier of ['argon', 'barium']) {
      assert.equal(antigravityTierOffer(h, tier), offered.includes(tier) ? 'offer' : 'hide')
    }
  }
})
