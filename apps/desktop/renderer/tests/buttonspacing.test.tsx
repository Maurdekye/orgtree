// CSS constraints behind the geometry measured by buttonspacing_probe.py.
// These checks protect the rules; the browser probe measures real rectangles.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string
const shell = readFileSync(path.join(__SRC_DIR__, 'shell.css'), 'utf8')
const attention = readFileSync(path.join(__SRC_DIR__, 'attention/attention.css'), 'utf8')
const rule = (css: string, selector: string) => {
  const start = css.indexOf(selector + ' {')
  assert.ok(start >= 0, `missing ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}

test('adjacent header frames leave room for the badge overhang', () => {
  const gap = Number(rule(shell, '.shell-header-actions').match(/gap:\s*(\d+)px/)?.[1])
  const overhang = -Number(rule(shell, '.shell-header-actions > button > .eye-count')
    .match(/right:\s*(-?\d+)px/)?.[1])
  assert.ok(Number.isFinite(gap) && Number.isFinite(overhang))
  assert.ok(gap > overhang, `gap ${gap}px must exceed badge overhang ${overhang}px`)
})

test('the drawer and scrim begin after the complete agents rail', () => {
  const wrap = rule(attention, '.attn-agents-wrap')
  assert.match(wrap, /display:\s*grid;/)
  assert.match(wrap, /grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\);/)
  assert.match(rule(attention, '.attn-agents-bar'), /grid-area:\s*1\s*\/\s*1;/)
  for (const selector of ['.attn-agents', '.attn-agents-scrim', '.attn-desk']) {
    assert.match(rule(attention, selector), /grid-area:\s*1\s*\/\s*2;/, selector)
  }
  for (const selector of ['.attn-agents', '.attn-agents-scrim']) {
    assert.match(rule(attention, selector), /left:\s*0;/, selector)
  }
})
