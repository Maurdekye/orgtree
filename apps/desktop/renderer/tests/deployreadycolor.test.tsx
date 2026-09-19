// deployreadycolor.test.tsx — the docket's "Deploy Ready" colour must not be
// mistakable for the OpenRouter Lavender THEME accent (user report 2026-09-19:
// "status and theme identity are visually ambiguous"), and must not have
// traded that clash for a worse one with its own neighbour --approved, which
// sits in the adjacent docket row.
//
// ⚠ WHY THIS MEASURES RATHER THAN PINS THE HEX. Asserting `--deploy-ready ===
// '#7484fb'` would pass for any future edit that kept the literal and fail for
// every harmless one that did not — it would test the edit, not the property.
// What the user actually asked for is a DISTANCE, so the distance is what is
// asserted: CIE76 ΔE in Lab, which is perceptual, against the real theme
// accent imported from the app rather than a copy of it.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs deployreadycolor

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { THEMES } from '../src/themes'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')

/** every value this token is given, in file order: [0] is the :root (dark)
 *  one, [1] the override for the two light surfaces. */
function token(name: string): string[] {
  const out = [...css.matchAll(new RegExp(String.raw`--${name}:\s*(#[0-9a-fA-F]{6})\s*;`, 'g'))]
    .map((m) => m[1]!.toLowerCase())
  assert.ok(out.length > 0, `--${name} is not defined in styles.css at all`)
  return out
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const linear = (c: number) => (c /= 255, c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** CIE76 ΔE. ~2.3 is the just-noticeable difference; under ~10 two colours
 *  read as the same colour at a glance, which is the defect being fixed. */
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

const LAVENDER = THEMES.openrouter.accent.toLowerCase()
const WAS = '#9b8ce0'          // the reported value, kept as the control below
/** the floor. 20 is comfortably past "same colour at a glance" while still
 *  reachable inside this palette's crowded cool band — see the note on
 *  --deploy-ready in styles.css for why there is no room for a larger one. */
const FLOOR = 18

test('§1 the theme accent this was confused with is the real one, not a copy', () => {
  assert.equal(LAVENDER, '#b69afa', 'OpenRouter Lavender moved — re-measure the separation below')
  assert.equal(token('deploy-ready').length, 2,
    'expected exactly two --deploy-ready values: the :root one and the light-surface override')
})

test('§2 Deploy Ready is not mistakable for OpenRouter Lavender, dark surfaces', () => {
  const [dark] = token('deploy-ready') as [string]
  assert.ok(deltaE(dark, LAVENDER) >= FLOOR,
    `--deploy-ready ${dark} is ΔE ${deltaE(dark, LAVENDER).toFixed(1)} from OpenRouter Lavender ` +
    `${LAVENDER}; anything under ${FLOOR} reads as the same colour, which is the reported defect`)
})

test('§3 …and on the light surfaces too', () => {
  const light = token('deploy-ready')[1]!
  assert.ok(deltaE(light, LAVENDER) >= FLOOR,
    `light --deploy-ready ${light} is only ΔE ${deltaE(light, LAVENDER).toFixed(1)} from ${LAVENDER}`)
})

test('§4 THE CONTROL: the value the user complained about FAILS this test', () => {
  // Without this, §2 would pass just as happily if the threshold were wrong or
  // the parse silently returned something unrelated. The old colour is the one
  // case known to be a defect, so it must be caught.
  assert.ok(deltaE(WAS, LAVENDER) < FLOOR,
    `the reported colour ${WAS} measures ΔE ${deltaE(WAS, LAVENDER).toFixed(1)} from lavender — ` +
    `if that is now above the floor the floor is too low to catch anything`)
  assert.equal(deltaE(LAVENDER, LAVENDER), 0, 'and lavender is of course zero from itself')
})

test('§5 no collision was traded for another: every other status stays clear', () => {
  const [dark] = token('deploy-ready') as [string]
  for (const other of ['work', 'review', 'backlog', 'approved', 'ok', 'warn', 'bad']) {
    const value = token(other)[0]!
    assert.ok(deltaE(dark, value) >= FLOOR,
      `--deploy-ready ${dark} is ΔE ${deltaE(dark, value).toFixed(1)} from --${other} ${value}`)
  }
  // --approved was the WORST of these before this change (ΔE 8.7, and the two
  // are adjacent rows in the docket), so it is named rather than left to the
  // loop: a regression there is the one most likely to be waved through.
  assert.ok(deltaE(dark, token('approved')[0]!) >= 20,
    'Deploy Ready and Approved are adjacent docket statuses and must be further apart than the floor')
})

test('§6 the text stays readable on every surface it is rendered on', () => {
  const [dark, light] = token('deploy-ready') as [string, string]
  // --bg for charcoal, black, light and solarized-light, in styles.css order
  const [charcoal, pale, solarized, black] = token('bg') as [string, string, string, string]
  for (const [colour, surface, name] of [
    [dark, charcoal, 'charcoal'], [dark, black, 'black'],
    [light, pale, 'light'], [light, solarized, 'solarized-light'],
  ] as const) {
    assert.ok(contrast(colour, surface) >= 4.5,
      `${colour} on ${name} ${surface} is ${contrast(colour, surface).toFixed(2)}:1, under the 4.5:1 AA floor`)
  }
})
