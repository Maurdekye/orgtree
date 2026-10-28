// carbon.test.tsx — the speculative Gemini 4 Carbon appears only once agy lists
// it, in a light charcoal grey.
//
// User 2026-10-10: "prepare a model selection for it if it appears; same as the
// other two" — a copy of Barium, hidden until listed. User 2026-10-28
// (m09d1c2c45be4): "i want its model color to be a light charcoal grey" — it
// began as chartreuse #c6ff00 and is now #6d7e8c (§4b measures it).
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
  luna: 0.1, terra: 2, sol: 2, astra: 10, flash: 1, pro: 2, carbon: 2 }
const ON: HireState = { enabled: true, installed: true, reason: null }
/** the Antigravity hire state as `hireOf` builds it from the payload rows */
const google = (carbon: boolean): HireState =>
  ({ ...ON, offeredTiers: carbon ? ['flash', 'pro', 'carbon'] : ['flash', 'pro'] })
const rows = (carbon: boolean) => (carbon ? ['flash', 'pro', 'carbon'] : ['flash', 'pro'])
  .map((tier) => ({ tier, provider: 'google', seat: SEATS[tier as keyof typeof SEATS],
    model: tier === 'carbon' ? 'gemini-4-carbon' : 'gemini-' + tier,
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

test('§1 carbon is a conditional Antigravity tier; flash and pro are not', (t: TestContext) => {
  fresh(t)
  assert.ok(ANTIGRAVITY_TIERS.includes('carbon'))
  assert.deepEqual(CONDITIONAL_ANTIGRAVITY_TIERS, ['argon', 'barium', 'carbon', 'agy-sonnet', 'agy-opus'])
  assert.equal(TIER_LETTER.carbon, 'C')
  assert.equal(ANTIGRAVITY_TIER_SEAT.carbon, 2, 'placeholder seat copies pro')
  // no payload evidence: hidden
  assert.equal(antigravityTierOffer(null, 'carbon'), 'hide')
  assert.equal(antigravityTierOffer(ON, 'carbon'), 'hide')
  assert.equal(antigravityTierOffer(google(false), 'carbon'), 'hide')
  assert.equal(antigravityTierOffer(google(true), 'carbon'), 'offer')
  // the family verdict still applies once listed
  assert.equal(antigravityTierOffer({ ...google(true), enabled: false }, 'carbon'), 'disable')
  assert.equal(antigravityTierOffer({ ...google(true), userEnabled: false }, 'carbon'), 'hide')
  // flash is unaffected either way; pro keeps its legacy-toggle rule
  assert.equal(antigravityTierOffer(google(false), 'flash'), 'offer')
  assert.equal(antigravityTierOffer(google(false), 'pro'), 'hide')
  // the store for surfaces without a HireState
  assert.equal(conditionalTierHidden('carbon'), true)
  setOfferedConditionalTiers(rows(true))
  assert.equal(conditionalTierHidden('carbon'), false)
  setOfferedConditionalTiers(rows(false))
  assert.equal(conditionalTierHidden('carbon'), true)
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

test('§2 canvas hire chips: no Carbon chip until the payload offers it', async (t: TestContext) => {
  fresh(t)
  const chip = (el: HTMLElement, tier: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.hsof button')].find((b) => hasClass(b, 't-' + tier))
  const off = await card(agent(), google(false))
  t.after(() => off.unmount())
  assert.ok(chip(off.el, 'flash'), 'positive control: the Antigravity row rendered')
  assert.equal(Boolean(chip(off.el, 'carbon')), false, 'a Carbon chip rendered while agy does not list it')
  await off.unmount()
  const on = await card(agent(), google(true))
  t.after(() => on.unmount())
  const carbon = chip(on.el, 'carbon')
  assert.ok(carbon, 'no Carbon chip once the payload offers it')
  assert.equal(carbon!.disabled, false)
  assert.equal(carbon!.textContent, 'C')
})

test('§2 hire sheet: no Carbon button until the payload offers it', async (t: TestContext) => {
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
  assert.equal(Boolean(btn('carbon')), false, 'the sheet offered Carbon while agy does not list it')
  await off.unmount()
  const on = await sheet(google(true))
  t.after(() => on.unmount())
  await flush()
  assert.ok(btn('carbon'), 'the sheet did not offer Carbon once listed')
  assert.equal(btn('carbon')!.disabled, false)
})

function config(node: CanvasNode, carbon: boolean) {
  const tree = { slug: 'org', dirs: [], tiers: SEATS, max_top_grant: 100,
    default_effort: '', effort_default: 'high', cascade_hire: true } as unknown as TreePayload
  const provider: ProviderInfo = { id: 'google', label: 'Antigravity', cli: 'agy',
    tiers: rows(carbon), status: { installed: true, connected: true, kind: 'google' },
    hire_enabled: true, reason: null } as unknown as ProviderInfo
  return mountView(
    <NodeConfig node={node} map={new Map([[node.id, node]])} tree={tree} slug="org"
      op={() => Promise.resolve({} as OpResult)} toast={noop}
      codexProvider={null} antigravityProvider={provider} close={noop} />,
    (el) => el)
}
const switchOption = (el: HTMLElement, tier: string) =>
  [...el.querySelectorAll<HTMLOptionElement>('.model-switch option')].find((o) => o.value === tier)

test('§2 agent settings model switch: no Carbon option until the payload offers it',
  async (t: TestContext) => {
    fresh(t)
    const off = await config(agent('flash'), false)
    assert.ok(switchOption(off.el, 'flash'), 'positive control: the Antigravity group rendered')
    assert.equal(Boolean(switchOption(off.el, 'carbon')), false,
      'the model switch listed Carbon while agy does not list it')
    await off.unmount()
    const on = await config(agent('flash'), true)
    t.after(() => on.unmount())
    const o = switchOption(on.el, 'carbon')
    assert.ok(o, 'the model switch did not list Carbon once listed')
    assert.equal(o!.disabled, false)
  })

test('§2 lineage rehire list: no "as carbon" row until the payload offers it',
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
    assert.equal(Boolean(opt('carbon')), false, 'the rehire list offered Carbon while agy does not list it')
    await inAct(() => { setOfferedConditionalTiers(rows(true)) })
    await flush()
    assert.ok(opt('carbon'), 'the rehire list did not offer Carbon once listed (no re-render?)')
    assert.equal(opt('carbon')!.disabled, false, 'a flash bearer may be rehired as carbon')
    await inAct(() => { setOfferedConditionalTiers(rows(false)) })
    await flush()
    assert.equal(Boolean(opt('carbon')), false, 'Carbon stayed after agy stopped listing it')
  })

/* ── §3 an agent already on Carbon ───────────────────────────────────────── */

test('§3 an agent already on Carbon keeps its own tier in the switch and its C token',
  async (t: TestContext) => {
    fresh(t)
    const cfg = await config(agent('carbon'), false)
    const sel = cfg.el.querySelector<HTMLSelectElement>('.model-switch')!
    assert.ok(switchOption(cfg.el, 'carbon'), 'a Carbon agent\'s own tier left its settings')
    assert.equal(sel.value, 'carbon')
    await cfg.unmount()
    const v = await card(agent('carbon'), google(false))
    t.after(() => v.unmount())
    const token = [...v.el.querySelectorAll('.tier.t-carbon')].find((e) => !e.closest('.hsof'))
    assert.ok(token, 'the Carbon agent\'s card has no t-carbon tier token')
    assert.equal(token!.textContent, 'C')
    assert.ok(v.el.querySelector('.sq.tier-carbon') ?? v.el.matches('.sq.tier-carbon'),
      'the card is not classed tier-carbon (no accent/glow colour)')
  })

/* ── §4 the colour ──────────────────────────────────────────────────────── */

// User 2026-10-28 m09d1c2c45be4: "i want its model color to be a light charcoal
// grey". Charcoal is a dark slate grey (#36454F: Lab chroma ~11); "light" lifts
// it. Grey is the one colour this palette already crowds (--dim, --ink, luna,
// astra, flash, the edges), so §4b measures the pick instead of trusting it.
const CARBON_GREY = '#6d7e8c'
const css = () => readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
/** the --tier-carbon the stylesheet declares (the §4b tests measure this, not CARBON_GREY) */
function paintedCarbon(sheet = css()): string {
  const m = sheet.match(/--tier-carbon:\s*(#[0-9a-f]{6})\s*;/i)
  assert.ok(m, 'no --tier-carbon hex in styles.css')
  return m![1]!.toLowerCase()
}

type Rgb = [number, number, number]
/** a hex the stylesheet must declare in this theme block (a missing one fails here, not as `undefined` later) */
function need(theme: Record<string, string>, key: string): string {
  const v = theme[key]
  assert.ok(v, `no ${key} in the theme block`)
  return v
}
const rgbOf = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb
const toLin = (c: Rgb): Rgb => c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as Rgb
const fromLin = (c: Rgb): Rgb => c.map((v) => {
  const x = Math.min(1, Math.max(0, v))
  return x > 0.0031308 ? 1.055 * x ** (1 / 2.4) - 0.055 : 12.92 * x
}) as Rgb
function labOf(c: Rgb): [number, number, number] {
  const [r, g, b] = toLin(c)
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  const fx = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047)
  const fy = f(0.2126729 * r + 0.7151522 * g + 0.0721750 * b)
  const fz = f((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}
const dE = (a: Rgb, b: Rgb) => {
  const [l1, a1, b1] = labOf(a), [l2, a2, b2] = labOf(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}
// Machado 2009, severity 1, in linear sRGB
type Cvd = 'deuteranopia' | 'protanopia'
const CVD: Record<Cvd, [Rgb, Rgb, Rgb]> = {
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
}
const simulate = (c: Rgb, kind: Cvd): Rgb => {
  const l = toLin(c), m = CVD[kind]
  return fromLin(m.map((row) => row[0] * l[0] + row[1] * l[1] + row[2] * l[2]) as Rgb)
}
const luminance = (c: Rgb) => { const [r, g, b] = toLin(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrastOf = (a: Rgb, b: Rgb) => {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
const mix = (a: Rgb, b: Rgb, pa: number): Rgb => a.map((v, i) => pa * v + (1 - pa) * b[i]!) as Rgb

/** the hex declarations of the first rule that opens with `selector {` */
function declarations(sheet: string, selector: string): Record<string, string> {
  const at = sheet.indexOf(selector + ' {')
  assert.ok(at >= 0, `no "${selector} {" rule`)
  const body = sheet.slice(at + selector.length + 2, sheet.indexOf('}', at))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) out[m[1]!] = m[2]!
  return out
}

test('§4 Carbon uses its light charcoal grey on every tier surface', () => {
  const sheet = css()
  assert.match(sheet, new RegExp(`--tier-carbon:\\s*${CARBON_GREY};`, 'i'))
  assert.notEqual(paintedCarbon(sheet), '#c6ff00', 'the old chartreuse is still painted')
  // every class family pro has, carbon has too (chips, cards, mini, desk, badges)
  for (const sel of ['.chip.agents b.t-carbon', '.sq.tier-carbon', '.sq.mini.tier-carbon',
    '.sq.prov-google.desk.tier-carbon', '.tier.t-carbon', '.hsof button.t-carbon']) {
    assert.ok(sheet.includes(sel + ' {'), `no "${sel}" rule`)
  }
})

test('§4b Carbon reads as a light charcoal grey', () => {
  const [L, a, b] = labOf(rgbOf(paintedCarbon()))
  const chroma = Math.hypot(a, b)
  // charcoal #36454F is L 28, chroma ~11; light charcoal keeps the slate tilt
  // and lifts L into the middle of the range. Not black (L < 45), not silver
  // (L > 62, where it would merge with --dim), not a colour (chroma > 12).
  assert.ok(L >= 45 && L <= 62, `L* ${L.toFixed(1)} is not a light charcoal`)
  assert.ok(chroma >= 4 && chroma <= 12, `chroma ${chroma.toFixed(1)} is not a tinted grey`)
  assert.ok(b < 0 && a <= 0, 'the slate tilt is cool: blue-ward, not warm or green')
})

test('§4b Carbon stays clear of every other model colour and the dark neutrals', () => {
  const sheet = css()
  const carbon = rgbOf(paintedCarbon(sheet))
  const others: Record<string, string> = {}
  for (const m of sheet.matchAll(/--tier-([a-z-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    if (m[1] !== 'carbon') others['tier ' + m[1]] = m[2]!
  }
  // provider accents and the ice/teal blues, every hex definition. The light themes redefine some
  // (--ice #326b82, --prov-google #0045c7): those never share a surface with the dark set, so they
  // get this file's colour-blind floor (8) instead of the dark set's 14.
  const lightOthers: Record<string, string> = {}
  for (const k of ['--prov-claude', '--prov-openai', '--prov-google', '--ice', '--teal']) {
    const all = [...sheet.matchAll(new RegExp(k + ':\\s*(#[0-9a-f]{6})', 'gi'))]
    assert.ok(all.length, `no ${k}`)
    for (const m of all) {
      const open = sheet.lastIndexOf('{', m.index!)
      const selector = sheet.slice(sheet.lastIndexOf('}', open) + 1, open).replace(/\/\*[\s\S]*?\*\//g, '')
      ;(/contrast-(light|solarized-light)/.test(selector) ? lightOthers : others)[`accent ${k} ${m[1]}`] = m[1]!
    }
  }
  assert.ok(Object.keys(lightOthers).length >= 1, 'the light-theme accents did not parse')
  assert.ok(Object.keys(others).filter((k) => k.startsWith('tier ')).length >= 14, 'the tier colours did not parse')
  for (const [k, v] of Object.entries(declarations(sheet, ':root'))) {
    if (/^--(bg|side|panel|panel-2|input|ink|ink-strong|dim|line|line-soft|line-hover|scrollbar|scrollbar-hover|canvas-dot|peer-edge|tether-edge)$/.test(k)) others['charcoal ' + k] = v
  }
  for (const [k, v] of Object.entries(declarations(sheet, ':root.contrast-obsidian-black'))) {
    if (/^--(bg|side|panel|panel-2|input|ink|ink-strong|dim|line|line-soft)$/.test(k)) others['obsidian ' + k] = v
  }
  assert.ok(Object.keys(others).filter((k) => k.startsWith('charcoal ')).length >= 12, 'the charcoal neutrals did not parse')
  const KINDS = ['normal', 'deuteranopia', 'protanopia'] as const
  const worstOf = (set: Record<string, string>) => {
    const worst: Record<(typeof KINDS)[number], [number, string]> = { normal: [Infinity, ''], deuteranopia: [Infinity, ''], protanopia: [Infinity, ''] }
    for (const [name, hex] of Object.entries(set)) {
      const o = rgbOf(hex)
      const d: Record<(typeof KINDS)[number], number> = { normal: dE(carbon, o),
        deuteranopia: dE(simulate(carbon, 'deuteranopia'), simulate(o, 'deuteranopia')),
        protanopia: dE(simulate(carbon, 'protanopia'), simulate(o, 'protanopia')) }
      for (const k of KINDS) if (d[k] < worst[k][0]) worst[k] = [d[k], name]
    }
    return worst
  }
  // this file's stated normal-vision floor is CIE76 15 and its colour-blind floor 8. The dark set is
  // held to 14 under colour blindness (measured 14.9, protanopia vs --dim); the light variants to 8
  // (measured 10.8, protanopia vs the light --ice).
  for (const [what, set, cvdFloor] of [['dark surfaces', others, 14], ['light-theme accents', lightOthers, 8]] as const) {
    const worst = worstOf(set)
    assert.ok(worst.normal[0] >= 15, `${what}: ΔE ${worst.normal[0].toFixed(1)} from ${worst.normal[1]} is under the 15 floor`)
    assert.ok(worst.deuteranopia[0] >= cvdFloor, `${what}: deuteranopia ΔE ${worst.deuteranopia[0].toFixed(1)} from ${worst.deuteranopia[1]}`)
    assert.ok(worst.protanopia[0] >= cvdFloor, `${what}: protanopia ΔE ${worst.protanopia[0].toFixed(1)} from ${worst.protanopia[1]}`)
  }
})

test('§4b Carbon is legible on the surfaces it is drawn on, and its card edge shows in every theme', () => {
  const sheet = css()
  const carbon = rgbOf(paintedCarbon(sheet))
  const dark = declarations(sheet, ':root')
  const obsidian = declarations(sheet, ':root.contrast-obsidian-black')
  const light = declarations(sheet, ':root.contrast-light')
  const solar = declarations(sheet, ':root.contrast-solarized-light')
  // the tier letter is drawn on --panel/--input (dark themes) and on a #313131
  // badge fill (light themes). 3:1 is the non-text floor; pro, the one existing
  // tier below it, is 2.5:1 on --panel and 2.1:1 on the badge fill.
  for (const [name, bg] of [['charcoal --panel', need(dark, '--panel')], ['charcoal --input', need(dark, '--input')],
    ['obsidian --panel', need(obsidian, '--panel')], ['light badge fill', '#313131'],
    ['light --panel', need(light, '--panel')], ['solarized --panel', need(solar, '--panel')]] as const) {
    const c = contrastOf(carbon, rgbOf(bg))
    assert.ok(c >= 3, `${paintedCarbon(sheet)} is ${c.toFixed(2)}:1 on ${name} ${bg}`)
  }
  // the 3px card top edge is color-mix(tier 55%, --line): it must differ from
  // a plain --line edge or the card reads untinted
  for (const [name, theme] of [['charcoal', dark], ['obsidian', obsidian], ['light', light], ['solarized', solar]] as const) {
    const line = rgbOf(need(theme, '--line'))
    const d = dE(mix(carbon, line, 0.55), line)
    assert.ok(d >= 15, `${name}: the Carbon card edge is ΔE ${d.toFixed(1)} from the plain --line`)
  }
})

test('Argon, Barium and Carbon offers are independent', (t: TestContext) => {
  fresh(t)
  for (const offered of [[], ['carbon'], ['argon', 'carbon'], ['barium', 'carbon'], ['argon', 'barium']]) {
    const h = { ...ON, offeredTiers: ['flash', 'pro', ...offered] }
    for (const tier of ['argon', 'barium', 'carbon']) {
      assert.equal(antigravityTierOffer(h, tier), offered.includes(tier) ? 'offer' : 'hide')
    }
  }
})
