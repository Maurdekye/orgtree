// desktablelayout.test.tsx — the CSS rules behind the project desk's history
// tables (Slots, the Mail tab's listeners, Listeners): one header style for
// all three (user 2026-10-20 08:59Z), and a layout that fits the desk at its
// normal widths, every shortened cell keeping its whole text in a tooltip
// (09:00Z). These checks protect the rules; the history capture
// (projectnode-visual.cjs, PROJECTNODE_VISUAL_ONLY=history) measures the
// real rectangles at 980, 890 and 740px.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs desktablelayout

import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule { selectors: string[]; body: string; at: string }
/** a selector list split at its top-level commas (not inside `:is(...)`) */
function selectorList(prelude: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < prelude.length; i++) {
    if (prelude[i] === '(') depth++
    else if (prelude[i] === ')') depth--
    else if (prelude[i] === ',' && depth === 0) { out.push(prelude.slice(start, i)); start = i + 1 }
  }
  out.push(prelude.slice(start))
  return out.map((s) => s.trim().replace(/\s+/g, ' '))
}
/** every style rule, with the at-rule it sits in ('' at the top level) */
function rules(src: string, at = ''): Rule[] {
  const out: Rule[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const prelude = src.slice(i, open).split(';').pop()!.trim()
    let depth = 1, j = open + 1
    for (; j < src.length && depth > 0; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') depth-- }
    const body = src.slice(open + 1, j - 1)
    if (prelude.startsWith('@')) out.push(...rules(body, prelude.replace(/\s+/g, ' ')))
    else out.push({ selectors: selectorList(prelude), body, at })
    i = j
  }
  return out
}
const all = rules(css)
const find = (selector: string, at = '') => all.filter((r) => r.at === at && r.selectors.includes(selector))
function one(selector: string, at = ''): Rule {
  const found = find(selector, at)
  assert.equal(found.length, 1, `exactly one rule for ${selector}${at ? ` in ${at}` : ''}`)
  return found[0]!
}
const decl = (r: Rule, prop: string) => r.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1]?.trim()
const px = (value?: string) => Number(value?.match(/^(\d+(?:\.\d+)?)px$/)?.[1] ?? NaN)

/** the hosts of the three tables, and the tables' own classes */
const HOST = /\.(project-slots|project-listeners|project-mail-listeners|mail-listeners-table|listeners-table)\b/
/** a selector that styles a column header row or a section heading */
const HEADER = /(^|[\s>+~])(thead|h4)\b|(^|[\s>+~])th\b(?![-\w])|\.slot-section\b/

test('the desk tables share ONE header style, set on the shared table (user 2026-10-20 08:59Z)', () => {
  const row = one('.slots-table thead th')
  for (const [prop, value] of [['color', 'var(--dim)'], ['font-size', '11px'], ['font-weight', '600'], ['border-bottom', '1px solid var(--line)']]) {
    assert.equal(decl(row, prop), value, `the column header row's ${prop}`)
  }
  const heading = one('.slots-table .slot-section h4')
  for (const [prop, value] of [['margin', '10px 0 2px'], ['font-size', '12px'], ['font-weight', '700'], ['color', 'var(--dim)']]) {
    assert.equal(decl(heading, prop), value, `a section heading's ${prop}`)
  }
  // the Mail tab's listeners had no heading rule and fell back to the
  // browser's h4; a host's own rule gives one table a look of its own
  const own = all.filter((r) => r.selectors.some((s) => HOST.test(s) && HEADER.test(s)))
  assert.deepEqual(own.map((r) => r.selectors.join(', ')), [], 'no host styles its table\'s header row or headings')
})

test('a desk table fits the desk at its normal widths; only below its floor does it scroll (user 2026-10-20 09:00Z)', () => {
  assert.ok(px(decl(one('.slots-table'), 'min-width')) <= 640, 'the shared floor')
  for (const selector of ['.slots-table.listeners-table', '.slots-table.mail-listeners-table', '.slots-table.mail-listeners-table.ack']) {
    for (const r of find(selector)) {
      const floor = decl(r, 'min-width')
      if (floor) assert.ok(px(floor) <= 680, `${selector} min-width ${floor}`)
    }
  }
  assert.equal(decl(one('.slots-table-scroll'), 'container-type'), 'inline-size', 'the table pane is a size container')
  const narrow = all.filter((r) => r.at.startsWith('@container') && r.selectors.includes('.slots-table .slot-col-agent'))
  assert.ok(narrow.length >= 1, 'the Agent column narrows with the pane')
  // the action buttons share the slots table's compact button, so take back fits its column too
  const button = one('.slots-table .slot-action > button')
  assert.equal(decl(button, 'font-size'), '11px')
  assert.equal(decl(button, 'white-space'), 'nowrap')
})

test('a shortened cell ends in an ellipsis on one line and keeps its whole text in a tooltip (user 2026-10-20 09:00Z)', () => {
  for (const selector of [
    '.slots-table .slot-agent .ref-agent',                     // an agent's name (its link's tooltip names it)
    '.slots-table .slot-agent .fired-by',                      // who fired an event, when no agent ("@user")
    '.slots-table .listener-dog-cell .watchdog-link-name',     // a watchdog's name, inside its chip
    '.mail-listeners-table .ending-word',                      // failed, taken back, dead letter
  ]) {
    const r = one(selector)
    assert.equal(decl(r, 'overflow'), 'hidden', `${selector} overflow`)
    assert.equal(decl(r, 'text-overflow'), 'ellipsis', `${selector} text-overflow`)
    assert.equal(decl(r, 'white-space'), 'nowrap', `${selector} white-space`)
  }
  const chip = one('.slots-table .listener-dog-cell .watchdog-link')
  assert.equal(decl(chip, 'max-width'), '100%', 'a chip never runs past its cell')
  assert.equal(decl(chip, 'box-sizing'), 'border-box')
  assert.equal(decl(one('.slots-table .listener-dog-cell .watchdog-link-name'), 'min-width'), '0', 'the name shrinks inside the chip')
})
