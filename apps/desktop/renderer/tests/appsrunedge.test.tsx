// appsrunedge.test.tsx — THE APPS LIST'S RUN STATE IS THE LINKS' LEFT EDGE, NOT A FILL
// (USER 2026-11-03 17:56:45Z m434296c947cf "at some point the styling for the apps list got messed up";
// coordinator decision m... : the Oct 31 24%/32% row fills made every app a heavy filled card. The
// @app:/@panel: links already wear a narrow left edge for the same states (m4c09dab3ee56 "Left edge like unread"),
// so the Apps list rows take that edge: the same 3px inset, the same --ref-flare-color token, rows otherwise
// transparent. The 4.5.0 group border and guide line, hover, +, gear and power are unchanged.
//
// Run:  node apps/desktop/renderer/tests/run.mjs appsrunedge
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

declare const __SRC_DIR__: string
const apps = readFileSync(joinPath(__SRC_DIR__, 'canvas/apps/apps.css'), 'utf8')
const styles = readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8')
const blockOf = (css: string, sel: string) => {
  const at = css.indexOf(sel); assert.ok(at >= 0, sel + ' exists')
  return css.slice(at, css.indexOf('}', at))
}

test('a running / dead Apps row draws the 3px left edge and no background fill', () => {
  for (const sel of ['.custom-apps-menu-app.run-on', '.custom-apps-menu-app.run-dead']) {
    const rule = [...apps.matchAll(/([^{}]*)\{([^}]*)\}/g)].find(m => m[1]!.includes(sel) && !m[1]!.includes(':hover'))
    assert.ok(rule, sel + ' has a rule')
    assert.match(rule![2]!, /box-shadow:\s*inset 3px 0 0 var\(--ref-flare-color\)/, sel + ' wears the links\' edge')
    assert.doesNotMatch(rule![2]!, /background/, sel + ' is not filled')
  }
  const panels = [...apps.matchAll(/([^{}]*)\{([^}]*)\}/g)].find(m => m[1]!.includes('.custom-apps-saved-row.run-on'))
  assert.ok(panels && /inset 3px 0 0 var\(--ref-flare-color\)/.test(panels[2]!) && !/background/.test(panels[2]!))
})

test('the edge colours are the links\' own tokens, defined once', () => {
  const on = blockOf(styles, '.ref-flare.run-on')
  assert.match(on, /custom-apps-menu-app\.run-on/, 'the Apps rows share the link\'s running token rule')
  assert.match(on, /custom-apps-saved-row\.run-on/)
  const dead = blockOf(styles, '.ref-flare.run-dead')
  assert.match(dead, /custom-apps-menu-app\.run-dead/)
  assert.match(dead, /custom-apps-saved-row\.run-dead/)
  assert.doesNotMatch(apps, /--ref-flare-color:/, 'no second copy of the colours in apps.css')
})

test('the group border, guide line and hover are untouched', () => {
  assert.match(apps, /\.custom-apps-menu-group \{ border:1px solid var\(--line\)/)
  assert.match(apps, /\.custom-apps-menu-panels \{[^}]*border-left:2px solid var\(--line\)/)
  assert.match(apps, /\.custom-apps-menu-app:hover \{ background:var\(--panel-2\) \}/)
})
