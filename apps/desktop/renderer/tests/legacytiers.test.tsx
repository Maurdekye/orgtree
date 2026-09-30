// legacytiers.test.tsx — Terra is a legacy model: hidden by default, back on request.
//
// Docket `v3-remove-the-terra-chip-so-terra-can-no-longer`. The user
// (2026-09-30): "keep it as a legacy option but remove it by default". So:
//
//   §1 the rule itself (`codexTierOffer`, `tierHiddenAsLegacy`), both states
//   §2 every chooser leaves Terra out by default: the canvas hire chips, the
//      hire sheet, the agent settings model switch, the lineage rehire list
//      and the auto-autopsy model list
//   §3 with "show legacy models" on, each of them shows Terra marked legacy —
//      and the flip reaches an ALREADY-MOUNTED surface, not just the next one
//   §4 an agent already on Terra still shows its model: its card token, and
//      its own tier stays the selected option in its settings
//   §5 the toggle lives in App settings > Providers, off by default
//
// ⚠ Every test that turns the toggle on turns it off again in `t.after`, and
// each starts from a cleared localStorage: the preference is module-global.
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  availableAutopsyModels, codexTierOffer, OPT_IN_LEGACY_TIERS,
  setShowLegacyModelsOn, showLegacyModelsOn, tierHiddenAsLegacy, USER,
} from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import { NodeSquare } from '../src/canvas/cards'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { NodeConfig } from '../src/canvas/modals'
import { LineagePanel } from '../src/canvas/desk'
import { AccountsPanel } from '../src/canvas/accounts'
import type { LineageEntry, OpResult, ProviderInfo, TreePayload } from '../src/types'

const noop = () => {}
const ON: HireState = { enabled: true, installed: true, reason: null }
const ABSENT: HireState = { enabled: false, installed: false, reason: 'not installed' }
const SEATS = { haiku: 1, sonnet: 2, opus: 4, fable: 10, 'gpt-reserve': 0.2,
  luna: 0.1, terra: 2, sol: 2, astra: 10, flash: 1, pro: 2 }

function fresh(t: TestContext) {
  localStorage.clear()
  installFetch(new FakeServer())
  t.after(() => setShowLegacyModelsOn(false))
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

test('§1 terra is hidden by default and follows the Codex family once shown',
  (t: TestContext) => {
    fresh(t)
    assert.deepEqual(OPT_IN_LEGACY_TIERS, ['terra'])
    assert.equal(showLegacyModelsOn(), false, 'off by default')
    const states: (HireState | null)[] = [null, ON,
      { ...ON, offeredTiers: ['luna', 'terra', 'sol'] },
      { enabled: false, installed: true, reason: 'not signed in' }]
    for (const h of states)
      assert.equal(codexTierOffer(h, 'terra'), 'hide', JSON.stringify(h))
    assert.equal(tierHiddenAsLegacy('terra'), true)
    // the leg that must hold: its siblings are untouched
    assert.equal(codexTierOffer(ON, 'luna'), 'offer')
    assert.equal(codexTierOffer(ON, 'sol'), 'offer')

    setShowLegacyModelsOn(true)
    assert.equal(codexTierOffer(ON, 'terra'), 'offer')
    assert.equal(codexTierOffer(null, 'terra'), 'offer')
    assert.equal(codexTierOffer(
      { enabled: false, installed: true, reason: 'x' }, 'terra'), 'disable')
    assert.equal(codexTierOffer(ABSENT, 'terra'), 'hide', 'an absent Codex still hides it')
    assert.equal(tierHiddenAsLegacy('terra'), false)
    // gpt-reserve is a different kind of legacy: never offered, toggle or not
    assert.equal(codexTierOffer(ON, 'gpt-reserve'), 'hide')
    assert.equal(tierHiddenAsLegacy('gpt-reserve'), true)
  })

/* ── §2 + §3 through each chooser ───────────────────────────────────────── */

async function flip(on: boolean) {
  await inAct(() => { setShowLegacyModelsOn(on) })
  await flush()
}

test('§2/§3 canvas hire chips: no Terra chip, then a dashed legacy one on the SAME strip',
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
        onRecenter={noop} onJump={noop} pub={false} cascadeAlloc
        maxTop={100} onMailLink={noop} kioskRemaining={null}
        onDragStart={noop} onDragMove={noop} onDragEnd={noop}
        onDragCancel={noop}
        claudeHire={ON} codexHire={ON} antigravityHire={ABSENT} onNoHarness={noop} />,
      (el) => el)
    t.after(() => v.unmount())
    const chip = (tier: string) => [...v.el.querySelectorAll<HTMLButtonElement>('.hsof button')]
      .find((b) => hasClass(b, 't-' + tier))
    assert.ok(chip('luna') && chip('sol'), 'positive control: the Codex row rendered')
    assert.equal(Boolean(chip('terra')), false, 'a Terra chip rendered with the toggle off')
    await flip(true)
    const terra = chip('terra')
    assert.ok(terra, 'turning the toggle on did not bring the Terra chip back')
    assert.equal(terra!.disabled, false)
    assert.ok(hasClass(terra!, 'legacy'), 'the Terra chip is not marked legacy')
    assert.match(terra!.title, /legacy/)
    assert.equal(hasClass(chip('luna')!, 'legacy'), false, 'only Terra is legacy')
    await flip(false)
    assert.equal(Boolean(chip('terra')), false, 'turning it off again did not hide it')
  })

test('§2/§3 hire sheet: no Terra row button, then one labelled legacy',
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
    assert.equal(Boolean(btn('terra')), false, 'the sheet offered Terra with the toggle off')
    await flip(true)
    assert.ok(btn('terra'), 'the sheet did not offer Terra with the toggle on')
    assert.match(btn('terra')!.textContent ?? '', /terra · seat 2 · legacy/)
    assert.doesNotMatch(btn('luna')!.textContent ?? '', /legacy/)
  })

function config(node: CanvasNode) {
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true,
    sandboxed: false } as unknown as TreePayload
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

test('§2/§3 agent settings model switch: no Terra option, then one labelled legacy',
  async (t: TestContext) => {
    fresh(t)
    const v = await config(agent('haiku'))
    t.after(() => v.unmount())
    assert.ok(switchOption(v.el, 'sol'), 'positive control: the Codex group rendered')
    assert.equal(Boolean(switchOption(v.el, 'terra')), false,
      'the model switch listed Terra with the toggle off')
    await flip(true)
    const o = switchOption(v.el, 'terra')
    assert.ok(o, 'the model switch did not list Terra with the toggle on')
    assert.equal(o!.disabled, false)
    assert.equal(o!.textContent?.trim(), 'terra · seat 2 · legacy')
  })

test('§4 an agent already on Terra keeps its own tier in the switch, toggle off',
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

test('§4 an agent already on Terra shows its T token on its card, toggle off',
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
        onRecenter={noop} onJump={noop} pub={false} cascadeAlloc
        maxTop={100} onMailLink={noop} kioskRemaining={null}
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

test('§2/§3 lineage rehire list: no "as terra" row, then one labelled legacy',
  async (t: TestContext) => {
    fresh(t)
    const node = agent('sol', [{ id: 'agent@1', generation: 1, state: 'archived',
      bearer_state: 'knowledge', tier: 'sol' } as LineageEntry])
    const v = await mountView(
      <LineagePanel node={node} slug="org" close={noop}
        op={() => Promise.resolve({} as OpResult)} />,
      (el) => el)
    t.after(() => v.unmount())
    const opt = (tier: string) => [...v.el.querySelectorAll<HTMLOptionElement>('.lin-row select option')]
      .find((o) => o.value === tier)
    assert.ok(opt('luna'), 'positive control: the rehire list rendered')
    assert.equal(Boolean(opt('terra')), false, 'the rehire list offered Terra with the toggle off')
    await flip(true)
    assert.ok(opt('terra'), 'the rehire list did not offer Terra with the toggle on')
    assert.match(opt('terra')!.textContent ?? '', /^as terra · seat 2 · legacy/)
    assert.equal(opt('terra')!.disabled, false, 'a codex bearer may be rehired as terra')
  })

test('§2/§3 auto-autopsy model list: no Terra, then Terra labelled legacy; a configured Terra stays',
  (t: TestContext) => {
    fresh(t)
    const payload = { providers: [{ id: 'openai', label: 'Codex', cli: 'Codex CLI',
      status: { installed: true, connected: true, kind: 'chatgpt' },
      hire_enabled: true, reason: null,
      tiers: ['luna', 'terra', 'sol'].map((tier) => ({ tier, provider: 'openai',
        seat: 2, model: tier, letter: tier[0].toUpperCase() })) }] as ProviderInfo[] }
    const tiers = (current: string) => availableAutopsyModels(payload, current)
      .flatMap((g) => g.models.map((m) => `${m.tier}=${m.label}`))
    assert.deepEqual(tiers('luna'), ['luna=luna', 'sol=sol'])
    assert.ok(tiers('terra').includes('terra=terra · legacy'),
      'a configured Terra autopsy model was dropped from its own select')
    setShowLegacyModelsOn(true)
    assert.deepEqual(tiers('luna'), ['luna=luna', 'terra=terra · legacy', 'sol=sol'])
  })

/* ── §5 the toggle ───────────────────────────────────────────────────────── */

test('§5 App settings > Providers carries the toggle, off by default, and it flips the preference',
  async (t: TestContext) => {
    fresh(t)
    const v = await mountView(<AccountsPanel toast={noop} close={noop} />, (el) => el)
    t.after(() => v.unmount())
    await inAct(async () => { await flush(10) })
    const panel = document.getElementById('app-settings-panel-providers')
      ?? [...document.querySelectorAll('[role="tabpanel"]')]
        .find((p) => /legacy models/i.test(p.textContent ?? ''))
    assert.ok(panel, 'no Providers panel')
    assert.match(panel!.id, /providers/, 'the toggle is not in the Providers tab')
    const row = [...panel!.querySelectorAll('label')]
      .find((l) => /show legacy models \(Terra\)/.test(l.textContent ?? ''))
    assert.ok(row, 'the Providers tab has no "show legacy models (Terra)" toggle')
    const box = row!.querySelector<HTMLInputElement>('input[type="checkbox"]')
      ?? row!.querySelector<HTMLInputElement>('input')
    assert.ok(box, 'the toggle has no checkbox')
    assert.equal(box!.checked, false, 'on by default')
    await inAct(() => { box!.click() })
    assert.equal(showLegacyModelsOn(), true, 'the toggle did not turn the preference on')
    assert.equal(box!.checked, true)
  })
