// mythos.test.tsx — Claude Mythos appears only while a signed-in Claude login provides it, and is hidden otherwise.
//
// USER 2026-11-19 m4f7e7e8c6694 "also add mythos support when available"; m8c9e34510689 "well add it and only
// show it if mythos is provided by a signed in claude account". The engine lists the tier in the Claude provider's
// payload rows only while a login's own CLI lists the model; every chooser here hides it without that row.
// Colour: USER 2026-11-19 mb033e506819f "use #785a20".
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ALL_TIERS, anyTierSeat, availableAutopsyModels, claudeTierOffer, CONDITIONAL_CLAUDE_TIERS, conditionalTierHidden,
  hireOf, hireTierChoices, hireTierOffer, MODEL_VERSIONS, modelTierOffer, providerOf, setOfferedClaudeTiers,
  setOfferedConditionalTiers, TIER_LETTER, TIER_SEAT, TIERS, TIERS_LISTED, USER,
} from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import { NodeSquare } from '../src/canvas/cards'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { NodeConfig } from '../src/canvas/modals'
import { LineagePanel } from '../src/canvas/desk'
import type { LineageEntry, OpResult, ProviderInfo, TreePayload } from '../src/types'

declare const __SRC_DIR__: string
const noop = () => {}
const SEATS = { haiku: 0.5, sonnet: 2, opus: 4, fable: 8, mythos: 8, luna: 0.1, terra: 1, sol: 2, astra: 8, hydrogen: 1 }
const ON: HireState = { enabled: true, installed: true, reason: null }
const FOUR = ['fable', 'opus', 'sonnet', 'haiku']
/** the Claude provider's payload rows: the four always, Mythos only while a login provides it */
const rows = (mythos: boolean) => (mythos ? ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] : FOUR)
  .map((tier) => ({ tier, provider: 'claude', seat: SEATS[tier as keyof typeof SEATS],
    model: tier === 'mythos' ? 'claude-mythos-5-2' : 'claude-' + tier, letter: TIER_LETTER[tier],
    ...(tier === 'mythos' ? { conditional: true, own: false, logins: ['claude-2'] } : {}) }))
const provider = (mythos: boolean): ProviderInfo => ({ id: 'claude', label: 'Claude', cli: 'claude',
  tiers: rows(mythos), status: { installed: true, connected: true, kind: 'claude' },
  hire_enabled: true, reason: null }) as unknown as ProviderInfo
/** the Claude hire state as `hireOf` builds it from the payload rows */
const claude = (mythos: boolean): HireState => hireOf(provider(mythos))!

function fresh(t: TestContext) {
  localStorage.clear()
  installFetch(new FakeServer())
  setOfferedClaudeTiers([])
  setOfferedConditionalTiers([])
  t.after(() => { setOfferedClaudeTiers([]); setOfferedConditionalTiers([]) })
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

test('§1 mythos is a conditional Claude tier with its letter, seat and versions; the four are not conditional',
  (t: TestContext) => {
    fresh(t)
    assert.deepEqual(TIERS, ['haiku', 'sonnet', 'opus', 'fable', 'mythos'], 'declared last: never the first offered')
    assert.deepEqual(TIERS_LISTED, ['fable', 'mythos', 'opus', 'sonnet', 'haiku'], 'listed after Fable, the same seat')
    assert.ok(ALL_TIERS.includes('mythos'))
    assert.deepEqual(CONDITIONAL_CLAUDE_TIERS, ['mythos'])
    assert.equal(TIER_LETTER.mythos, 'M')
    assert.equal(TIER_SEAT.mythos, 8)
    assert.equal(anyTierSeat('mythos'), 8)
    assert.equal(TIER_SEAT.mythos, TIER_SEAT.fable, 'the same model as Fable 5.2 at the same input price')
    assert.deepEqual(MODEL_VERSIONS.mythos, ['5.2', '5.1', '5'], 'newest first: no saved version is the newest')
    assert.equal(providerOf('mythos'), 'claude')
    // no payload evidence: hidden. The family being hirable is not evidence.
    assert.equal(claudeTierOffer(null, 'mythos'), 'hide')
    assert.equal(claudeTierOffer(ON, 'mythos'), 'hide')
    assert.equal(claudeTierOffer(claude(false), 'mythos'), 'hide')
    assert.equal(claudeTierOffer(claude(true), 'mythos'), 'offer')
    // the family verdict still applies once listed
    assert.equal(claudeTierOffer({ ...claude(true), enabled: false }, 'mythos'), 'disable')
    assert.equal(claudeTierOffer({ ...claude(true), userEnabled: false }, 'mythos'), 'hide')
    // the four are offered with or without the row, as before
    for (const tier of FOUR) {
      assert.equal(claudeTierOffer(ON, tier), 'offer', tier)
      assert.equal(claudeTierOffer(claude(false), tier), 'offer', tier)
      assert.equal(conditionalTierHidden(tier), false, tier)
    }
    // every hire surface reads the same verdict
    for (const offer of [modelTierOffer, hireTierOffer]) {
      assert.equal(offer('claude', claude(false), 'mythos'), 'hide')
      assert.equal(offer('claude', claude(true), 'mythos'), 'offer')
    }
    const choices = (mythos: boolean) => hireTierChoices({ claudeHire: claude(mythos) }).map((c) => c.tier)
    assert.equal(choices(false).includes('mythos'), false)
    assert.deepEqual(choices(true).filter((x) => TIERS.includes(x)), ['fable', 'mythos', 'opus', 'sonnet', 'haiku'])
    assert.equal(hireTierChoices({ claudeHire: claude(true) }, 'default')[0].tier, 'haiku',
      'the first offered model is not Mythos')
    // the store for surfaces without a HireState
    assert.equal(conditionalTierHidden('mythos'), true)
    setOfferedClaudeTiers(rows(true))
    assert.equal(conditionalTierHidden('mythos'), false)
    // Antigravity's list does not speak for a Claude tier, and the other way round
    setOfferedClaudeTiers(rows(false))
    setOfferedConditionalTiers([{ tier: 'mythos' }, { tier: 'neon' }])
    assert.equal(conditionalTierHidden('mythos'), true, 'another provider\'s rows are not evidence')
    assert.equal(conditionalTierHidden('neon'), false)
    setOfferedClaudeTiers([{ tier: 'mythos' }, { tier: 'argon' }])
    setOfferedConditionalTiers([])
    assert.equal(conditionalTierHidden('argon'), true)
    assert.equal(conditionalTierHidden('mythos'), false)
  })

/* ── §2 through each chooser ────────────────────────────────────────────── */

function card(node: CanvasNode, claudeHire: HireState) {
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
      claudeHire={claudeHire} codexHire={ON} antigravityHire={ON} onNoHarness={noop} />,
    (el) => el)
}

test('§2 canvas hire chips: no Mythos chip until the payload offers it', async (t: TestContext) => {
  fresh(t)
  const chip = (el: HTMLElement, tier: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.hsof button')].find((b) => hasClass(b, 't-' + tier))
  const off = await card(agent(), claude(false))
  t.after(() => off.unmount())
  assert.ok(chip(off.el, 'fable'), 'positive control: the Claude row rendered')
  assert.equal(Boolean(chip(off.el, 'mythos')), false, 'a Mythos chip rendered while no login provides it')
  await off.unmount()
  const on = await card(agent(), claude(true))
  t.after(() => on.unmount())
  const mythos = chip(on.el, 'mythos')
  assert.ok(mythos, 'no Mythos chip once the payload offers it')
  assert.equal(mythos!.disabled, false)
  assert.equal(mythos!.textContent, 'M')
})

test('§2 hire sheet: no Mythos button until the payload offers it', async (t: TestContext) => {
  fresh(t)
  const btn = (tier: string) => [...document.querySelectorAll<HTMLButtonElement>('.hs-tier')]
    .find((b) => hasClass(b, 't-' + tier))
  const sheet = (h: HireState) => mountView(
    <HireSheet anchor={agent()} seats={SEATS} defaultGrant={0}
      claudeHire={h} codexHire={ON} antigravityHire={ON}
      onHire={noop} onClose={noop} />, (el) => el)
  const off = await sheet(claude(false))
  await flush()
  assert.ok(btn('fable'), 'positive control: the Claude row rendered')
  assert.equal(Boolean(btn('mythos')), false, 'the sheet offered Mythos while no login provides it')
  await off.unmount()
  const on = await sheet(claude(true))
  t.after(() => on.unmount())
  await flush()
  assert.ok(btn('mythos'), 'the sheet did not offer Mythos once listed')
  assert.equal(btn('mythos')!.disabled, false)
})

function config(node: CanvasNode, mythos: boolean | null) {
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  return mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      claudeProvider={mythos === null ? null : provider(mythos)} codexProvider={null} antigravityProvider={null}
      close={noop} />,
    (el) => el)
}
const switchOption = (el: HTMLElement, tier: string) =>
  [...el.querySelectorAll<HTMLOptionElement>('.model-switch option')].find((o) => o.value === tier)

test('§2 agent settings model switch: no Mythos option until the payload offers it',
  async (t: TestContext) => {
    fresh(t)
    for (const none of [false, null]) {
      const off = await config(agent('opus'), none)
      assert.ok(switchOption(off.el, 'fable'), 'positive control: the Claude group rendered')
      assert.equal(Boolean(switchOption(off.el, 'mythos')), false,
        'the model switch listed Mythos while no login provides it')
      await off.unmount()
    }
    const on = await config(agent('opus'), true)
    t.after(() => on.unmount())
    const o = switchOption(on.el, 'mythos')
    assert.ok(o, 'the model switch did not list Mythos once listed')
    assert.equal(o!.disabled, false)
  })

test('§2 lineage rehire list: no "as mythos" row until the payload offers it',
  async (t: TestContext) => {
    fresh(t)
    const node = agent('opus', [{ id: 'agent@1', generation: 1, state: 'archived',
      bearer_state: 'knowledge', tier: 'opus' } as LineageEntry])
    const v = await mountView(
      <LineagePanel node={node} slug="org" close={noop}
        op={() => Promise.resolve({} as OpResult)} />, (el) => el)
    t.after(() => v.unmount())
    const opt = (tier: string) => [...v.el.querySelectorAll<HTMLOptionElement>('.lin-row select option')]
      .find((o) => o.value === tier)
    assert.ok(opt('fable'), 'positive control: the rehire list rendered')
    assert.equal(Boolean(opt('mythos')), false, 'the rehire list offered Mythos while no login provides it')
    await inAct(() => { setOfferedClaudeTiers(rows(true)) })
    await flush()
    assert.ok(opt('mythos'), 'the rehire list did not offer Mythos once listed (no re-render?)')
    await inAct(() => { setOfferedClaudeTiers(rows(false)) })
    await flush()
    assert.equal(Boolean(opt('mythos')), false, 'Mythos stayed after its login stopped providing it')
  })

/* ── §3 an agent already on Mythos ─────────────────────────────────────── */

test('§3 an agent already on Mythos keeps its own tier in the switch and its M token',
  async (t: TestContext) => {
    fresh(t)
    const cfg = await config(agent('mythos'), false)
    const sel = cfg.el.querySelector<HTMLSelectElement>('.model-switch')!
    assert.ok(switchOption(cfg.el, 'mythos'), 'a Mythos agent\'s own tier left its settings')
    assert.equal(sel.value, 'mythos')
    await cfg.unmount()
    const v = await card(agent('mythos'), claude(false))
    t.after(() => v.unmount())
    const token = [...v.el.querySelectorAll('.tier.t-mythos')].find((e) => !e.closest('.hsof'))
    assert.ok(token, 'the Mythos agent\'s card has no t-mythos tier token')
    assert.equal(token!.textContent, 'M')
    assert.ok(v.el.querySelector('.sq.tier-mythos') ?? v.el.matches('.sq.tier-mythos'),
      'the card is not classed tier-mythos (no accent colour)')
  })

/* ── §4 auto-autopsy: left out, as Fable is ────────────────────────────── */

test('§4 the auto-autopsy model list leaves Mythos out, as it leaves Fable out', (t: TestContext) => {
  fresh(t)
  const tiers = availableAutopsyModels({ providers: [provider(true)] })
    .flatMap((g) => g.models.map((m) => m.tier))
  assert.deepEqual(tiers, ['opus', 'sonnet', 'haiku'])
})

/* ── §5 the colour ──────────────────────────────────────────────────────── */

test('§5 Mythos has the user\'s colour on every Fable surface, with a pale backing where it is text', () => {
  const sheet = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(sheet, /--tier-mythos:\s*#785a20;/i, 'USER 2026-11-19 mb033e506819f "use #785a20"')
  assert.match(sheet, /--tier-fable:\s*#e8b04b;/i, 'Fable keeps its own colour')
  for (const sel of ['.chip.agents b.t-mythos', '.sq.tier-mythos', '.sq.mini.tier-mythos',
    '.tier.t-mythos', '.hsof button.t-mythos']) {
    const rule = new RegExp(sel.replace(/[.]/g, '\\.') + '\\b[^{]*\\{[^}]*var\\(--tier-mythos\\)')
    assert.match(sheet, rule, sel)
  }
  // MEASURED 2026-11-19 (colour_sweep.py, WCAG 2 contrast): #785a20 is 2.39:1 on the dark panel, 2.97:1 on
  // obsidian's and 2.03:1 on the token backing #313131 that tier letters sit on in every theme, so wherever it
  // is a LETTER it takes a pale backing of its own hue. The hue itself is the user's and is not changed.
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const backing = /--tier-mythos-backing:\s*(#[0-9a-f]{6});/i.exec(sheet)?.[1]
  assert.ok(backing, 'no --tier-mythos-backing')
  assert.ok(contrast('#785a20', backing!) >= 4.5, `the letter on its backing reads ${contrast('#785a20', backing!).toFixed(2)}:1`)
  assert.ok(contrast('#785a20', '#313131') < 3, 'control: without the backing it is under 3:1')
  // the backing is applied wherever the colour is text, and survives the light themes' dark token backing
  for (const sel of ['.tier.t-mythos', '.hsof button.t-mythos', '.chip.agents b.t-mythos']) {
    const rule = new RegExp(sel.replace(/[.]/g, '\\.') + '\\b[^{]*\\{[^}]*background:\\s*var\\(--tier-mythos-backing\\)')
    assert.match(sheet, rule, sel + ' has no backing')
  }
  assert.match(sheet, /:root:is\(\.contrast-light, \.contrast-solarized-light\)[^{]*t-mythos[^{]*\{[^}]*background:\s*var\(--tier-mythos-backing\)/,
    'the light themes\' dark token backing would win over the Mythos backing')
})
