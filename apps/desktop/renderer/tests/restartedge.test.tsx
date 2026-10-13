// restartedge.test.tsx — the two restart cards are red on the LEFT EDGE only.
//
// User 2026-10-13: "the backend restarted and turn interrupted messages have
// red borders. when i requested that change i meant the left edge be styled
// with a red hue instead of the grey one it has currently, not the borders."
// The grey came from the passive-notice edge (`.event-notice`), which these
// cards usually wear and which repainted the left edge after the variant rule.
//
// Run:  node apps/desktop/renderer/tests/run.mjs restartedge
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { eventSurface } from '../src/events/card'
declare const __SRC_DIR__: string
const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
const fixture = (variant: string) => JSON.parse(readFileSync(path.join(__SRC_DIR__,
  '../tests/fixtures/events', variant + '.json'), 'utf8'))
const VARIANTS = ['runtime.restart_notice', 'context.drive_restart_interrupted']

test('positive control: a restart notice really wears the notice edge and its variant', () => {
  for (const variant of VARIANTS) {
    const surface = eventSurface({ kind: 'notice', ev: fixture(variant).private }, 'operator')
    assert.equal(surface['data-event-variant'], variant)
    assert.match(surface.className, /\bevent-surface\b/)
    assert.match(surface.className, /\bevent-notice\b/, 'the conflict this guards only exists on notices')
  }
})

test('no all-round border colour on either restart variant', () => {
  for (const variant of VARIANTS) {
    for (const rule of css.split('}').filter(r => r.includes(`[data-event-variant="${variant}"]`))) {
      assert.doesNotMatch(rule, /border-color\s*:/, `a whole-border colour on ${variant}: ${rule.trim()}`)
    }
  }
})

test('the red left edge comes after the notice edge and covers the user-side notice selector', () => {
  const notice = css.indexOf('.event-notice, .event-surface.event-notice, .msg.user.event-surface.event-notice {')
  assert.ok(notice > 0, 'the notice edge rule moved; re-check the cascade by hand')
  const edge = css.indexOf('border-left-color: var(--bad)', notice)
  assert.ok(edge > notice, 'no red left edge after the notice edge, so the notice grey wins')
  const selector = css.slice(css.lastIndexOf('*/', edge) + 2, edge)
  assert.match(selector, /\.msg\.user\.event-surface\.event-notice/,
    'the edge selector must be at least as specific as the strongest notice selector')
  for (const variant of VARIANTS) assert.ok(selector.includes(`[data-event-variant="${variant}"]`), variant)
})
