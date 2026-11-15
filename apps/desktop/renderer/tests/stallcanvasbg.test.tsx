// stallcanvasbg.test.tsx: every long-frame record says which canvas background
// was mounted and whether its WebGL canvas existed, so a real stall answers
// "was the background on?" by itself (@coordinator-opus md77d04632a31, item
// hang-every-time-a-new-desk-loads-especially-whil). Read from the DOM: what
// is mounted, not what the preference says.
// Run: node apps/desktop/renderer/tests/run.mjs stallcanvasbg
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { StallWatch } from '../src/stallwatch'
import type { StallEnv } from '../src/stallwatch'

const clock = 100_000
const run = (html: string) => {
  const sent: Array<Record<string, unknown>> = []
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  const env: StallEnv = { now: () => clock, wall: () => 1_700_000_000_000 + clock, send: r => { sent.push(r) }, doc: document,
    fetches: { open: () => [] }, commits: { count: () => 0 }, streamer: () => null }
  new StallWatch(env).onLoaf({ startTime: clock - 900, duration: 900, blockingDuration: 0, renderStart: clock - 40,
    styleAndLayoutStart: clock - 30, scripts: [] })
  host.remove()
  return sent[0]?.canvas_bg
}

test('the ascii layer with its WebGL canvas', () => {
  assert.deepEqual(run('<div class="canvas-bg-ascii" data-canvas-bg="ascii"><canvas></canvas></div>'), { theme: 'ascii', webgl: true })
})
test('the ascii layer before its renderer exists', () => {
  assert.deepEqual(run('<div class="canvas-bg-ascii" data-canvas-bg="ascii"></div>'), { theme: 'ascii', webgl: false })
})
test('a pattern theme, and the default dots (which carries no attribute)', () => {
  assert.deepEqual(run('<div class="canvas-bg" data-canvas-bg="hex-lines"></div>'), { theme: 'hex-lines', webgl: false })
  assert.deepEqual(run('<div class="canvas-bg"></div>'), { theme: 'dots', webgl: false })
})
test('no canvas on screen at all', () => {
  assert.deepEqual(run('<div class="settings"></div>'), { theme: 'none', webgl: false })
})
