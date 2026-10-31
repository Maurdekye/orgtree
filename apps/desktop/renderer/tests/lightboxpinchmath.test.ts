// The port of Hubchat's pinchmath (src/canvas/pinchmath.ts): the same cases as Hubchat's tools/pinchmath.test.ts,
// so a drift between the two copies shows here. Run:  node apps/desktop/renderer/tests/run.mjs lightboxpinchmath
import test from 'node:test'
import assert from 'node:assert/strict'
import { HOME, MAX_SCALE, clampView, panView, pinchView, resetPageZoom, toggleZoom, wheelView, type ZoomDoc } from '../src/canvas/pinchmath'

const IMG = { w: 300, h: 200 }

test('a pinch scales the picture about the fingers and keeps the point under them', () => {
  const v = pinchView(HOME, { x: -10, y: 0 }, { x: 10, y: 0 }, { x: -20, y: 0 }, { x: 20, y: 0 }, IMG)
  assert.equal(v.scale, 2)
  assert.equal(v.x, 0)
  const off = pinchView(HOME, { x: 40, y: 0 }, { x: 60, y: 0 }, { x: 30, y: 0 }, { x: 70, y: 0 }, IMG)
  assert.equal(off.scale, 2)
  assert.equal(off.x, 50 - (50 - 0) * 2, 'the point at x=50 stays at x=50')
})

test('the scale never leaves 1..MAX and a picture at 1 cannot be panned', () => {
  assert.equal(pinchView(HOME, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 1000, y: 0 }, IMG).scale, MAX_SCALE)
  assert.equal(pinchView({ scale: 2, x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, IMG).scale, 1)
  assert.deepEqual(panView(HOME, 50, 50, IMG), HOME)
})

test('a zoomed picture pans only until its edge meets the box', () => {
  const v = panView({ scale: 2, x: 0, y: 0 }, 999, -999, IMG)
  assert.deepEqual(v, { scale: 2, x: 150, y: -100 })
  assert.deepEqual(clampView({ scale: 1, x: 40, y: 40 }, IMG), HOME)
})

test('double tap toggles between fit and 2.5x, wheel zooms about the pointer', () => {
  assert.equal(toggleZoom(HOME, { x: 0, y: 0 }, IMG).scale, 2.5)
  assert.deepEqual(toggleZoom({ scale: 3, x: 10, y: 10 }, { x: 0, y: 0 }, IMG), HOME)
  assert.ok(wheelView(HOME, -300, { x: 0, y: 0 }, IMG).scale > 1)
  assert.equal(wheelView(HOME, 300, { x: 0, y: 0 }, IMG).scale, 1)
})

const fakeDoc = (content: string) => {
  const attrs = new Map([['content', content]])
  const frames: (() => void)[] = []
  const meta = { getAttribute: (n: string) => attrs.get(n) ?? null, setAttribute: (n: string, v: string) => { attrs.set(n, v) } }
  const doc: ZoomDoc = {
    querySelector: () => meta,
    defaultView: { requestAnimationFrame: (cb) => frames.push(cb), setTimeout: (cb) => frames.push(cb) },
  }
  return { doc, attrs, frames }
}

test('resetPageZoom pins the viewport scale to 1, then restores the original content', () => {
  const orig = 'width=device-width, initial-scale=1.0, viewport-fit=cover'
  const { doc, attrs, frames } = fakeDoc(orig)
  assert.equal(resetPageZoom(doc), true)
  assert.match(attrs.get('content')!, /minimum-scale=1, maximum-scale=1$/)
  assert.match(attrs.get('content')!, /initial-scale=1\.0/)
  while (frames.length) frames.shift()!()
  assert.equal(attrs.get('content'), orig, 'restored after two frames')
})

test('resetPageZoom without a viewport meta does nothing', () => {
  const doc: ZoomDoc = { querySelector: () => null, defaultView: null }
  assert.equal(resetPageZoom(doc), false)
})

test('a reset inside another restores the original content once, at the end', () => {
  const orig = 'width=device-width, initial-scale=1.0'
  const { doc, attrs, frames } = fakeDoc(orig)
  resetPageZoom(doc)
  resetPageZoom(doc)
  assert.match(attrs.get('content')!, /maximum-scale=1$/)
  let guard = 0
  while (frames.length && guard++ < 20) frames.shift()!()
  assert.equal(attrs.get('content'), orig, 'never left pinned, never saved as the pinned value')
})
