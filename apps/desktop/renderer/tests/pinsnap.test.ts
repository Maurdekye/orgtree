import test from 'node:test'
import assert from 'node:assert/strict'
import { findPinSnap, validPinSnap, isPinSnap } from '../src/canvas/pinSnap'
const vp = { w: 1400, h: 950 }
const target = { id: 'a', rect: { x: 450, y: 320, w: 320, h: 240 } }
const moving = { x: 780, y: 325, w: 320, h: 240 }

test('all four neighbour edges and aligned corners preserve dimensions', () => {
  for (const [edge, x, y, wantX, wantY] of [
    ['left', 120, 326, 130, 320], ['right', 780, 325, 770, 320],
    ['top', 455, 70, 450, 80], ['bottom', 455, 568, 450, 560],
  ] as const) {
    const result = findPinSnap('b', { ...moving, x, y }, [target], vp)!
    assert.ok(result)
    assert.equal(result.snap.edge, edge)
    assert.deepEqual(result.rect, { x: wantX, y: wantY, w: 320, h: 240 })
  }
})
test('viewport edges, corners, no self-snap, and agent named viewport', () => {
  assert.deepEqual(findPinSnap('b', { ...moving, x: 11, y: 6 }, [], vp)!.rect,
    { x: 0, y: 0, w: 320, h: 240 })
  assert.deepEqual(findPinSnap('b', { ...moving, x: 1075, y: 705 }, [], vp)!.rect,
    { x: 1080, y: 710, w: 320, h: 240 })
  assert.equal(findPinSnap('b', moving, [{ id: 'b', rect: target.rect }], vp), null)
  assert.equal(findPinSnap('b', moving, [{ ...target, id: 'viewport' }], vp)!.snap.target, 'viewport')
  assert.equal(findPinSnap('b', { ...moving, x: 10 }, [], vp)!.snap.target, null)
})
test('reject third-window collision, out-of-bounds snap, distant or diagonal window, unmeasured viewport', () => {
  assert.ok(findPinSnap('b', moving, [target], vp), 'positive control')
  assert.equal(findPinSnap('b', moving, [target, { id: 'c', rect: { x: 800, y: 350, w: 320, h: 240 } }], vp), null)
  assert.equal(findPinSnap('b', { ...moving, x: 0, y: 325 }, [{ ...target, rect: { ...target.rect, x: 310 } }], vp), null)
  assert.equal(findPinSnap('b', { ...moving, x: 800, y: 600 }, [target], vp), null)
  assert.equal(findPinSnap('b', moving, [target], null), null)
})
test('different heights align nearest ends, otherwise preserve perpendicular position', () => {
  assert.equal(findPinSnap('b', { ...moving, y: 360 }, [target], vp)!.rect.y, 360)
  const tall = { ...target, rect: { ...target.rect, h: 400 } }
  const result = findPinSnap('b', { ...moving, y: 475 }, [tall], vp)!
  assert.equal(result.rect.y, 480)
  assert.equal(result.snap.align, 'end')
})
test('equidistant choices are independent of input order or z order', () => {
  const targets = [{ id: 'a', rect: { x: 100, y: 100, w: 320, h: 240 } },
    { id: 'z', rect: { x: 740, y: 100, w: 320, h: 240 } }]
  const r = { x: 420, y: 100, w: 320, h: 240 }
  assert.equal(findPinSnap('b', r, targets, vp)!.snap.target, 'a')
  assert.deepEqual(findPinSnap('b', r, targets, vp), findPinSnap('b', r, targets.slice().reverse(), vp))
})
test('metadata validates targets, old malformed data and changed geometry without repositioning', () => {
  const r = findPinSnap('b', moving, [target], vp)!
  assert.deepEqual(validPinSnap('b', r.rect, r.snap, [target], vp), r.snap)
  assert.equal(validPinSnap('b', r.rect, r.snap, [], vp), null)
  assert.equal(validPinSnap('b', { ...r.rect, x: 900 }, r.snap, [target], vp), null)
  assert.equal(validPinSnap('b', r.rect, { target: 'b', edge: 'left' }, [target], vp), null)
  for (const bad of [null, {}, { to: 'a', edge: 'left' }, { target: null, edge: 'middle' }, { target: null, edge: 'left', align: 'what' }]) {
    assert.equal(isPinSnap(bad), false)
  }
  const screen = { target: null, edge: 'right' } as const
  assert.ok(validPinSnap('b', { ...moving, x: 1080 }, screen, [], vp))
  assert.equal(validPinSnap('b', moving, screen, [], vp), null)
})
