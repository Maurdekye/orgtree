// neon.test.tsx — Gemini 4 Neon appears only once agy lists it, speculatively, hidden until listed (USER 2026-11-18 mcfdf1e158062).
//
// USER 2026-11-18 mcfdf1e158062: speculative tier, using Krypton availability and picker behavior.
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ANTIGRAVITY_TIERS, ANTIGRAVITY_TIER_SEAT, antigravityTierOffer,
  CONDITIONAL_ANTIGRAVITY_TIERS, conditionalTierHidden, setOfferedConditionalTiers,
  TIER_LETTER, USER, isOptInLegacy,
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
  luna: 0.1, terra: 2, sol: 2, astra: 10, hydrogen: 1, pro: 2, neon: 2 }
const ON: HireState = { enabled: true, installed: true, reason: null }
/** the Antigravity hire state as `hireOf` builds it from the payload rows */
const google = (neon: boolean): HireState =>
  ({ ...ON, offeredTiers: neon ? ['hydrogen', 'pro', 'neon'] : ['hydrogen', 'pro'] })
const rows = (neon: boolean) => (neon ? ['hydrogen', 'pro', 'neon'] : ['hydrogen', 'pro'])
  .map((tier) => ({ tier, provider: 'google', seat: SEATS[tier as keyof typeof SEATS],
    model: tier === 'neon' ? 'gemini-4-neon' : 'gemini-' + tier,
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

test('§1 neon is a conditional Antigravity tier; hydrogen and pro are not', (t: TestContext) => {
  fresh(t)
  assert.ok(ANTIGRAVITY_TIERS.includes('neon'))
  assert.deepEqual(CONDITIONAL_ANTIGRAVITY_TIERS, ['argon', 'krypton', 'neon', 'carbon', 'agy-sonnet', 'agy-opus'])
  assert.equal(TIER_LETTER.neon, 'N')
  assert.equal(ANTIGRAVITY_TIER_SEAT.neon, 2, 'placeholder seat copies pro')
  // no payload evidence: hidden
  assert.equal(antigravityTierOffer(null, 'neon'), 'hide')
  assert.equal(antigravityTierOffer(ON, 'neon'), 'hide')
  assert.equal(antigravityTierOffer(google(false), 'neon'), 'hide')
  assert.equal(antigravityTierOffer(google(true), 'neon'), 'offer')
  // the family verdict still applies once listed
  assert.equal(antigravityTierOffer({ ...google(true), enabled: false }, 'neon'), 'disable')
  assert.equal(antigravityTierOffer({ ...google(true), userEnabled: false }, 'neon'), 'hide')
  // hydrogen is unaffected either way; pro keeps its legacy-toggle rule
  assert.equal(antigravityTierOffer(google(false), 'hydrogen'), 'offer')
  assert.equal(antigravityTierOffer(google(false), 'pro'), 'hide')
  // the store for surfaces without a HireState
  assert.equal(conditionalTierHidden('neon'), true)
  setOfferedConditionalTiers(rows(true))
  assert.equal(conditionalTierHidden('neon'), false)
  setOfferedConditionalTiers(rows(false))
  assert.equal(conditionalTierHidden('neon'), true)
  assert.equal(conditionalTierHidden('hydrogen'), false)
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

test('§2 canvas hire chips: no Neon chip until the payload offers it', async (t: TestContext) => {
  fresh(t)
  const chip = (el: HTMLElement, tier: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.hsof button')].find((b) => hasClass(b, 't-' + tier))
  const off = await card(agent(), google(false))
  t.after(() => off.unmount())
  assert.ok(chip(off.el, 'hydrogen'), 'positive control: the Antigravity row rendered')
  assert.equal(Boolean(chip(off.el, 'neon')), false, 'a Neon chip rendered while agy does not list it')
  await off.unmount()
  const on = await card(agent(), google(true))
  t.after(() => on.unmount())
  const neon = chip(on.el, 'neon')
  assert.ok(neon, 'no Neon chip once the payload offers it')
  assert.equal(neon!.disabled, false)
  assert.equal(neon!.textContent, 'N')
})

test('§2 hire sheet: no Neon button until the payload offers it', async (t: TestContext) => {
  fresh(t)
  const btn = (tier: string) => [...document.querySelectorAll<HTMLButtonElement>('.hs-tier')]
    .find((b) => hasClass(b, 't-' + tier))
  const sheet = (h: HireState) => mountView(
    <HireSheet anchor={agent()} seats={SEATS} defaultGrant={0}
      claudeHire={ON} codexHire={ON} antigravityHire={h}
      onHire={noop} onClose={noop} />, (el) => el)
  const off = await sheet(google(false))
  await flush()
  assert.ok(btn('hydrogen'), 'positive control: the Antigravity row rendered')
  assert.equal(Boolean(btn('neon')), false, 'the sheet offered Neon while agy does not list it')
  await off.unmount()
  const on = await sheet(google(true))
  t.after(() => on.unmount())
  await flush()
  assert.ok(btn('neon'), 'the sheet did not offer Neon once listed')
  assert.equal(btn('neon')!.disabled, false)
})

function config(node: CanvasNode, neon: boolean) {
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const provider: ProviderInfo = { id: 'google', label: 'Antigravity', cli: 'agy',
    tiers: rows(neon), status: { installed: true, connected: true, kind: 'google' },
    hire_enabled: true, reason: null } as unknown as ProviderInfo
  return mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={null} antigravityProvider={provider} close={noop} />,
    (el) => el)
}
const switchOption = (el: HTMLElement, tier: string) =>
  [...el.querySelectorAll<HTMLOptionElement>('.model-switch option')].find((o) => o.value === tier)

test('§2 agent settings model switch: no Neon option until the payload offers it',
  async (t: TestContext) => {
    fresh(t)
    const off = await config(agent('hydrogen'), false)
    assert.ok(switchOption(off.el, 'hydrogen'), 'positive control: the Antigravity group rendered')
    assert.equal(Boolean(switchOption(off.el, 'neon')), false,
      'the model switch listed Neon while agy does not list it')
    await off.unmount()
    const on = await config(agent('hydrogen'), true)
    t.after(() => on.unmount())
    const o = switchOption(on.el, 'neon')
    assert.ok(o, 'the model switch did not list Neon once listed')
    assert.equal(o!.disabled, false)
  })

test('§2 lineage rehire list: no "as neon" row until the payload offers it',
  async (t: TestContext) => {
    fresh(t)
    const node = agent('hydrogen', [{ id: 'agent@1', generation: 1, state: 'archived',
      bearer_state: 'knowledge', tier: 'hydrogen' } as LineageEntry])
    const v = await mountView(
      <LineagePanel node={node} slug="org" close={noop}
        op={() => Promise.resolve({} as OpResult)} />, (el) => el)
    t.after(() => v.unmount())
    const opt = (tier: string) => [...v.el.querySelectorAll<HTMLOptionElement>('.lin-row select option')]
      .find((o) => o.value === tier)
    assert.ok(opt('luna'), 'positive control: the rehire list rendered')
    assert.equal(Boolean(opt('neon')), false, 'the rehire list offered Neon while agy does not list it')
    await inAct(() => { setOfferedConditionalTiers(rows(true)) })
    await flush()
    assert.ok(opt('neon'), 'the rehire list did not offer Neon once listed (no re-render?)')
    assert.equal(opt('neon')!.disabled, false, 'a hydrogen bearer may be rehired as neon')
    await inAct(() => { setOfferedConditionalTiers(rows(false)) })
    await flush()
    assert.equal(Boolean(opt('neon')), false, 'Neon stayed after agy stopped listing it')
  })

/* ── §3 an agent already on Neon ───────────────────────────────────────── */

test('§3 an agent already on Neon keeps its own tier in the switch and its N token',
  async (t: TestContext) => {
    fresh(t)
    const cfg = await config(agent('neon'), false)
    const sel = cfg.el.querySelector<HTMLSelectElement>('.model-switch')!
    assert.ok(switchOption(cfg.el, 'neon'), 'a Neon agent\'s own tier left its settings')
    assert.equal(sel.value, 'neon')
    await cfg.unmount()
    const v = await card(agent('neon'), google(false))
    t.after(() => v.unmount())
    const token = [...v.el.querySelectorAll('.tier.t-neon')].find((e) => !e.closest('.hsof'))
    assert.ok(token, 'the Neon agent\'s card has no t-neon tier token')
    assert.equal(token!.textContent, 'N')
    assert.ok(v.el.querySelector('.sq.tier-neon') ?? v.el.matches('.sq.tier-neon'),
      'the card is not classed tier-neon (no accent/glow colour)')
  })

/* ── §4 the colour ──────────────────────────────────────────────────────── */

test('Argon and Neon offers are independent', (t: TestContext) => {
  fresh(t)
  for (const offered of [[], ['argon'], ['neon'], ['argon', 'neon']]) {
    const h = { ...ON, offeredTiers: ['hydrogen', 'pro', ...offered] }
    for (const tier of ['argon', 'neon']) {
      assert.equal(antigravityTierOffer(h, tier), offered.includes(tier) ? 'offer' : 'hide')
    }
  }
})

test('Neon leaves the Carbon-only Argon legacy rule unchanged', () => {
  setOfferedConditionalTiers([{ tier: 'neon' }, { tier: 'argon' }]);
  assert.equal(conditionalTierHidden('neon'), false);
  assert.equal(isOptInLegacy('neon'), false);
  assert.equal(isOptInLegacy('argon'), false);
  setOfferedConditionalTiers([{ tier: 'neon' }, { tier: 'argon' }, { tier: 'carbon' }]);
  assert.equal(isOptInLegacy('argon'), true);
  assert.equal(isOptInLegacy('neon'), false);
  setOfferedConditionalTiers([]);
})

test('Neon has a colour on every Krypton surface', () => {
  const sheet = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8');
  assert.match(sheet, /--tier-neon:\s*#ff3a1f;/i);
  for (const sel of ['.chip.agents b.t-neon', '.sq.tier-neon', '.sq.mini.tier-neon',
    '.sq.prov-google.desk.tier-neon', '.tier.t-neon', '.hsof button.t-neon']) {
    assert.ok(sheet.includes(sel + ' {'), `missing ${sel}`);
  }
})
