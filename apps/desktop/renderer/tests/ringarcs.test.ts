import test from 'node:test'
import assert from 'node:assert/strict'
import { ringArcCentres } from '../src/canvas/ringarcs'

const near = (actual: number[], expected: number[]) => {
  assert.equal(actual.length, expected.length)
  actual.forEach((a, i) => assert.ok(Math.abs(a - expected[i]!) < 1e-9, `${a} != ${expected[i]}`))
}
test('separate arcs keep their exact parent centres', () => {
  near(ringArcCentres([0, 2, 4], [3, 2, 1], .2), [0, 2, 4])
})
test('a collision moves only its touching block with minimum squared displacement', () => {
  near(ringArcCentres([0, .2, 3], [3, 3, 1], .2), [-.2, .4, 3])
  near(ringArcCentres([0, .2, .4, 3], [3, 3, 3, 1], .2), [-.4, .2, .8, 3])
})
test('last and first arcs collide across the seam without moving the remote middle arc', () => {
  const tau = Math.PI * 2
  near(ringArcCentres([0, 3, tau - .2], [3, 1, 3], .2), [.2, 3, tau - .4])
})
test('full circle has equally spaced nodes and the closest shared phase', () => {
  const step = 2 * Math.PI / 10, ideals = [0, 1, 5], sizes = [3, 5, 2]
  const centres = ringArcCentres(ideals, sizes, step)
  near([centres[1]! - centres[0]!, centres[2]! - centres[1]!], [4 * step, 3.5 * step])
  assert.ok(Math.abs(centres.reduce((sum, a, i) => sum + a - ideals[i]!, 0)) < 1e-9)
})
test('crowded cyclic projection is rotation and seam invariant with every gap satisfied', () => {
  // Deterministic uneven rings, including collisions propagating across the seam.
  let seed = 17
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32)
  for (let n = 2; n <= 60; n++) {
    const ideal = Array.from({ length: n }, () => random() * 2 * Math.PI).sort((a, b) => a - b)
    const sizes = ideal.map(() => 1 + Math.floor(random() * 8))
    const step = 2 * Math.PI / sizes.reduce((a, b) => a + b, 0) * .96
    const centres = ringArcCentres(ideal, sizes, step)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      assert.ok(centres[j]! + (j === 0 ? 2 * Math.PI : 0) - centres[i]! >= (sizes[i]! + sizes[j]!) * step / 2 - 1e-9)
    }
    near(ringArcCentres(ideal.map(a => a + .7), sizes, step), centres.map(a => a + .7))
    near(ringArcCentres([...ideal.slice(1), ideal[0]! + 2 * Math.PI], [...sizes.slice(1), sizes[0]!], step),
      [...centres.slice(1), centres[0]! + 2 * Math.PI])
  }
})
