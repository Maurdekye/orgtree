// selectinpage.test.ts — THE GUARD for "a dropdown's option list is drawn inside the window, never as an OS pop-up"
// (USER 2026-11-19 m6a2395ab50fb "Everywhere"; on the Steam Frame the OS pop-up took 0 of 20 controller clicks).
// The whole feature hangs on one CSS rule that covers every single-choice select without touching its call site, so
// nothing fails by itself when that rule is weakened, a select is written that the rule does not cover, a window is
// left without the keys, or a frame is left without the rule. This holds those four. That the browser really draws the
// list in the page is measured in a real window by selectinpage.capture.cjs.
import './harness'   // first: canvas/docs needs a document when it loads
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { frameThemeCss, FRAME_SELECT_CSS } from '../../../../packages/contracts/frame-theme'
import { presentationDocument } from '../src/canvas/docs'

declare const __SRC_DIR__: string

const files = (dir: string, keep: RegExp): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? (e.name === 'generated' ? [] : files(path.join(dir, e.name), keep)) : keep.test(e.name) ? [path.join(dir, e.name)] : [])
const rel = (file: string) => path.relative(__SRC_DIR__, file).replace(/\\/g, '/')
/** CSS with its comments removed, as `selector { declarations }` pairs (no at-rule nesting is needed for this check). */
const rules = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1]!.trim().replace(/\s+/g, ' '), body: m[2]! }))

const SINGLE = 'select:not([multiple]):not([size])'

test('one rule switches every single-choice select AND its list to the in-page list', () => {
  const sheet = rules(readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8'))
  const rule = sheet.find(r => /appearance:\s*base-select/.test(r.body))
  assert.ok(rule, 'styles.css has the base-select rule')
  const selectors = rule.selector.split(',').map(s => s.trim()).sort()
  assert.deepEqual(selectors, [SINGLE, `${SINGLE}::picker(select)`],
    'both halves, for every single-choice select: with only the select switched the browser keeps the OS pop-up')
})

test('no stylesheet gives a select another appearance', () => {
  const offenders: string[] = []
  for (const file of files(__SRC_DIR__, /\.css$/)) for (const r of rules(readFileSync(file, 'utf8'))) {
    if (!/(^|[\s,>+~(])select\b/.test(r.selector) || !/(^|[;\s])(-webkit-)?appearance\s*:/.test(r.body)) continue
    if (/appearance:\s*base-select/.test(r.body)) continue
    offenders.push(`${rel(file)}: ${r.selector}`)
  }
  assert.deepEqual(offenders, [], 'an `appearance` on a select brings the OS pop-up back for it')
})

test('every select in the renderer is one the rule covers; the list boxes are listed', () => {
  // A `multiple` or sized select is an in-page list box with no pop-up; each one is named here so a new one is a decision.
  const LIST_BOXES: Record<string, number> = { 'canvas/elicitation.tsx': 1 }
  const found: Record<string, number> = {}, problems: string[] = []
  let total = 0
  for (const file of files(__SRC_DIR__, /\.tsx?$/)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/<select\b/g)) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1
      if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue   // a comment that mentions the tag
      total++
      // the opening tag: up to the first `>` outside braces that does not belong to an arrow
      let depth = 0, end = m.index
      for (; end < text.length; end++) { const c = text[end]; if (c === '{') depth++; else if (c === '}') depth--; else if (c === '>' && depth === 0 && text[end - 1] !== '=') break }
      const tag = text.slice(m.index, end + 1)
      if (/\smultiple\b/.test(tag)) found[rel(file)] = (found[rel(file)] ?? 0) + 1
      if (/\ssize=/.test(tag)) problems.push(`${rel(file)}: a sized select is a list box; say so in LIST_BOXES and here`)
    }
    if (/createElement\(\s*['"`]select['"`]\s*\)/.test(text) && /\.(multiple|size)\s*=/.test(text)) problems.push(`${rel(file)}: a select built in plain DOM is made a list box`)
  }
  assert.deepEqual(problems, [])
  assert.deepEqual(found, LIST_BOXES, 'the list boxes are exactly the listed ones')
  assert.ok(total >= 60, `the scan found the selects (${total})`)
})

test('the keys are installed for the main window before React, and for each popped-out window before it shows anything', () => {
  const main = readFileSync(path.join(__SRC_DIR__, 'main.tsx'), 'utf8')
  const install = main.indexOf('installSelectKeys(window)'), render = main.indexOf('ReactDOM.createRoot')
  assert.ok(install > 0 && render > 0 && install < render, 'main.tsx installs them before the first render: the open list must be the first to see its own keys')
  const popout = readFileSync(path.join(__SRC_DIR__, 'popout.tsx'), 'utf8')
  const opened = popout.indexOf("d.write('<!doctype html>"), keys = popout.indexOf('installSelectKeys(w)'), mount = popout.indexOf("mount.className = 'popout-mount'")
  assert.ok(opened > 0 && keys > opened && keys < mount, 'popout.tsx installs them on the new window before the surface is mounted in it')
  assert.match(popout, /cleanups\.current\.push\(installSelectKeys\(w\)\)/, 'and removes them with the window')
})

test('presentations, app panels and presentation windows carry the rule in the sheet they already receive', () => {
  assert.match(FRAME_SELECT_CSS, /:where\(select:not\(\[multiple\]\):not\(\[size\]\)\)\s*,\s*:where\(select:not\(\[multiple\]\):not\(\[size\]\)\)::picker\(select\)\s*\{\s*appearance:\s*base-select/,
    'both halves, at zero specificity: a page that styles its own select keeps what it set')
  const css = frameThemeCss({ colorScheme: 'dark', colors: { accent: '#112233' } })
  assert.ok(css.startsWith(':where(:root){'), 'the colors still come first')
  assert.ok(css.endsWith(FRAME_SELECT_CSS), 'every frame sheet ends with the rule, so a theme switch keeps it')
  // the inline reader builds its frame from that sheet; app panels and the native viewer receive the same string
  const doc = presentationDocument('<!doctype html><select><option>a</option></select>', true, css)
  assert.ok(doc.includes('base-select'), 'the presentation frame carries it')
  const host = readFileSync(path.join(__SRC_DIR__, 'canvas', 'apps', 'host.tsx'), 'utf8')
  assert.match(host, /frameTheme\(\)/, 'app panels are built from the same sheet')
  const native = readFileSync(path.join(__SRC_DIR__, '..', '..', 'main', 'frametheme.ts'), 'utf8')
  assert.match(native, /frameThemeCss\(value\)/, 'and so is the native presentation window')
})
