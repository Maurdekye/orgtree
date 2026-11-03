// appsrunedge.test.tsx — THE APPS LIST ROWS CARRY NO RUN-STATE MARKING
// (USER 2026-11-03 17:56:45Z m434296c947cf "at some point the styling for the apps list got messed up"; answered
// 18:07:57Z mc25f7c358e7b "No marking"): the Oct 31 24%/32% row fills made every app a heavy card. An app or
// panel row has no fill, no edge, no shadow for running/dead; the panel dot, CPU readout, the 4.5.0 group
// border and guide line, hover, +, gear and power are unchanged.
//
// Run:  node apps/desktop/renderer/tests/run.mjs appsrunedge
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

declare const __SRC_DIR__: string
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const apps = strip(readFileSync(joinPath(__SRC_DIR__, 'canvas/apps/apps.css'), 'utf8'))
const styles = strip(readFileSync(joinPath(__SRC_DIR__, 'styles.css'), 'utf8'))

test('no rule styles a run-on / run-dead Apps row at all', () => {
  for (const m of apps.matchAll(/([^{}]*)\{([^}]*)\}/g))
    assert.doesNotMatch(m[1]!, /\.run-(on|dead)/, 'a run-state rule on an Apps row: ' + m[1]!.trim().slice(0, 80))
  for (const m of styles.matchAll(/([^{}]*)\{([^}]*)\}/g))
    assert.doesNotMatch(m[1]!, /custom-apps-(menu-app|saved-row)[^,{]*\.run-/, 'a run-state rule on an Apps row in styles.css')
})

test('the dot, CPU readout, group border, guide line and hover are untouched', () => {
  assert.match(apps, /\.custom-app-dot\.running \{/)
  assert.match(apps, /\.custom-app-cpu \{/)
  assert.match(apps, /\.custom-apps-menu-group \{ border:1px solid var\(--line\)/)
  assert.match(apps, /\.custom-apps-menu-panels \{[^}]*border-left:2px solid var\(--line\)/)
  assert.match(apps, /\.custom-apps-menu-app:hover \{ background:var\(--panel-2\) \}/)
})
