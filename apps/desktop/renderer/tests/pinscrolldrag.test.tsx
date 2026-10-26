// pinscrolldrag.test.tsx — CONTENT SCROLLED OUT OF A PINNED PANEL MUST NOT
// BLOCK THE WINDOW'S TITLE BAR.
//
// The user's report (2026-10-01, still there in 3.0.8 after the resize-handle
// fix): with the Attention desk pinned flush to the top of the canvas, the part
// of the header above it would not drag the window.
// MEASURED in a real Electron 44 window (WM_NCHITTEST down the header,
// tests/pinscrolldrag_electron_probe.cjs): `-webkit-app-region` is INHERITED,
// and Electron counts every element carrying it at its full box, ignoring
// scrolling and overflow clipping. The canvas `.viewport` is no-drag, the pin
// layer sits inside it, so every row of a pinned desk's transcript inherited
// no-drag — and the rows scrolled away above the panel lay over the header.
// With the desk scrolled, the header above the panel was all HTCLIENT; with
// descendants reset to `initial` it is HTCAPTION again. `unset` (inherits) and
// `none` were measured NOT to stop it.
//
// jsdom has no layout and no native hit-testing, so this guards the CSS.
import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => ({ selectors: m[1]!.split(',').map(s => s.trim()), body: m[2]! }))
const region = (body: string) => /-webkit-app-region:\s*([\w-]+)/.exec(body)?.[1] ?? null

test('everything inside the canvas viewport goes back to the initial app region', () => {
  const reset = rules.filter(r => r.selectors.includes('.canvas-stage > .viewport *'))
  assert.equal(reset.length, 1)
  assert.equal(region(reset[0]!.body), 'initial')
  // the viewport's own box still keeps the canvas out of the drag region
  const own = rules.filter(r => r.selectors.includes('.canvas-stage > .viewport'))
  assert.ok(own.some(r => region(r.body) === 'no-drag'))
})

test('a pinned panel is no-drag by its own box, never by its descendants', () => {
  const panel = rules.filter(r => r.selectors.includes('.overlay.overlay-pinned .modalpin-win'))
  assert.ok(panel.some(r => region(r.body) === 'no-drag'))
  for (const r of rules) for (const s of r.selectors) {
    if (/(modalpin-win|pinwin|attn-|pin-layer|viewport)\b.*\s\*$/.test(s) && s !== '.canvas-stage > .viewport *') {
      assert.equal(region(r.body), null, `${s} must not set an app region: ${r.body.trim()}`)
    }
  }
})

test('no rule re-inherits an app region with unset/inherit/none', () => {
  for (const r of rules) {
    const v = region(r.body)
    assert.ok(v === null || ['drag', 'no-drag', 'initial'].includes(v),
      `${r.selectors.join(', ')} uses -webkit-app-region: ${v}`)
  }
})
