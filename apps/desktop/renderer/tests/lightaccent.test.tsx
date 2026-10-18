// lightaccent.test.tsx — the Orgtree Grey theme on the light surfaces (user
// 2026-10-18 15:34Z: its accent text was the pale #b6bdc8 on the light
// backgrounds, 1.5-1.9:1, "hard to read").
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
