// legacypro.test.tsx — Gemini Pro is a legacy model, behind "show legacy models".
//
// Docket `v3-deprecate-and-disable-the-gemini-pro-model-ti`. The user
// (2026-09-30): "also deprecate and disable gemini pro", then: put it under
// the same "show legacy models" checkbox as Terra — hidden where Terra was
// hidden while it is off, shown (marked legacy) while it is on. Terra left the
// switch on 2026-10-26 (GPT-6.1 Terra: "make sure to take terra out of the
// legacy models checkbox"; terra.test.tsx), so Gemini Pro is its only model.
//
// Gemini Pro is the Antigravity family's `pro` tier. Terra's hiding reached
// the Codex surfaces through `codexTierOffer`, which the Antigravity rows never
// call, so each chooser is checked here with the Antigravity family INSTALLED
// and its sibling `flash` as the positive control.
//
//   §1 the rule: `pro` is an opt-in legacy tier, `flash` is not
//   §2 every chooser leaves Gemini Pro out by default and shows it marked
//      legacy once the toggle is on: canvas hire chips, the canvas agent and
//      project menus' hire submenus, hire sheet, agent settings model switch,
//      lineage rehire list, auto-autopsy model list, App settings > Model
//      tiers, Usage tier rows
//   §3 an agent already on Gemini Pro keeps its P token and its own tier
//   §4 the toggle's label names its one legacy model, Gemini Pro
//   §5 the toggle lives in App settings > Runtime, off by default
//
// ⚠ Every test that turns the toggle on turns it off again in `t.after`.
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  availableAutopsyModels, legacyMark, OPT_IN_LEGACY_TIERS, optInLegacyHidden,
  setShowLegacyModelsOn, showLegacyModelsOn, tierHiddenAsLegacy, USER,
} from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import { NodeSquare } from '../src/canvas/cards'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { NodeConfig } from '../src/canvas/modals'
import { LineagePanel } from '../src/canvas/desk'
import { AccountsPanel, TierStandings } from '../src/canvas/accounts'
import { agentMenuEntries } from '../src/canvas/agentmenu'
import type { MenuEntry, MenuItem } from '../src/canvas/contextmenu'
import { clearProviderDiscovery } from '../src/api'
import type { LineageEntry, OpResult, ProviderInfo, TreePayload } from '../src/types'

const noop = () => {}
const ON: HireState = { enabled: true, installed: true, reason: null }
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

async function flip(on: boolean) {
  await inAct(() => { setShowLegacyModelsOn(on) })
  await flush()
}

/* ── §1 the rule ─────────────────────────────────────────────────────────── */

test('§1 pro is the opt-in legacy tier; terra (current again) and flash are not', (t: TestContext) => {
  fresh(t)
  assert.ok(OPT_IN_LEGACY_TIERS.includes('pro'))
  assert.equal(OPT_IN_LEGACY_TIERS.includes('terra'), false, 'Terra left the legacy switch')
  assert.equal(optInLegacyHidden('terra'), false)
  assert.equal(legacyMark('terra'), '')
  assert.equal(optInLegacyHidden('pro'), true)
  assert.equal(tierHiddenAsLegacy('pro'), true)
  assert.equal(optInLegacyHidden('flash'), false)
  assert.equal(legacyMark('pro'), ' · legacy')
  assert.equal(legacyMark('flash'), '')
  setShowLegacyModelsOn(true)
  assert.equal(optInLegacyHidden('pro'), false)
  assert.equal(tierHiddenAsLegacy('pro'), false)
})

/* ── §2 through each chooser ────────────────────────────────────────────── */

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
      maxTop={100} onMailLink={noop}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      onDragCancel={noop}
      claudeHire={ON} codexHire={ON} antigravityHire={ON} onNoHarness={noop} />,
    (el) => el)
}

test('§2 canvas hire chips: no Gemini Pro chip, then a legacy one on the SAME strip',
  async (t: TestContext) => {
    fresh(t)
    const v = await card(agent())
    t.after(() => v.unmount())
    const chip = (tier: string) => [...v.el.querySelectorAll<HTMLButtonElement>('.hsof button')]
      .find((b) => hasClass(b, 't-' + tier))
    assert.ok(chip('flash'), 'positive control: the Antigravity row rendered')
    assert.equal(Boolean(chip('pro')), false, 'a Gemini Pro chip rendered with the toggle off')
    await flip(true)
    const pro = chip('pro')
    assert.ok(pro, 'turning the toggle on did not bring the Gemini Pro chip back')
    assert.equal(pro!.disabled, false)
    assert.ok(hasClass(pro!, 'legacy'), 'the Gemini Pro chip is not marked legacy')
    assert.equal(hasClass(chip('flash')!, 'legacy'), false, 'flash is not legacy')
    await flip(false)
    assert.equal(Boolean(chip('pro')), false, 'turning it off again did not hide it')
  })

// The 4.4.6 RC1 pre-publish hands-on found these two submenus listing a plain
// "pro" with the toggle on; they had never appended the mark (4.5.0 fix).
test('§2 canvas agent and project menus: no Gemini Pro hire item, then one labelled legacy',
  (t: TestContext) => {
    fresh(t)
    const project = { ...agent(), id: 'site', kind: 'project', tier: 'project', model_id: '' } as unknown as CanvasNode
    const items = (entries: MenuEntry[] = []) => entries.filter((e): e is MenuItem => e !== 'sep')
    const tiers = (node: CanvasNode) => {
      const hire = items(agentMenuEntries(node, { onHire: noop }, { antigravityHire: ON }))
        .find((e) => /^Hire (a subordinate|under this project)$/.test(e.label))
      assert.ok(hire, `no hire submenu on ${node.id}`)
      return items(hire!.children)
    }
    const pro = (node: CanvasNode) => tiers(node).find((e) => /^pro\b/.test(e.label))
    for (const node of [agent(), project]) {
      assert.ok(tiers(node).some((e) => e.label === 'flash'),
        `positive control: ${node.id}'s menu lists the Antigravity tiers`)
      assert.equal(pro(node), undefined, `${node.id}'s menu listed Gemini Pro with the toggle off`)
    }
    setShowLegacyModelsOn(true)
    for (const node of [agent(), project]) {
      const p = pro(node)
      assert.ok(p, `${node.id}'s menu did not list Gemini Pro with the toggle on`)
      assert.equal(p!.label, 'pro · legacy', `${node.id}'s menu does not mark Gemini Pro legacy`)
      assert.equal(p!.disabled, false)
      assert.ok(tiers(node).some((e) => e.label === 'flash'), `${node.id}'s menu marked flash legacy`)
    }
  })

test('§2 hire sheet: no Gemini Pro button, then one labelled legacy',
  async (t: TestContext) => {
    fresh(t)
    const v = await mountView(
      <HireSheet anchor={agent()} seats={SEATS} defaultGrant={0}
        claudeHire={ON} codexHire={ON} antigravityHire={ON}
        onHire={noop} onClose={noop} />,
      (el) => el)
    t.after(() => v.unmount())
    await flush()
    const btn = (tier: string) => [...document.querySelectorAll<HTMLButtonElement>('.hs-tier')]
      .find((b) => hasClass(b, 't-' + tier))
    assert.ok(btn('flash'), 'positive control: the Antigravity row rendered')
    assert.equal(Boolean(btn('pro')), false, 'the sheet offered Gemini Pro with the toggle off')
    await flip(true)
    assert.ok(btn('pro'), 'the sheet did not offer Gemini Pro with the toggle on')
    // 4.2: the legacy mark rides in the tooltip, the label stays "name · seat N"
    assert.match(btn('pro')!.title, /legacy/)
    assert.doesNotMatch(btn('flash')!.title, /legacy/)
  })

function config(node: CanvasNode) {
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const google: ProviderInfo = { id: 'google', label: 'Antigravity', cli: 'agy', tiers: [],
    status: { installed: true, connected: true, kind: 'google' },
    hire_enabled: true, reason: null }
  return mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={null} antigravityProvider={google} close={noop} />,
    (el) => el)
}
const switchOption = (el: HTMLElement, tier: string) =>
  [...el.querySelectorAll<HTMLOptionElement>('.model-switch option')]
    .find((o) => o.value === tier)

test('§2 agent settings model switch: no Gemini Pro option, then one labelled legacy',
  async (t: TestContext) => {
    fresh(t)
    const v = await config(agent('flash'))
    t.after(() => v.unmount())
    assert.ok(switchOption(v.el, 'flash'), 'positive control: the Antigravity group rendered')
    assert.equal(Boolean(switchOption(v.el, 'pro')), false,
      'the model switch listed Gemini Pro with the toggle off')
    await flip(true)
    const o = switchOption(v.el, 'pro')
    assert.ok(o, 'the model switch did not list Gemini Pro with the toggle on')
    assert.equal(o!.disabled, false)
    assert.match(o!.title, /legacy/, 'the legacy mark rides in the option tooltip')
  })

test('§3 an agent already on Gemini Pro keeps its own tier in the switch, toggle off',
  async (t: TestContext) => {
    fresh(t)
    const v = await config(agent('pro'))
    t.after(() => v.unmount())
    const sel = v.el.querySelector<HTMLSelectElement>('.model-switch')!
    const own = switchOption(v.el, 'pro')
    assert.ok(own, 'a Gemini Pro agent\'s own tier left its settings — the select would lie')
    assert.equal(sel.value, 'pro')
    assert.equal(own!.disabled, false, 'its own tier is a selectable no-op')
  })

test('§3 an agent already on Gemini Pro shows its P token on its card, toggle off',
  async (t: TestContext) => {
    fresh(t)
    const v = await card(agent('pro'))
    t.after(() => v.unmount())
    const token = [...v.el.querySelectorAll('.tier.t-pro')]
      .find((e) => !e.closest('.hsof'))
    assert.ok(token, 'the Gemini Pro agent\'s card lost its tier token')
    assert.equal(token!.textContent, 'P')
  })

test('§2 auto-autopsy model list: no Gemini Pro, then labelled legacy; a configured one stays',
  (t: TestContext) => {
    fresh(t)
    const payload = { providers: [{ id: 'google', label: 'Antigravity', cli: 'agy',
      status: { installed: true, connected: true, kind: 'google' },
      hire_enabled: true, reason: null,
      tiers: ['flash', 'pro'].map((tier) => ({ tier, provider: 'google',
        seat: 2, model: tier, letter: tier[0].toUpperCase() })) }] as ProviderInfo[] }
    const tiers = (current: string) => availableAutopsyModels(payload, current)
      .flatMap((g) => g.models.map((m) => m.tier))
    assert.deepEqual(tiers('flash'), ['flash'])
    assert.ok(tiers('pro').includes('pro'), 'a configured Gemini Pro autopsy model was dropped')
    setShowLegacyModelsOn(true)
    assert.deepEqual(tiers('flash'), ['flash', 'pro'])
  })

// The engine never lists a legacy tier in /api/providers (providers::tier_rows
// with legacy_ok false), so in the app this list has no Gemini Pro row either
// way; this payload carries one to check the renderer's own filter and mark.
test('§2 App settings > Model tiers leaves Gemini Pro out; the toggle brings it back marked legacy',
  async (t: TestContext) => {
    fresh(t)
    clearProviderDiscovery()
    t.after(() => clearProviderDiscovery())
    const providers = { providers: [{ id: 'google', label: 'Antigravity', cli: 'agy',
      status: { installed: true, connected: true }, hire_enabled: true, reason: null,
      tiers: ['flash', 'pro'].map((tier) => ({ tier, provider: 'google',
        seat: SEATS[tier as keyof typeof SEATS], model: 'gemini-' + tier,
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
    const rows = () => [...document.querySelectorAll('[aria-label="Antigravity model tiers"] .acct-provider-tier-name')]
      .map((el) => el.textContent)
    assert.deepEqual(rows(), ['flash'], 'the Model tiers list showed Gemini Pro with the toggle off')
    await inAct(() => { setShowLegacyModelsOn(true) })
    assert.deepEqual(rows(), ['pro · legacy', 'flash'])
  })

test('§2 Usage per-account tier rows leave Gemini Pro out unless legacy models are shown',
  async (t: TestContext) => {
    fresh(t)
    const standings = ['flash', 'pro'].map((tier) => ({ tier, available: true, refresh_at: null }))
    const v = await mountView(<TierStandings tiers={standings} />, (el) => el)
    t.after(() => v.unmount())
    const rows = () => [...v.el.querySelectorAll('.acct-tier-name')].map((el) => el.textContent)
    assert.deepEqual(rows(), ['flash'], 'the Usage tier rows showed Gemini Pro with the toggle off')
    await inAct(() => { setShowLegacyModelsOn(true) })
    assert.deepEqual(rows(), ['flash', 'pro · legacy'])
  })

/* ── §4 the label ───────────────────────────────────────────────────────── */

test('§4 the toggle is labelled with its one legacy model, Gemini Pro',
  async (t: TestContext) => {
    fresh(t)
    const v = await mountView(<AccountsPanel toast={noop} close={noop} />, (el) => el)
    t.after(() => v.unmount())
    await inAct(async () => { await flush(10) })
    const panel = document.getElementById('app-settings-panel-runtime')
    assert.ok(panel, 'no Runtime tab panel')
    assert.match(panel!.textContent ?? '', /Show legacy models \(Gemini Pro\)/)
    assert.doesNotMatch(panel!.textContent ?? '', /Terra/, 'the Runtime tab still names Terra as legacy')
  })

/* ── §5 where the toggle lives (moved from legacytiers.test.tsx) ─────────── */

test('§5 App settings > Runtime carries the toggle (and no other tab does), off by default, and it flips the preference',
  async (t: TestContext) => {
    fresh(t)
    const v = await mountView(<AccountsPanel toast={noop} close={noop} />, (el) => el)
    t.after(() => v.unmount())
    await inAct(async () => { await flush(10) })
    const label = /Show legacy models \(Gemini Pro\)/
    const holders = [...document.querySelectorAll('[role="tabpanel"]')]
      .filter((p) => label.test(p.textContent ?? ''))
    assert.deepEqual(holders.map((p) => p.id), ['app-settings-panel-runtime'],
      'the toggle must be in the Runtime tab and in no other tab')
    const row = [...holders[0]!.querySelectorAll('label')]
      .find((l) => label.test(l.textContent ?? ''))
    assert.ok(row, 'the Runtime tab has no "show legacy models" toggle')
    assert.equal(document.getElementById('app-settings-panel-providers')?.textContent?.includes('Legacy models'),
      false, 'the old "Legacy models" section is still in the Providers tab')
    const box = row!.querySelector<HTMLInputElement>('input[type="checkbox"]')
      ?? row!.querySelector<HTMLInputElement>('input')
    assert.ok(box, 'the toggle has no checkbox')
    assert.equal(box!.checked, false, 'on by default')
    await inAct(() => { box!.click() })
    assert.equal(showLegacyModelsOn(), true, 'the toggle did not turn the preference on')
    assert.equal(box!.checked, true)
  })
