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

test('resize snaps each moved edge to neighbours and preserves the opposite edge', () => {
  for (const [edge, r, expected] of [
    ['e', { x: 50, y: 350, w: 389, h: 260 }, { x: 50, y: 350, w: 400, h: 260 }],
    ['w', { x: 780, y: 350, w: 420, h: 260 }, { x: 770, y: 350, w: 430, h: 260 }],
    ['s', { x: 480, y: 30, w: 320, h: 280 }, { x: 480, y: 30, w: 320, h: 290 }],
    ['n', { x: 480, y: 570, w: 320, h: 300 }, { x: 480, y: 560, w: 320, h: 310 }],
  ] as const) {
    const result = findPinSnap('b', r, [target], vp, { edge, minWidth: 320, minHeight: 240 })
    assert.ok(result, `resize ${edge} finds the same neighbour as dragging`)
    assert.deepEqual(result.rect, expected)
    assert.ok(validPinSnap('b', result.rect, result.snap, [target], vp))
  }
})

test('resize snaps all screen edges and corners; only active edges move', () => {
  for (const [edge, r, expected] of [
    ['w', { x: 10, y: 50, w: 400, h: 300 }, { x: 0, y: 50, w: 410, h: 300 }],
    ['n', { x: 50, y: 10, w: 400, h: 300 }, { x: 50, y: 0, w: 400, h: 310 }],
    ['e', { x: 900, y: 50, w: 490, h: 300 }, { x: 900, y: 50, w: 500, h: 300 }],
    ['s', { x: 50, y: 500, w: 400, h: 440 }, { x: 50, y: 500, w: 400, h: 450 }],
    ['nw', { x: 10, y: 8, w: 400, h: 300 }, { x: 0, y: 0, w: 410, h: 308 }],
    ['ne', { x: 900, y: 8, w: 490, h: 300 }, { x: 900, y: 0, w: 500, h: 308 }],
    ['sw', { x: 10, y: 500, w: 400, h: 440 }, { x: 0, y: 500, w: 410, h: 450 }],
    ['se', { x: 900, y: 500, w: 490, h: 440 }, { x: 900, y: 500, w: 500, h: 450 }],
  ] as const) {
    assert.deepEqual(findPinSnap('b', r, [], vp,
      { edge, minWidth: 320, minHeight: 240 })?.rect, expected, edge)
  }
  const nearLeft = { x: 10, y: 50, w: 400, h: 300 }
  assert.equal(findPinSnap('b', nearLeft, [], vp,
    { edge: 'e', minWidth: 320, minHeight: 240 }), null, 'a stationary west edge must not snap')
})

test('resize reuses thresholds, corner alignment, collision and minimum-size rules', () => {
  const resize = { edge: 'ne', minWidth: 320, minHeight: 240 }
  const r = { x: 50, y: 325, w: 389, h: 300 }
  assert.deepEqual(findPinSnap('b', r, [target], vp, resize)?.rect,
    { x: 50, y: 320, w: 400, h: 305 }, 'corner aligns by resizing, without moving south/west')
  assert.deepEqual(findPinSnap('b', r, [target], vp, { ...resize, edge: 'e' })?.rect,
    { x: 50, y: 325, w: 400, h: 300 }, 'single-edge resize cannot align a stationary corner')
  assert.equal(findPinSnap('b', { ...r, w: 370 }, [target], vp, resize), null, 'same 20px threshold')
  assert.equal(findPinSnap('b', r, [target], vp, { ...resize, minWidth: 410 }), null, 'never snap below minimum')
  assert.equal(findPinSnap('b', r, [target, { id: 'c', rect: { x: 300, y: 500, w: 320, h: 240 } }], vp, resize),
    null, 'never snap through a third window')
  assert.equal(findPinSnap('b', r, [target], null, resize), null, 'unmeasured viewport remains unsnappable')
})
