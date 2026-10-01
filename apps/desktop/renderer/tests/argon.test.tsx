// argon.test.tsx — Gemini 4 Argon appears only once agy lists it, in magenta.
//
// Docket `argon-model-support-gemini-ultra-via-agy-cli-1-2`. The user
// (2026-10-01): Argon should become selectable as soon as the Antigravity CLI
// offers it, and "when it is selectable, please assign it a bright magenta
// color which represents the visual phosphorescence of argon gas when ionized
// in a vacuum". The backend puts `argon` among the Antigravity tier rows of
// /api/providers only while `agy models` lists `gemini-4-argon`; every chooser
// here must follow that row, with the Antigravity family INSTALLED and its
// sibling `flash` as the positive control.
//
//   §1 the rule: argon is conditional; flash and pro are not
//   §2 every chooser leaves Argon out until the payload offers it, then shows
//      it: canvas hire chips, hire sheet, agent settings model switch, lineage
//      rehire list
//   §3 an agent already on Argon keeps its A token and its own tier
//   §4 the colour: bright magenta, its own variable, distinct from every
//      other tier colour
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
  luna: 0.1, terra: 2, sol: 2, astra: 10, flash: 1, pro: 2, argon: 2 }
const ON: HireState = { enabled: true, installed: true, reason: null }
/** the Antigravity hire state as `hireOf` builds it from the payload rows */
const google = (argon: boolean): HireState =>
  ({ ...ON, offeredTiers: argon ? ['flash', 'pro', 'argon'] : ['flash', 'pro'] })
const rows = (argon: boolean) => (argon ? ['flash', 'pro', 'argon'] : ['flash', 'pro'])
  .map((tier) => ({ tier, provider: 'google', seat: SEATS[tier as keyof typeof SEATS],
    model: tier === 'argon' ? 'gemini-4-argon' : 'gemini-' + tier,
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

test('§1 argon is a conditional Antigravity tier; flash and pro are not', (t: TestContext) => {
  fresh(t)
  assert.ok(ANTIGRAVITY_TIERS.includes('argon'))
  assert.deepEqual(CONDITIONAL_ANTIGRAVITY_TIERS, ['argon'])
  assert.equal(TIER_LETTER.argon, 'A')
  assert.equal(ANTIGRAVITY_TIER_SEAT.argon, 2, 'placeholder seat copies pro')
  // no payload evidence: hidden
  assert.equal(antigravityTierOffer(null, 'argon'), 'hide')
  assert.equal(antigravityTierOffer(ON, 'argon'), 'hide')
  assert.equal(antigravityTierOffer(google(false), 'argon'), 'hide')
  assert.equal(antigravityTierOffer(google(true), 'argon'), 'offer')
  // the family verdict still applies once listed
  assert.equal(antigravityTierOffer({ ...google(true), enabled: false }, 'argon'), 'disable')
  assert.equal(antigravityTierOffer({ ...google(true), userEnabled: false }, 'argon'), 'hide')
  // flash is unaffected either way; pro keeps its legacy-toggle rule
  assert.equal(antigravityTierOffer(google(false), 'flash'), 'offer')
  assert.equal(antigravityTierOffer(google(false), 'pro'), 'hide')
  // the store for surfaces without a HireState
  assert.equal(conditionalTierHidden('argon'), true)
  setOfferedConditionalTiers(rows(true))
  assert.equal(conditionalTierHidden('argon'), false)
  setOfferedConditionalTiers(rows(false))
  assert.equal(conditionalTierHidden('argon'), true)
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
      onRecenter={noop} onJump={noop} pub={false} cascadeAlloc
      maxTop={100} onMailLink={noop} kioskRemaining={null}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      onDragCancel={noop}
      claudeHire={ON} codexHire={ON} antigravityHire={antigravityHire} onNoHarness={noop} />,
    (el) => el)
}

test('§2 canvas hire chips: no Argon chip until the payload offers it', async (t: TestContext) => {
  fresh(t)
  const chip = (el: HTMLElement, tier: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.hsof button')].find((b) => hasClass(b, 't-' + tier))
  const off = await card(agent(), google(false))
  t.after(() => off.unmount())
  assert.ok(chip(off.el, 'flash'), 'positive control: the Antigravity row rendered')
  assert.equal(Boolean(chip(off.el, 'argon')), false, 'an Argon chip rendered while agy does not list it')
  await off.unmount()
  const on = await card(agent(), google(true))
  t.after(() => on.unmount())
  const argon = chip(on.el, 'argon')
  assert.ok(argon, 'no Argon chip once the payload offers it')
  assert.equal(argon!.disabled, false)
  assert.equal(argon!.textContent, 'A')
})

test('§2 hire sheet: no Argon button until the payload offers it', async (t: TestContext) => {
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
  assert.equal(Boolean(btn('argon')), false, 'the sheet offered Argon while agy does not list it')
  await off.unmount()
  const on = await sheet(google(true))
  t.after(() => on.unmount())
  await flush()
  assert.ok(btn('argon'), 'the sheet did not offer Argon once listed')
  assert.equal(btn('argon')!.disabled, false)
})

function config(node: CanvasNode, argon: boolean) {
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true,
    sandboxed: false } as unknown as TreePayload
  const provider: ProviderInfo = { id: 'google', label: 'Antigravity', cli: 'agy',
    tiers: rows(argon), status: { installed: true, connected: true, kind: 'google' },
    hire_enabled: true, reason: null } as unknown as ProviderInfo
  return mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={null} antigravityProvider={provider} close={noop} />,
    (el) => el)
}
const switchOption = (el: HTMLElement, tier: string) =>
  [...el.querySelectorAll<HTMLOptionElement>('.model-switch option')].find((o) => o.value === tier)

test('§2 agent settings model switch: no Argon option until the payload offers it',
  async (t: TestContext) => {
    fresh(t)
    const off = await config(agent('flash'), false)
    assert.ok(switchOption(off.el, 'flash'), 'positive control: the Antigravity group rendered')
    assert.equal(Boolean(switchOption(off.el, 'argon')), false,
      'the model switch listed Argon while agy does not list it')
    await off.unmount()
    const on = await config(agent('flash'), true)
    t.after(() => on.unmount())
    const o = switchOption(on.el, 'argon')
    assert.ok(o, 'the model switch did not list Argon once listed')
    assert.equal(o!.disabled, false)
  })

test('§2 lineage rehire list: no "as argon" row until the payload offers it',
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
    assert.equal(Boolean(opt('argon')), false, 'the rehire list offered Argon while agy does not list it')
    await inAct(() => { setOfferedConditionalTiers(rows(true)) })
    await flush()
    assert.ok(opt('argon'), 'the rehire list did not offer Argon once listed (no re-render?)')
    assert.equal(opt('argon')!.disabled, false, 'a flash bearer may be rehired as argon')
    await inAct(() => { setOfferedConditionalTiers(rows(false)) })
    await flush()
    assert.equal(Boolean(opt('argon')), false, 'Argon stayed after agy stopped listing it')
  })

/* ── §3 an agent already on Argon ───────────────────────────────────────── */

test('§3 an agent already on Argon keeps its own tier in the switch and its A token',
  async (t: TestContext) => {
    fresh(t)
    const cfg = await config(agent('argon'), false)
    const sel = cfg.el.querySelector<HTMLSelectElement>('.model-switch')!
    assert.ok(switchOption(cfg.el, 'argon'), 'an Argon agent\'s own tier left its settings')
    assert.equal(sel.value, 'argon')
    await cfg.unmount()
    const v = await card(agent('argon'), google(false))
    t.after(() => v.unmount())
    const token = [...v.el.querySelectorAll('.tier.t-argon')].find((e) => !e.closest('.hsof'))
    assert.ok(token, 'the Argon agent\'s card has no t-argon tier token')
    assert.equal(token!.textContent, 'A')
    assert.ok(v.el.querySelector('.sq.tier-argon') ?? v.el.matches('.sq.tier-argon'),
      'the card is not classed tier-argon (no accent/glow colour)')
  })

/* ── §4 the colour ──────────────────────────────────────────────────────── */

test('§4 Argon is bright magenta, distinct from every other tier colour', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const vars = Object.fromEntries([...css.matchAll(/--tier-([a-z-]+):\s*(#[0-9a-f]{6})/gi)]
    .map((m) => [m[1], m[2].toLowerCase()]))
  const argon = vars.argon
  assert.ok(argon, 'no --tier-argon colour')
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [r, g, b] = rgb(argon)
  // magenta: red and blue high, green low; bright: the top channel near full
  assert.ok(r >= 0xe0 && b >= 0xb0 && g <= 0x60, `${argon} is not a bright magenta`)
  for (const [tier, hex] of Object.entries(vars)) {
    if (tier === 'argon') continue
    const d = Math.hypot(...rgb(hex).map((v, i) => v - rgb(argon)[i]))
    assert.ok(d > 120, `--tier-argon ${argon} is too close to --tier-${tier} ${hex} (${d.toFixed(0)})`)
  }
  // every class family pro has, argon has too (chips, cards, mini, desk, badges)
  for (const sel of ['.chip.agents b.t-argon', '.sq.tier-argon', '.sq.mini.tier-argon',
    '.sq.prov-google.desk.tier-argon', '.tier.t-argon', '.hsof button.t-argon']) {
    assert.ok(css.includes(sel + ' {'), `no "${sel}" rule`)
  }
})
