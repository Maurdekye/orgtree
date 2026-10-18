// lightaccent.test.tsx — the app themes and provider colours on the light
// surfaces (user 2026-10-18 15:34Z: Orgtree Grey's accent text was the pale
// #b6bdc8 on the light backgrounds, 1.5-1.9:1, "hard to read"; 15:35Z: polish
// light mode as a whole).
//
//   §1 the light-surface rule: on light and solarized light the theme's accent
//      and its hover read at 4.5:1 or more on every surface accent text sits
//      on (the page, panels, inputs, the sidebar, the hover grey and the
//      accent wash of a selected, selected-urgent and hovered-urgent row), and
//      the ink on an accent fill reads on both. The --org-accent copies match,
//      every declaration outranks applyTheme's inline accent, and the rule is
//      scoped to those two surfaces, so charcoal, obsidian and every other
//      theme keep their accents (THEMES still says #b6bdc8).
//   §2 a popped-out window carries the root's data-visual-theme, the attribute
//      the light rules key on (this one and Muse Eggshell's), and follows a
//      change to it.
//   §3 the agents chips stay dark on the light surfaces (tier icons keep a
//      dark backing there, user 2026-10-13), so a deep light-surface partner
//      would vanish inside them: the working spinner drew #4c5565 on #313131
//      at 1.7:1. Inside them every theme's accent reads at 3:1 or more (a
//      graphic, WCAG 1.4.11), and the chip's count reads as text.
//   §3b the effort bar is a light control on the light surfaces: a light rail,
//      and a fill (the theme's accent, or a desk's provider colour) that stands
//      3:1 or more apart from it for every preset and provider.
//   §4 every preset theme meets §1's bar on the light surfaces, not only
//      Orgtree Grey: Claude Terracotta, Codex Teal, Antigravity Navy,
//      OpenRouter Lavender, LS Gold and Muse Eggshell painted accent text at
//      1.6-3.1:1 there. No theme-keyed rule reaches a dark surface.
//   §5 every provider colour reads on the light surfaces where a desk paints
//      text with it (inside a desk the provider is the accent), its fills keep
//      a readable ink, and the six stay 15 or more apart (CIE76), as the dark
//      palette keeps them.
//
// The values are properties, not pins: any accent that reads this well
// passes. lightaccent-visual.mjs measures the same thing in Electron, on the
// rendered inbox and Attention list.
//
// Run:  node apps/desktop/renderer/tests/run.mjs lightaccent
import { flush, inAct, mountView } from './harness'
import { installBridge, removeBridge } from './shellbridge'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { THEMES } from '../src/themes'
import { MovableSurface, PopoutButton } from '../src/popout'
import { captureWindow, windowLayoutKey } from '../src/windowlayout'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const linear = (c: number) => (c /= 255, c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lum = (hex: string) => { const [r, g, b] = rgb(hex).map(linear) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b }
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
/** color-mix(in srgb, a t, b): per channel in gamma-encoded sRGB */
const mix = (a: string, b: string, t: number) => '#' + rgb(a).map((v, i) =>
  Math.round(v * t + rgb(b)[i]! * (1 - t)).toString(16).padStart(2, '0')).join('')

/** a block's custom properties, `{ name: { value, important } }` */
function tokens(body: string) {
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+?)\s*;/g)].map((m) => {
    const important = /!important$/.test(m[2]!)
    return [m[1]!, { value: m[2]!.replace(/\s*!important$/, '').trim().toLowerCase(), important }]
  }))
}
function block(selector: string) {
  const at = css.indexOf(`\n${selector} {`)
  assert.ok(at >= 0, `styles.css has no ${selector} block`)
  return tokens(css.slice(at, css.indexOf('}', at)))
}
const SURFACES = ['bg', 'side', 'panel', 'panel-2', 'input'] as const
const families = {
  light: block(':root.contrast-light'),
  'solarized light': block(':root.contrast-solarized-light'),
}
/** every background accent text sits on in one contrast family */
function backgrounds(family: ReturnType<typeof tokens>, accent: string) {
  const s = Object.fromEntries(SURFACES.map((k) => {
    const v = family[k]?.value
    assert.match(v ?? '', /^#[0-9a-f]{6}$/, `--${k} is a plain colour`)
    return [k, v!]
  }))
  return {
    ...s,
    // .mailrow.on, .mailrow.urgent.on and .mailrow.urgent:hover (styles.css)
    'selected row': mix(accent, s.bg!, 0.13),
    'selected urgent row': mix(accent, s.bg!, 0.21),
    'hovered urgent row': mix(accent, s['panel-2']!, 0.16),
  }
}
const RULE = /\n:root\[data-visual-theme="orgtree"\]:is\(\.contrast-light, \.contrast-solarized-light\) \{([^}]*)\}/

/* ─── §1 the light-surface rule ───────────────────────────────────────────── */

test('§1 on the light surfaces the Orgtree Grey accent and its hover read on every background its text sits on', () => {
  // the dark surfaces keep the theme's own accent, and that pale grey is why the rule exists
  assert.equal(THEMES.orgtree.accent, '#b6bdc8')
  for (const family of Object.values(families)) assert.ok(contrast(THEMES.orgtree.accent, family.panel!.value) < 2)

  const rule = RULE.exec(css)
  assert.ok(rule, 'a light-surface rule for the Orgtree Grey theme, like Muse Eggshell\'s')
  const t = tokens(rule![1]!)
  for (const [name, { important }] of Object.entries(t)) {
    assert.ok(important, `--${name} must outrank the accent applyTheme sets inline (!important)`)
  }
  const accent = t.accent?.value, hover = t['accent-hover']?.value, ink = t['accent-ink']?.value
  for (const [name, v] of Object.entries({ accent, hover, ink })) assert.match(v ?? '', /^#[0-9a-f]{6}$/, `--${name} is a plain colour`)
  for (const [fname, family] of Object.entries(families)) {
    for (const [where, bg] of Object.entries(backgrounds(family, accent!))) {
      assert.ok(contrast(accent!, bg) >= 4.5, `accent ${accent} on ${fname} ${where} ${bg}: ${contrast(accent!, bg).toFixed(2)}:1`)
      assert.ok(contrast(hover!, bg) >= 4.5, `hover ${hover} on ${fname} ${where} ${bg}: ${contrast(hover!, bg).toFixed(2)}:1`)
    }
  }
  // the ink on an accent fill, at rest and under button.primary:hover
  assert.ok(contrast(ink!, accent!) >= 4.5, `ink ${ink} on ${accent}: ${contrast(ink!, accent!).toFixed(2)}:1`)
  assert.ok(contrast(ink!, hover!) >= 4.5, `ink ${ink} on ${hover}: ${contrast(ink!, hover!).toFixed(2)}:1`)
  // the soft wash is the accent at the alpha every preset uses
  const soft = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*(0?\.\d+)\)$/.exec(t['accent-soft']?.value ?? '')
  assert.ok(soft, `--accent-soft is an rgba(): ${t['accent-soft']?.value}`)
  assert.deepEqual(soft!.slice(1, 4).map(Number), rgb(accent!))
  assert.equal(Number(soft![4]), 0.16)
  // the organisation copies (desks in the organization agent-colour mode) match
  for (const k of ['accent', 'accent-hover', 'accent-soft']) assert.equal(t[`org-${k}`]?.value, t[k]?.value, `--org-${k}`)
})

test('§1 no Orgtree Grey rule reaches a dark surface', () => {
  assert.ok(RULE.test(css), 'the light-surface rule names exactly the light and solarized light surfaces')
  // every selector keyed on the theme is confined to those two surfaces
  const selectors = [...css.matchAll(/(?:^|[}\n])([^{}\n]*data-visual-theme="orgtree"[^{]*)\{/g)].map((m) => m[1]!.trim())
  assert.ok(selectors.length >= 1)
  for (const sel of selectors) assert.ok(sel.includes(':is(.contrast-light, .contrast-solarized-light)'), `${sel} reaches a dark surface`)
})

/* ─── §2 popped-out windows ──────────────────────────────────────────────── */

const KIND = 'lightaccent-fixture', ORG = 'org', KEY = windowLayoutKey(KIND, ORG)

test('§2 a popped-out window carries the root\'s data-visual-theme and follows a change to it', async () => {
  localStorage.clear()
  // the bridge makes the saved row real, so the window is restored at mount
  installBridge({})
  const root = document.documentElement
  root.dataset.visualTheme = 'orgtree'
  root.classList.add('contrast-light')
  const child = new JSDOM('<html><head></head><body></body></html>', { url: 'http://localhost/' })
  const cw = child.window as unknown as Window
  Object.defineProperties(cw, { screenX: { value: 200 }, screenY: { value: 180 }, outerWidth: { value: 830 }, outerHeight: { value: 700 } })
  cw.focus = () => {}; cw.requestAnimationFrame = () => 1; cw.cancelAnimationFrame = () => {}
  const originalOpen = window.open
  window.open = (() => cw) as typeof window.open
  const g = globalThis as unknown as { MutationObserver?: typeof MutationObserver }
  const originalObserver = g.MutationObserver
  g.MutationObserver = (window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver
  captureWindow(KEY, KIND, ORG, cw, true)
  const v = await mountView(<MovableSurface kind={KIND} org={ORG} title="Fixture">
    <p className="inside">inside</p><PopoutButton />
  </MovableSurface>, (el) => el)
  try {
    await inAct(async () => { await flush(10) })
    const childRoot = cw.document.documentElement
    assert.ok(cw.document.querySelector('p.inside'), 'positive control: the surface is in the popped-out window')
    assert.ok(childRoot.classList.contains('contrast-light'), 'positive control: the root classes are mirrored')
    assert.equal(childRoot.dataset.visualTheme, 'orgtree', 'the theme the light rules key on is mirrored too')
    // an attribute-only change, with no class or style write beside it
    root.dataset.visualTheme = 'muse'
    await inAct(async () => { await flush(10) })
    assert.equal(childRoot.dataset.visualTheme, 'muse', 'and follows a change')
    delete root.dataset.visualTheme
    await inAct(async () => { await flush(10) })
    assert.equal(childRoot.dataset.visualTheme, undefined, 'and its removal')
  } finally {
    await v.unmount(); window.open = originalOpen; g.MutationObserver = originalObserver
    removeBridge(); child.window.close(); localStorage.clear()
    delete root.dataset.visualTheme; root.classList.remove('contrast-light')
  }
})

/* ─── helpers for §3-§5 ──────────────────────────────────────────────────── */

const LIGHT = ':is(.contrast-light, .contrast-solarized-light)'
const ALL_RULES = /\n([^{}\n]+?)\s*\{([^}]*)\}/g
const PRESETS = Object.keys(THEMES) as Array<keyof typeof THEMES>
const PROVIDERS = ['claude', 'openai', 'google', 'openrouter', 'muse', 'langserver'] as const
const escapeRe = (s: string) => s.replace(/[.()[\]*+?^$|\\]/g, '\\$&')
/** the rules keyed on one theme on the light surfaces: `{ scope, t }`, scope '' for the root rule */
function themeRules(id: string) {
  const head = `:root[data-visual-theme="${id}"]${LIGHT}`
  return [...css.matchAll(ALL_RULES)]
    .filter((m) => m[1]!.startsWith(head))
    .map((m) => ({ scope: m[1]!.slice(head.length).trim(), t: tokens(m[2]!) }))
}
/** the accent a widget draws with: its own scoped rule, else the root rule, else the theme's own */
function accentInside(id: keyof typeof THEMES, widget: string) {
  const rules = themeRules(id)
  return rules.find((r) => r.scope.includes(widget) && r.t.accent)?.t.accent!.value
    ?? rules.find((r) => r.scope === '')?.t.accent?.value
    ?? THEMES[id].accent.toLowerCase()
}
/** the body of the LAST block with exactly this selector (the cascade's order) */
function lastBody(selector: string) {
  const all = [...css.matchAll(new RegExp(`\\n${escapeRe(selector)} \\{([^}]*)\\}`, 'g'))]
  return all.length ? all[all.length - 1]![1] : undefined
}
function fill(selector: string) {
  return /background:\s*(#[0-9a-f]{6})/i.exec(lastBody(selector) ?? '')?.[1]?.toLowerCase()
}
/** a preset's accent, hover and ink on the light surfaces: its light rule's, else its own */
function presetLight(id: keyof typeof THEMES) {
  const t = themeRules(id).find((r) => r.scope === '')?.t
  return {
    t,
    accent: t?.accent?.value ?? THEMES[id].accent.toLowerCase(),
    hover: t?.['accent-hover']?.value ?? THEMES[id].hover.toLowerCase(),
    ink: t?.['accent-ink']?.value ?? '#17191d',
  }
}
/** custom properties of every block with exactly this selector, later blocks winning */
function merged(selector: string) {
  const out: ReturnType<typeof tokens> = {}
  for (const x of css.matchAll(new RegExp(`\\n${escapeRe(selector)} \\{([^}]*)\\}`, 'g'))) Object.assign(out, tokens(x[1]!))
  return out
}
/** each provider's colour on the light surfaces: the light blocks', else the root's */
function providerColours(): Array<[string, string]> {
  const base = merged(':root'), light = merged(`:root${LIGHT}`)
  return PROVIDERS.map((p) => [`--prov-${p}`, (light[`prov-${p}`] ?? base[`prov-${p}`])?.value ?? ''])
}
/** CIE76 distance in D65 Lab */
function deltaE(a: string, b: string) {
  const lab = (h: string) => {
    const [r, g, bl] = rgb(h).map(linear) as [number, number, number]
    const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
    const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * bl) / 0.95047)
    const y = f(0.2126729 * r + 0.7151522 * g + 0.0721750 * bl)
    const z = f((0.0193339 * r + 0.1191920 * g + 0.9503041 * bl) / 1.08883)
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
  }
  const [p, q] = [lab(a), lab(b)]
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)
}

/* ─── §3 the dark-backed agents chips ────────────────────────────────────── */

test('§3 inside the agents chips every theme\'s accent reads on their dark backing', () => {
  const chip = fill(`:root${LIGHT} :is(.tier, .chip.agents)`)
  assert.match(chip ?? '', /^#[0-9a-f]{6}$/, 'the light surfaces give the agents chips a dark backing')
  for (const family of Object.values(families)) {
    assert.ok(contrast(chip!, family.panel!.value) > 7, `positive control: ${chip} is dark on the light panel ${family.panel!.value}`)
  }
  for (const id of PRESETS) {
    const spin = accentInside(id, '.chip.agents')
    assert.ok(contrast(spin, chip!) >= 3, `${id}: the working spinner ${spin} on the chip ${chip}: ${contrast(spin, chip!).toFixed(2)}:1`)
  }
  // the active/hired count is text in --dim
  const scoped = [...css.matchAll(ALL_RULES)]
    .filter((m) => m[1]!.startsWith(`:root${LIGHT} `) && m[1]!.includes('.chip.agents'))
    .map((m) => tokens(m[2]!).dim?.value).find(Boolean)
  for (const [fname, family] of Object.entries(families)) {
    const dim = scoped ?? family.dim!.value
    assert.ok(contrast(dim, chip!) >= 4.5, `${fname}: the count ${dim} on the chip ${chip}: ${contrast(dim, chip!).toFixed(2)}:1`)
  }
})

/* ─── §3b the effort bar ─────────────────────────────────────────────────── */

test('§3b on the light surfaces the effort bar is a light control whose fill stands apart from its rail', () => {
  const rail = lastBody(`:root${LIGHT} .effort-bar-rail`), bar = lastBody(`:root${LIGHT} .effort-bar-fill`)
  assert.ok(rail !== undefined && bar !== undefined, 'light-surface rules for the effort rail and fill')
  const railToken = /background:\s*var\(--([a-z0-9-]+)\)/.exec(rail!)?.[1]
  const m = /background:\s*color-mix\(in srgb, var\(--provider-accent, var\(--accent\)\) (\d+)%, var\(--([a-z0-9-]+)\)\)/.exec(bar!)
  assert.ok(railToken && m, `the rail is a surface token and the fill mixes the accent (or a desk's provider) into one: ${rail} / ${bar}`)
  const share = Number(m![1]) / 100
  const colours: Array<[string, string]> = [...PRESETS.map((id) => [id, presetLight(id).accent] as [string, string]), ...providerColours()]
  for (const [fname, family] of Object.entries(families)) {
    const r = family[railToken!]?.value, under = family[m![2]!]?.value
    assert.match(r ?? '', /^#[0-9a-f]{6}$/, `${fname}: --${railToken} is a plain colour`)
    assert.ok(contrast(r!, family.panel!.value) < 1.5, `${fname}: the rail ${r} is light on the panel ${family.panel!.value}`)
    for (const [who, c] of colours) {
      const f = mix(c, under!, share)
      // the level is a graphic: 3:1 against what it sits on (WCAG 1.4.11)
      assert.ok(contrast(f, r!) >= 3, `${fname} ${who}: the fill ${f} on the rail ${r}: ${contrast(f, r!).toFixed(2)}:1`)
    }
  }
})

/* ─── §4 every preset ────────────────────────────────────────────────────── */

test('§4 on the light surfaces every preset theme\'s accent, hover and ink read as Orgtree Grey\'s do', () => {
  for (const id of PRESETS) {
    const { t, accent, hover, ink } = presetLight(id)
    for (const [name, v] of Object.entries({ accent, hover, ink })) assert.match(v, /^#[0-9a-f]{6}$/, `${id}: --${name} is a plain colour`)
    for (const [fname, family] of Object.entries(families)) {
      for (const [where, bg] of Object.entries(backgrounds(family, accent))) {
        assert.ok(contrast(accent, bg) >= 4.5, `${id}: accent ${accent} on ${fname} ${where} ${bg}: ${contrast(accent, bg).toFixed(2)}:1`)
        assert.ok(contrast(hover, bg) >= 4.5, `${id}: hover ${hover} on ${fname} ${where} ${bg}: ${contrast(hover, bg).toFixed(2)}:1`)
      }
    }
    assert.ok(contrast(ink, accent) >= 4.5, `${id}: ink ${ink} on ${accent}: ${contrast(ink, accent).toFixed(2)}:1`)
    assert.ok(contrast(ink, hover) >= 4.5, `${id}: ink ${ink} on ${hover}: ${contrast(ink, hover).toFixed(2)}:1`)
    assert.ok(t, `${id}: a light-surface rule`)
    for (const [name, { important }] of Object.entries(t!)) {
      assert.ok(important, `${id}: --${name} must outrank the accent applyTheme sets inline (!important)`)
    }
    const soft = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*(0?\.\d+)\)$/.exec(t!['accent-soft']?.value ?? '')
    assert.ok(soft, `${id}: --accent-soft is an rgba(): ${t!['accent-soft']?.value}`)
    assert.deepEqual(soft!.slice(1, 4).map(Number), rgb(accent), `${id}: the soft wash is the accent`)
    assert.equal(Number(soft![4]), 0.16, `${id}: at the alpha every preset uses`)
    for (const k of ['accent', 'accent-hover', 'accent-soft']) assert.equal(t![`org-${k}`]?.value, t![k]?.value, `${id}: --org-${k}`)
  }
  // and none of them reaches a dark surface
  const selectors = [...css.matchAll(/(?:^|[}\n])([^{}\n]*data-visual-theme="[^"]+"[^{]*)\{/g)].map((x) => x[1]!.trim())
  assert.ok(selectors.length >= PRESETS.length, 'positive control: the theme-keyed selectors are found')
  for (const sel of selectors) assert.ok(sel.includes(LIGHT), `${sel} reaches a dark surface`)
})

/* ─── §5 the provider colours ────────────────────────────────────────────── */

test('§5 on the light surfaces every provider colour reads where a desk paints text with it, and they stay apart', () => {
  const colours = providerColours()
  const base = merged(':root'), light = merged(`:root${LIGHT}`)
  for (const [name, c] of colours) {
    assert.match(c, /^#[0-9a-f]{6}$/, `${name} is a plain colour on the light surfaces: ${c}`)
    // inside a desk the provider IS the accent: unread names, pills and links on rows and washes
    for (const [fname, family] of Object.entries(families)) {
      for (const [where, bg] of Object.entries(backgrounds(family, c))) {
        assert.ok(contrast(c, bg) >= 4.5, `${name} ${c} on ${fname} ${where} ${bg}: ${contrast(c, bg).toFixed(2)}:1`)
      }
    }
    // the text on its fills: its own ink token where it has one, else the white the fills default to
    const ink = (light[`${name.slice(2)}-ink`] ?? base[`${name.slice(2)}-ink`])?.value ?? '#ffffff'
    assert.ok(contrast(ink, c) >= 4.5, `${name}: ink ${ink} on ${c}: ${contrast(ink, c).toFixed(2)}:1`)
  }
  // the dark palette keeps its providers 15 or more apart (CIE76, normal vision); so do the partners
  for (let i = 0; i < colours.length; i++) {
    for (let j = i + 1; j < colours.length; j++) {
      const [[a, x], [b, y]] = [colours[i]!, colours[j]!]
      assert.ok(deltaE(x, y) >= 15, `${a} ${x} and ${b} ${y} are only ${deltaE(x, y).toFixed(1)} apart`)
    }
  }
})
