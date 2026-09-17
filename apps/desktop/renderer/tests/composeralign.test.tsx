// The desk message box's VERTICAL arrangement (user 2026-09-17: "top-align the
// text entry instead of centering it vertically").
//
// ⚠ WHAT THIS FILE CAN AND CANNOT PROVE. It reads CSS text, so it pins the
// RULE; it cannot see a rendered box, and the bug it guards against was not a
// missing declaration but a geometry outcome — `align-items: flex-end` against
// a button column that had just become taller than an ungrown textarea. The
// measurement lives in `composer_align_probe.py`, which renders this same
// stylesheet in a real Chromium and asserts the gap above the first line is
// zero at every height the box takes. This file exists so the rule cannot be
// deleted silently by an edit that never runs that probe.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

declare const __SRC_DIR__: string

const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const rule = (selector: string) =>
  css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]+)\\}'))?.[1] ?? ''

test('the composer textarea opts out of the row baseline and starts at the top', () => {
  const textarea = rule('.cc-composer textarea')
  assert.ok(textarea, '.cc-composer textarea rule exists')
  assert.match(textarea, /align-self:\s*flex-start;/,
    'the textarea must align to the TOP of the composer, not ride its flex-end baseline')
  // Not `stretch`: `grow()` writes an explicit inline height and stretch does
  // nothing against a definite height, so the box would align one way before
  // the first grow and another way after.
  assert.doesNotMatch(textarea, /align-self:\s*stretch;/,
    'stretch is defeated by the inline height grow() writes')
  // and nothing about the text itself changed — the ticket moved the box, not
  // its typography or its ability to fill the row
  assert.match(textarea, /flex:\s*1;/)
  assert.match(textarea, /font-size:\s*14px;\s*line-height:\s*1\.4;/)
  assert.match(textarea, /padding:\s*0;/, 'a padding here would be a second, invisible top gap')
})

test('the CONTROLS still ride the composer baseline', () => {
  // This is the half that must NOT change: `align-items: flex-end` is what
  // lands the attach button, the notice toggle's column and the send button on
  // the composer's bottom edge. Only the textarea was excused from it.
  assert.match(rule('.cc-composer'), /align-items:\s*flex-end;/,
    'the composer keeps flex-end for its controls')
  assert.match(rule('.cc-composer'), /padding:\s*7px\s+9px;/, 'the composer padding is unchanged')
  const stack = rule('.cc-btnstack')
  assert.match(stack, /flex-direction:\s*column;/, 'the notice toggle still sits above attach')
  assert.match(stack, /flex:\s*none;/, 'and the column is never stretched by the row')
})

test('the comment above the composer describes the arrangement the code has', () => {
  // The stale-justification rule this codebase keeps: a comment that explains
  // behaviour the code no longer has is worse than no comment.
  const preamble = css.slice(Math.max(0, css.indexOf('.cc-composer {') - 900), css.indexOf('.cc-composer {'))
  assert.match(preamble, /align-items:\s*flex-end/,
    'the comment names the rule it is explaining')
  assert.match(preamble, /textarea/i, 'and says that the textarea opts out of it')
})
