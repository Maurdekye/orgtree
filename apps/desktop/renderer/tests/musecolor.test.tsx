// musecolor.test.tsx — Muse Code's provider colour (user 2026-10-12 20:09Z:
// the exact baby-blue cyan of Muse's official marketing, on every
// provider-colour surface, readable in every theme) and its three tier
// colours.
//
// What is pinned and what is measured: the dark-surface accent IS pinned —
// it is a value sampled from Muse's own art (lead decision 2026-10-13), not
// a design choice, and the renderer's TypeScript copy must stay equal to the
// stylesheet's. Everything else is a property: the light-surface partner and
// the inks must READ (WCAG contrast), the tier colours must read on the dark
// chip backgrounds and stay apart from every other tier colour, and every
// provider-colour rule Antigravity has, Muse has too.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs musecolor

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MUSE_COLOR, MUSE_TIERS, MUSE_TIER_LETTER, TIER_LETTER } from '../src/canvas/shared'
import { THEMES } from '../src/themes'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

/** every hex value this token is given, in file order */
function token(name: string): string[] {
  const out = [...css.matchAll(new RegExp(String.raw`--${name}:\s*(#[0-9a-fA-F]{6})\s*;`, 'g'))]
    .map((m) => m[1]!.toLowerCase())
  assert.ok(out.length > 0, `--${name} is not defined in styles.css at all`)
  return out
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const linear = (c: number) => (c /= 255, c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

function deltaE(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = rgb(hex).map(linear) as [number, number, number]
    const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722
    const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
  }
  const [la, lb] = [lab(a), lab(b)]
  return Math.hypot(la[0]! - lb[0]!, la[1]! - lb[1]!, la[2]! - lb[2]!)
}

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgb(hex).map(linear) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const DARK = { panel: '#252526', bg: '#1f1f1f', input: '#313131', obsidian: '#101010' }
const LIGHT = { panel: '#ffffff', bg: '#f6f7f9', solarizedPanel: '#fffbef', solarizedBg: '#fdf6e3' }

test('the dark accent is the sampled official cyan, the same value in TypeScript and CSS', () => {
  const [dark] = token('prov-muse')
  assert.equal(MUSE_COLOR, '#afe5ff')
  assert.equal(dark, MUSE_COLOR)
})

test('the accent reads on every dark surface and its light partner on every light one', () => {
  const [dark, light] = token('prov-muse')
  for (const [name, bg] of Object.entries(DARK)) {
    assert.ok(contrast(dark!, bg) >= 4.5, `${dark} on ${name} ${bg}: ${contrast(dark!, bg).toFixed(2)}:1`)
  }
  assert.ok(light, 'the light surfaces rebind --prov-muse')
  assert.notEqual(light, dark)
  for (const [name, bg] of Object.entries(LIGHT)) {
    assert.ok(contrast(light!, bg) >= 4.5, `${light} on ${name} ${bg}: ${contrast(light!, bg).toFixed(2)}:1`)
  }
  // the pale cyan itself would not: this is why the partner exists
  assert.ok(contrast(dark!, LIGHT.panel) < 2)
})

test('the text on an accent fill reads in both themes', () => {
  const [dark, light] = token('prov-muse')
  const [darkInk, lightInk] = token('prov-muse-ink')
  assert.ok(contrast(darkInk!, dark!) >= 4.5, `${darkInk} on ${dark}`)
  assert.ok(contrast(lightInk!, light!) >= 4.5, `${lightInk} on ${light}`)
  // white on the pale cyan is the failure the ink replaces
  assert.ok(contrast('#ffffff', dark!) < 2)
})

test('Muse tier colours read on the chip backgrounds and stay apart from every other tier colour', () => {
  const muse = Object.fromEntries(MUSE_TIERS.map((t) => [t, token(`tier-${t}`)[0]!]))
  const others = [...css.matchAll(/--tier-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)]
    .filter((m) => !MUSE_TIERS.includes(m[1]!))
    .map((m) => [m[1]!, m[2]!.toLowerCase()] as const)
  assert.ok(others.length >= 10, 'found the other tier colours')
  for (const [tier, hex] of Object.entries(muse)) {
    for (const [name, bg] of Object.entries({ panel: DARK.panel, input: DARK.input })) {
      assert.ok(contrast(hex, bg) >= 4.5, `${tier} ${hex} on ${name}: ${contrast(hex, bg).toFixed(2)}:1`)
    }
    for (const [other, ohex] of others) {
      assert.ok(deltaE(hex, ohex) >= 15, `${tier} ${hex} is ${deltaE(hex, ohex).toFixed(1)} from ${other} ${ohex}`)
    }
    assert.ok(deltaE(hex, MUSE_COLOR) >= 15, `${tier} ${hex} vs the Muse accent`)
  }
  const hexes = Object.values(muse)
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) assert.ok(deltaE(hexes[i]!, hexes[j]!) >= 15)
  }
})

test('the Muse Eggshell app theme is the provider cyan, apart from every other preset and readable on light surfaces', () => {
  // the existing provider-theme requirement (docs/v2-visual-themes.md; the
  // LS Gold precedent's floor of 18 between presets)
  assert.equal(THEMES.muse.label, 'Muse Eggshell')
  assert.equal(THEMES.muse.accent, MUSE_COLOR)
  for (const [id, theme] of Object.entries(THEMES)) {
    if (id === 'muse') continue
    assert.ok(deltaE(MUSE_COLOR, theme.accent) >= 18, `${id}: only ΔE ${deltaE(MUSE_COLOR, theme.accent).toFixed(1)}`)
  }
  const rule = /:root\[data-visual-theme="muse"\]:is\(\.contrast-light, \.contrast-solarized-light\) \{([^}]*)\}/.exec(css)
  assert.ok(rule, 'the light-surface rule for the Muse theme')
  const accent = /--accent:\s*(#[0-9a-fA-F]{6})\s*!important/.exec(rule![1]!)![1]!.toLowerCase()
  for (const [name, bg] of Object.entries(LIGHT)) {
    assert.ok(contrast(accent, bg) >= 4.5, `${accent} on ${name}: ${contrast(accent, bg).toFixed(2)}:1`)
  }
  assert.ok(contrast('#ffffff', accent) >= 4.5, 'white ink on the light-surface accent')
})

test('every Muse tier has its letter and its chip, card, mini-card and hire-strip rules', () => {
  for (const t of MUSE_TIERS) {
    assert.equal(TIER_LETTER[t], MUSE_TIER_LETTER[t])
    for (const sel of [`.tier.t-${t} {`, `.sq.tier-${t} {`, `.sq.mini.tier-${t} {`, `.hsof button.t-${t} {`,
      `.chip.agents b.t-${t} {`, `.sq.prov-muse.desk.tier-${t} {`]) {
      assert.ok(css.includes(sel), `missing ${sel}`)
    }
  }
})

test('every provider-colour rule Antigravity has, Muse has too', () => {
  const kinds = ['.prov-X {', '.sq.prov-X.busy {', '.sq.prov-X.busy:not(.desk)', '.sq.prov-X.desk {',
    '.sq.prov-X.desk.proc-warm {', '.desk-body.prov-X {', '.tempdesk-panel.prov-X {', '.proc-state.active.prov-X {',
    '.cc-spin.prov-X {', '.eye-count.prov-X {', '.tab-count.prov-X {', '.mailbtn .count.prov-X {', '.badge.prov-X {',
    '.edge-jump.prov-X,', '.desk-nav-chip.prov-X {', '.tray-row.prov-X {', '.pinwin.prov-X,',
    '.pin-snap-preview.prov-X {', '.acct-provider-head.prov-X {', '.acct-provider-head.prov-X .acct-preview-tag {']
  for (const kind of kinds) {
    // the Antigravity rule proves the kind is real; the Muse one is the claim
    assert.ok(css.includes(kind.replaceAll('X', 'google')) || kind.includes('busy:not(.desk)'),
      `kind not found for Antigravity: ${kind}`)
    assert.ok(css.includes(kind.replaceAll('X', 'muse')), `missing Muse rule: ${kind.replaceAll('X', 'muse')}`)
  }
  // the organization agent-colour mode overrides Muse like the others
  assert.match(css, /agent-colors-organization[^{]*\.prov-muse\s*\{[^}]*--prov-muse:\s*var\(--org-accent\)/)
})
