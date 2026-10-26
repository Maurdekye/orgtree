// terra.test.tsx — Terra is a current Codex model again: GPT-6.1 Terra.
//
// Docket `4-4-6-add-support-for-openai-gpt-6-1-terra-and-p`. The user
// (2026-10-26): "get 4.4.6 out with this" (OpenAI's GPT-6.1 Terra), then
// "make sure to take terra out of the legacy models checkbox". That replaces
// the Terra half of the 2026-09-30 legacy ruling (this file used to be
// legacytiers.test.tsx, which kept Terra hidden by default). Gemini Pro stays
// legacy behind "show legacy models" (legacypro.test.tsx).
//
//   §1 the rule: Terra follows the Codex family verdict like Sol, with the
//      legacy toggle off or on, and never carries the legacy mark
//   §2 every chooser offers Terra by default, unmarked: the canvas hire chips,
//      the hire sheet, the agent settings model switch and the auto-autopsy
//      model list
//   §3 an agent already on Terra still shows its model: its card token, and
//      its own tier stays the selected option in its settings
//   §4 the tier LISTS show it too: App settings > Model tiers and the Usage
//      window's per-account tier rows
//
// ⚠ Every test that turns the toggle on turns it off again in `t.after`, and
// each starts from a cleared localStorage: the preference is module-global.
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  availableAutopsyModels, codexTierOffer, legacyMark, OPT_IN_LEGACY_TIERS,
  setShowLegacyModelsOn, showLegacyModelsOn, tierHiddenAsLegacy, USER,
} from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import { NodeSquare } from '../src/canvas/cards'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { NodeConfig } from '../src/canvas/modals'
import { AccountsPanel, TierStandings } from '../src/canvas/accounts'
import { clearProviderDiscovery } from '../src/api'
import type { OpResult, ProviderInfo, TreePayload } from '../src/types'

const noop = () => {}
const ON: HireState = { enabled: true, installed: true, reason: null }
const ABSENT: HireState = { enabled: false, installed: false, reason: 'not installed' }
const SIGNED_OUT: HireState = { enabled: false, installed: true, reason: 'not signed in' }
// Terra seats at 1: the standing seat rule, $1 per million input tokens
const SEATS = { haiku: 1, sonnet: 2, opus: 4, fable: 10, 'gpt-reserve': 0.2,
  luna: 0.1, terra: 1, sol: 2, astra: 10, flash: 1, pro: 2 }

function fresh(t: TestContext) {
  localStorage.clear()
  installFetch(new FakeServer())
  t.after(() => setShowLegacyModelsOn(false))
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

async function flip(on: boolean) {
  await inAct(() => { setShowLegacyModelsOn(on) })
  await flush()
}

/* ── §1 the rule ─────────────────────────────────────────────────────────── */

test('§1 terra follows the Codex family verdict like sol, with the legacy toggle off or on',
  (t: TestContext) => {
    fresh(t)
    assert.deepEqual(OPT_IN_LEGACY_TIERS, ['pro'], 'Gemini Pro is the only opt-in legacy tier')
    assert.equal(showLegacyModelsOn(), false, 'off by default')
    for (const on of [false, true]) {
      setShowLegacyModelsOn(on)
      for (const tier of ['terra', 'sol']) {
        const at = `${tier}, legacy toggle ${on ? 'on' : 'off'}`
        assert.equal(codexTierOffer(null, tier), 'offer', at)
        assert.equal(codexTierOffer(ON, tier), 'offer', at)
        assert.equal(codexTierOffer({ ...ON, offeredTiers: ['luna', 'sol'] }, tier), 'offer',
          `${at}: always offered, whatever the tier rows say`)
        assert.equal(codexTierOffer(SIGNED_OUT, tier), 'disable', at)
        assert.equal(codexTierOffer(ABSENT, tier), 'hide', `${at}: an absent Codex hides it`)
      }
      assert.equal(tierHiddenAsLegacy('terra'), false)
      assert.equal(legacyMark('terra'), '', 'Terra never carries the legacy mark')
      // gpt-reserve is a different kind of legacy: never offered, toggle or not
      assert.equal(codexTierOffer(ON, 'gpt-reserve'), 'hide')
      assert.equal(tierHiddenAsLegacy('gpt-reserve'), true)
    }
  })

/* ── §2 through each chooser ────────────────────────────────────────────── */

test('§2 canvas hire chips: a plain Terra chip on the Codex strip, legacy toggle off or on',
  async (t: TestContext) => {
    fresh(t)
    const v = await mountView(
      <NodeSquare node={agent() as Parameters<typeof NodeSquare>[0]['node']}
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
        claudeHire={ON} codexHire={ON} antigravityHire={ABSENT} onNoHarness={noop} />,
      (el) => el)
    t.after(() => v.unmount())
    const chip = (tier: string) => [...v.el.querySelectorAll<HTMLButtonElement>('.hsof button')]
      .find((b) => hasClass(b, 't-' + tier))
    assert.ok(chip('luna') && chip('sol'), 'positive control: the Codex row rendered')
    for (const on of [false, true]) {
      await flip(on)
      const terra = chip('terra')
      assert.ok(terra, `no Terra chip with the legacy toggle ${on ? 'on' : 'off'}`)
      assert.equal(terra!.disabled, false)
      assert.equal(hasClass(terra!, 'legacy'), false, 'the Terra chip is marked legacy')
      assert.doesNotMatch(terra!.title, /legacy/)
    }
  })

test('§2 hire sheet: a Terra row button without a legacy mark',
  async (t: TestContext) => {
    fresh(t)
    const v = await mountView(
      <HireSheet anchor={agent()} seats={SEATS} defaultGrant={0}
        claudeHire={ON} codexHire={ON} antigravityHire={ABSENT}
        onHire={noop} onClose={noop} />,
      (el) => el)
    t.after(() => v.unmount())
    await flush()
    const btn = (tier: string) => [...document.querySelectorAll<HTMLButtonElement>('.hs-tier')]
      .find((b) => hasClass(b, 't-' + tier))
    assert.ok(btn('luna'), 'positive control: the Codex row rendered')
    for (const on of [false, true]) {
      await flip(on)
      assert.ok(btn('terra'), `the sheet left Terra out with the legacy toggle ${on ? 'on' : 'off'}`)
      assert.equal(btn('terra')!.disabled, false)
      assert.doesNotMatch(btn('terra')!.title, /legacy/)
    }
  })

function config(node: CanvasNode) {
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const codex: ProviderInfo = { id: 'openai', label: 'Codex', cli: 'Codex CLI', tiers: [],
    status: { installed: true, connected: true, kind: 'chatgpt' },
    hire_enabled: true, reason: null }
  return mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={codex} antigravityProvider={null} close={noop} />,
    (el) => el)
}
const switchOption = (el: HTMLElement, tier: string) =>
  [...el.querySelectorAll<HTMLOptionElement>('.model-switch option')]
    .find((o) => o.value === tier)

test('§2 agent settings model switch: a Terra option at its new seat, no legacy mark',
  async (t: TestContext) => {
    fresh(t)
    const v = await config(agent('haiku'))
    t.after(() => v.unmount())
    assert.ok(switchOption(v.el, 'sol'), 'positive control: the Codex group rendered')
    const o = switchOption(v.el, 'terra')
    assert.ok(o, 'the model switch left Terra out with the legacy toggle off')
    assert.equal(o!.disabled, false)
    assert.equal(o!.textContent?.trim(), 'terra · seat 1')
    assert.doesNotMatch(o!.title, /legacy/)
  })

test('§2 auto-autopsy model list offers Terra unmarked, legacy toggle off or on',
  (t: TestContext) => {
    fresh(t)
    const payload = { providers: [{ id: 'openai', label: 'Codex', cli: 'Codex CLI',
      status: { installed: true, connected: true, kind: 'chatgpt' },
      hire_enabled: true, reason: null,
      tiers: ['luna', 'terra', 'sol'].map((tier) => ({ tier, provider: 'openai',
        seat: SEATS[tier as keyof typeof SEATS], model: tier, letter: tier[0].toUpperCase() })) }] as ProviderInfo[] }
    const tiers = (current: string) => availableAutopsyModels(payload, current)
      .flatMap((g) => g.models.map((m) => `${m.tier}=${m.label}`))
    assert.deepEqual(tiers('luna'), ['luna=luna', 'terra=terra', 'sol=sol'])
    setShowLegacyModelsOn(true)
    assert.deepEqual(tiers('luna'), ['luna=luna', 'terra=terra', 'sol=sol'])
  })

/* ── §3 an agent already on Terra ───────────────────────────────────────── */

test('§3 an agent already on Terra keeps its own tier in the switch',
  async (t: TestContext) => {
    fresh(t)
    const v = await config(agent('terra'))
    t.after(() => v.unmount())
    const sel = v.el.querySelector<HTMLSelectElement>('.model-switch')!
    const own = switchOption(v.el, 'terra')
    assert.ok(own, 'a Terra agent\'s own tier left its settings — the select would lie')
    assert.equal(sel.value, 'terra')
    assert.equal(own!.disabled, false, 'its own tier is a selectable no-op')
  })

test('§3 an agent already on Terra shows its T token on its card',
  async (t: TestContext) => {
    fresh(t)
    const v = await mountView(
      <NodeSquare node={agent('terra') as Parameters<typeof NodeSquare>[0]['node']}
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
        claudeHire={ON} codexHire={ON} antigravityHire={ABSENT} onNoHarness={noop} />,
      (el) => el)
    t.after(() => v.unmount())
    // the card's own tier token, outside the hire strip
    const token = [...v.el.querySelectorAll('.tier.t-terra')]
      .find((e) => !e.closest('.hsof'))
    assert.ok(token, 'the Terra agent\'s card lost its tier token')
    assert.equal(token!.textContent, 'T')
  })

/* ── §4 the tier LISTS: App settings > Model tiers, and Usage's per-account
   tier rows ── */

test('§4 App settings > Providers > Model tiers lists Terra, legacy toggle off or on',
  async (t: TestContext) => {
    fresh(t)
    clearProviderDiscovery()
    t.after(() => clearProviderDiscovery())
    const providers = { providers: [{ id: 'openai', label: 'Codex', cli: 'codex',
      status: { installed: true, connected: true }, hire_enabled: true, reason: null,
      tiers: ['luna', 'terra', 'sol', 'astra'].map((tier) => ({ tier, provider: 'openai',
        seat: SEATS[tier as keyof typeof SEATS], model: 'gpt-' + tier,
        letter: tier[0].toUpperCase(), name: tier })) }] }
    const real = globalThis.fetch
    t.after(() => { globalThis.fetch = real })
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const path = new URL(String(url), 'http://localhost').pathname
      if (path === '/api/providers') {
        return { ok: true, status: 200, headers: new Headers(), json: async () => providers }
      }
      return real(url, init)
    }) as typeof fetch
    const v = await mountView(<AccountsPanel toast={noop} close={noop} />, (el) => el)
    t.after(() => v.unmount())
    await inAct(async () => { await flush(10) })
    const rows = () => [...document.querySelectorAll('[aria-label="Codex model tiers"] .acct-provider-tier-name')]
      .map((el) => el.textContent)
    // dearest seat first: Astra 10, Sol 2, Terra 1, Luna 0.1
    assert.deepEqual(rows(), ['astra', 'sol', 'terra', 'luna'], 'the Model tiers list left Terra out')
    await inAct(() => { setShowLegacyModelsOn(true) })
    assert.deepEqual(rows(), ['astra', 'sol', 'terra', 'luna'], 'the legacy toggle changed the Codex list')
  })

test('§4 Usage per-account tier rows list Terra, legacy toggle off or on',
  async (t: TestContext) => {
    fresh(t)
    const standings = ['luna', 'terra', 'sol'].map((tier) => ({ tier, available: true, refresh_at: null }))
    const v = await mountView(<TierStandings tiers={standings} />, (el) => el)
    t.after(() => v.unmount())
    const rows = () => [...v.el.querySelectorAll('.acct-tier-name')].map((el) => el.textContent)
    assert.deepEqual(rows(), ['luna', 'terra', 'sol'], 'the Usage tier rows left Terra out')
    await inAct(() => { setShowLegacyModelsOn(true) })
    assert.deepEqual(rows(), ['luna', 'terra', 'sol'])
  })
