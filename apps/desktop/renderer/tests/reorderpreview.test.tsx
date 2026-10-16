import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ReorderMarker, rowReorderSlot } from '../src/canvas/reorderpreview'
import { ringReorderSlot } from '../src/canvas/ringreorder'
import { NODE_H, NODE_W } from '../src/canvas/shared'
import type { Pt } from '../src/canvas/shared'

const row = new Map([['a', { x: 0, y: 100 }], ['b', { x: NODE_W + 60, y: 100 }]])
for (const [name, x, request, centre] of [
  ['first', -30, { before: 'a' }, -16],
  ['middle', NODE_W, { before: 'b' }, NODE_W + 30],
  ['last', 2 * NODE_W + 100, { after: 'b' }, 2 * NODE_W + 76],
] as const) test(`tree ${name} preview is a vertical card-height line in the insertion gap`, async () => {
  const slot = rowReorderSlot(['a', 'b'], row, { x, y: 100 })!
  assert.deepEqual(slot.request, request)
  const view = await mountView(<svg><ReorderMarker slot={slot} zoom={.5} /></svg>, el => el)
  try {
    const line = view.el.querySelector('line')!
    assert.equal(view.el.querySelector('circle'), null)
    assert.equal(Number(line.getAttribute('x1')), centre)
    assert.equal(line.getAttribute('x1'), line.getAttribute('x2'))
    assert.equal(Number(line.getAttribute('y2')) - Number(line.getAttribute('y1')), NODE_H)
    assert.equal(line.getAttribute('stroke'), 'var(--accent)')
    assert.equal(line.getAttribute('stroke-width'), '4')
    assert.equal(line.getAttribute('pointer-events'), 'none')
  } finally { await view.unmount() }
})

const eye: Pt = { x: 350, y: 350 }
const ring = new Map([['a', { x: 150, y: 350 }], ['b', { x: 350, y: 550 }], ['c', { x: 550, y: 350 }]])
const polar = (radius: number, angle: number): Pt => ({ x: eye.x - radius * Math.cos(angle), y: eye.y + radius * Math.sin(angle) })
for (const radius of [260, 490]) {
  // The occupied arc crosses atan2's seam and leaves most of the ring empty.
  // Unequal gaps ensure each end mirrors its OWN neighbouring separator.
  const angles = [2.9, 3.25, 3.7]
  const positions = new Map(['a', 'b', 'c'].map((id, i) => [id, polar(radius, angles[i]!)]))
  for (const end of ['first', 'last'] as const) test(`ring radius ${radius} ${end} marker mirrors the nearest occupied gap instead of the empty arc`, () => {
    const first = end === 'first'
    const anchor = angles[first ? 0 : 2]!
    const halfGap = first ? (angles[1]! - angles[0]!) / 2 : (angles[2]! - angles[1]!) / 2
    const expected = polar(radius, anchor + (first ? -halfGap : halfGap))
    const slot = ringReorderSlot(['a', 'b', 'c'], positions, eye, polar(radius, anchor + (first ? -.01 : .01)))!
    assert.deepEqual(slot.request, first ? { before: 'a' } : { after: 'c' }, 'committed drop order is unchanged')
    assert.ok(Math.hypot(slot.point.x - expected.x, slot.point.y - expected.y) < 1e-8,
      `${end} marker must mirror the between-agents gap at radius ${radius}: actual=${JSON.stringify(slot.point)}, expected=${JSON.stringify(expected)}`)
  })
  test(`ring radius ${radius} between-agent preview is unchanged`, () => {
    const slot = ringReorderSlot(['a', 'b', 'c'], positions, eye, polar(radius, 3.1))!
    assert.deepEqual(slot.request, { before: 'b' })
    const expected = polar(radius, (angles[0]! + angles[1]!) / 2)
    assert.ok(Math.hypot(slot.point.x - expected.x, slot.point.y - expected.y) < 1e-8)
  })
}
for (const [name, drop] of [['middle', { x: 250, y: 550 }], ['first', { x: 200, y: 250 }], ['last', { x: 500, y: 250 }]] as const) {
  test(`ring ${name} preview keeps angular request and is radial`, async () => {
    const slot = ringReorderSlot(['a', 'b', 'c'], ring, eye, drop)!
    const request = { ...slot.request }
    const view = await mountView(<svg><ReorderMarker slot={slot} eye={eye} zoom={2} /></svg>, el => el)
    try {
      const line = view.el.querySelector('line')!
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(key => Number(line.getAttribute(key))) as [number, number, number, number]
      assert.ok(Math.abs(Math.hypot(x2 - x1, y2 - y1) - NODE_H) < 1e-8)
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
      assert.ok(Math.abs((x2 - x1) * (cy - eye.y - NODE_H / 2) - (y2 - y1) * (cx - eye.x - NODE_W / 2)) < 1e-7)
      assert.deepEqual(slot.request, request)
      assert.equal(line.getAttribute('data-reorder-before'), 'before' in request ? request.before : null)
      assert.equal(line.getAttribute('data-reorder-after'), 'after' in request ? request.after : null)
    } finally { await view.unmount() }
  })
}
