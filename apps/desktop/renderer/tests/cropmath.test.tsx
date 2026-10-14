import test from 'node:test'
import assert from 'node:assert/strict'
import { cropRect, rectCrop, moveCrop, resizeCrop, keyCrop, type Corner } from '../src/canvas/cropmath'

test('crop coordinates round trip in landscape, portrait and square images', () => {
  for (const [width, height] of [[400, 200], [200, 400], [300, 300]]) {
    const c = { x: .25, y: .75, size: .5 }
    assert.deepEqual(rectCrop(cropRect(c, width!, height!), width!, height!), c)
    assert.deepEqual(cropRect({ x: .5, y: .5, size: 1 }, width!, height!).side, Math.min(width!, height!))
  }
})
test('drag clamps both edges and resize holds the opposite corner at every handle', () => {
  const r = { left: 100, top: 50, side: 100 }, w = 400, h = 200
  assert.deepEqual(cropRect(moveCrop(r, -1000, 1000, w, h), w, h), { left: 0, top: 100, side: 100 })
  for (const corner of ['nw', 'ne', 'sw', 'se'] as Corner[]) {
    const west = corner.includes('w'), north = corner.includes('n')
    const next = cropRect(resizeCrop(r, corner, west ? -1000 : 1000, north ? -1000 : 1000, w, h), w, h)
    assert.ok(next.left >= 0 && next.top >= 0 && next.left + next.side <= w && next.top + next.side <= h)
    assert.equal(next.left + (west ? next.side : 0), r.left + (west ? r.side : 0))
    assert.equal(next.top + (north ? next.side : 0), r.top + (north ? r.side : 0))
    assert.equal(cropRect(resizeCrop(r, corner, west ? 1000 : -1000, north ? 1000 : -1000, w, h), w, h).side, 20)
  }
})
test('keyboard moves by one percent and resize remains centered, square and bounded', () => {
  const c = { x: .5, y: .5, size: .5 }, w = 400, h = 200
  assert.equal(cropRect(keyCrop(c, 'ArrowRight', false, w, h), w, h).left, 152)
  let next = c
  for (let n = 0; n < 200; n++) next = keyCrop(next, 'ArrowLeft', true, w, h)
  assert.equal(next.size, .1)
  for (let n = 0; n < 200; n++) next = keyCrop(next, 'ArrowRight', true, w, h)
  assert.ok(Math.abs(next.size - 1) < 1e-8)
  const result = cropRect(next, w, h)
  assert.ok(Math.abs(result.left - 100) < 1e-8 && Math.abs(result.top) < 1e-8 && Math.abs(result.side - 200) < 1e-8)
})
