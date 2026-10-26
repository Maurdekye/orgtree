// pinhandlesheader.test.tsx — A PINNED PANEL'S RESIZE HANDLES MUST NOT HANG
// OVER THE APP HEADER.
//
// The user's report (2026-10-01): with the Attention desk pinned flush against
// the top of the canvas, part of the header above it could not drag the window.
// MEASURED in a real Electron window (WM_NCHITTEST sampled down the header): the pinned panel's two top corner
// handles hung 16px above it, over the header, and each left a ~24px patch
// that is not a drag area. Hiding the handle frame removed the patch.
//
// jsdom has no layout and no native hit-testing, so this guards the CSS rule
// that caused it: no top handle may be offset above its panel.
import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const rule = (selector: string) => {
  const at = css.indexOf(selector + ' { ')
  assert.notEqual(at, -1, 'rule exists: ' + selector)
  return css.slice(at, css.indexOf('}', at))
}

for (const kind of ['modalpin', 'pinwin']) {
  for (const edge of ['n', 'ne', 'nw']) {
    test(`${kind} top handle ${edge} stays inside the panel's top edge`, () => {
      const body = rule(`.${kind}-rs.${edge}`)
      assert.match(body, /top:\s*0[;\s]/)
      assert.doesNotMatch(body, /top:\s*-/)
    })
  }
  test(`${kind} bottom and side handles keep their overhang`, () => {
    assert.match(css, new RegExp(`\.${kind}-rs\.se \{ bottom: -16px`))
    assert.match(css, new RegExp(`\.${kind}-rs\.sw \{ bottom: -16px`))
  })
}
