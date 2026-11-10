// UI 720p fix D (audit problems 3, 7 and 8, 2026-11-09): three boxes that let
// their content out. jsdom lays nothing out, so each test reads the rule that
// decides it from the sheet, as headerlayout.test.tsx does.
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string

const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** the declarations of every top-level rule whose selector list is exactly `selector` */
function rule(selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  // the lookbehind leaves each rule's closing brace for the next match
  const re = /(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g
  let found = false
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (m[1]!.replace(/\s+/g, ' ').trim() !== selector) continue
    found = true
    for (const decl of m[2]!.split(';')) {
      const i = decl.indexOf(':')
      if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
    }
  }
  assert.ok(found, `the sheet has a rule for ${selector}`)
  return out
}

test('§1 the settings tab strip wraps onto more rows, so every tab name shows at every width', () => {
  const strip = rule('.app-settings-tabs')
  assert.equal(strip['flex-wrap'], 'wrap', 'tabs that do not fit go to the next row')
  assert.ok(!/auto|scroll/.test(strip['overflow-x'] ?? ''), 'no sideways scroll that hides the last tabs')
  assert.ok(!/hidden/.test(strip['overflow'] ?? '') && !/hidden/.test(strip['overflow-y'] ?? ''),
    'a second row is not clipped away')
  assert.equal(strip['flex'], 'none', 'the strip keeps its full height in the panel column')
  const tab = rule('.settings .app-settings-tab')
  assert.equal(tab['white-space'], 'nowrap', 'each tab title still stays on one line (user 2026-09-29)')
})

test('§2 the chosen-models box grows with its wrapped rows of chips', () => {
  // the picker is a fixed-height column: a box with an explicit min-height
  // shrinks to it, and its second row of chips hangs over the search field
  const box = rule('.orr-selected')
  assert.equal(box['flex-wrap'], 'wrap')
  assert.ok(box['flex'] === 'none' || box['flex-shrink'] === '0', 'the box never shrinks below its chips')
})

test('§3 a long version shortens with an ellipsis and the header icons stay in the card', () => {
  const badge = rule('.build-badge')
  assert.equal(badge['overflow'], 'hidden')
  assert.equal(badge['text-overflow'], 'ellipsis')
  assert.equal(badge['white-space'], 'nowrap')
  assert.equal(badge['min-width'], '0', 'the badge may shrink below its text')
  const h1 = rule('aside h1, .welcome-card h1')
  assert.equal(h1['min-width'], '0', 'the header itself stays inside the card or drawer')
  for (const icon of ['.h1-gh', '.h1-usage']) {
    const r = rule(icon)
    assert.ok(r['flex'] === 'none' || r['flex-shrink'] === '0', `${icon} keeps its size`)
  }
})

test('§3 the full version stays in the badge tooltip', () => {
  const app = readFileSync(path.join(__SRC_DIR__, 'App.tsx'), 'utf8')
  const badge = app.slice(app.indexOf('export function TitleBadge'))
  assert.match(badge.slice(0, 900), /title=\{`running app version \$\{appVersion\}`/)
})

// Agent settings at low resolutions (USER 2026-11-10 m0e04507d8287 "All, rows into tab")

test('§4 History and Activity keep a floor, so the whole panel scrolls instead of squeezing them', () => {
  const tab = rule('.settings.cfg > .agent-history-tab')
  const floor = parseFloat(tab['min-height'] ?? '0')
  assert.ok(floor >= 300, `a floor of at least 300px (now ${tab['min-height']})`)
  assert.match(tab['flex'] ?? '', /^1 1 0(px|%)?$/, 'it still fills a tall panel, from a zero basis')
})

test('§5 on a short screen a settings window uses nearly the full height', () => {
  assert.match(css, /\}\s*\.settings\s*\{[^}]*height:\s*88vh/, 'a tall screen keeps 88% (the top-level rule)')
  assert.match(css, /@media \(max-height:\s*900px\)\s*\{\s*\.settings\s*\{[^}]*height:\s*calc\(100vh - 32px\)/,
    'below 900px of height it leaves only a 16px margin above and below')
})
