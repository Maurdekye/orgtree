import test from 'node:test'
import assert from 'node:assert/strict'
import { slotTimeStyle } from '../src/canvas/slottime'

const stops = [[0, '#ffffff'], [3, '#b6ff00'], [30, '#4f9b1d'], [300, '#a6b51c'], [3000, '#efa02a'],
  [30000, '#df4b28'], [300000, '#32140f'], [3000000, '#000000']] as const
for (const [seconds, color] of stops) {
  test(`slot time colour stop at ${seconds}s`, () => {
    assert.equal(slotTimeStyle(seconds).color, color)
  })
}
test('slot time scale interpolates at the logarithmic midpoint', () => {
  assert.equal(slotTimeStyle(Math.sqrt(30 * 300)).color, '#7ba81d')
  assert.equal(slotTimeStyle(Math.sqrt(3 * 30)).color, '#83cd0f')
})

test('slot time scale blends intermediate values on the log10 axis', () => {
  assert.equal(slotTimeStyle(10).color, '#80cb0f')
  assert.equal(slotTimeStyle(100).color, '#7ca91c')
  assert.equal(slotTimeStyle(1000).color, '#ccaa23')
})

test('slot time scale blends linearly from white to lime over the first three seconds', () => {
  assert.equal(slotTimeStyle(1.5).color, '#dbff80')
})
test('slot time scale clamps to its end colours', () => {
  assert.equal(slotTimeStyle(-5).color, '#ffffff')
  assert.equal(slotTimeStyle(30000000).color, '#000000')
  assert.equal(slotTimeStyle(Infinity).color, '#000000')
})
test('time styles apply the scale directly to text with no background', () => {
  assert.deepEqual(slotTimeStyle(30), { color: '#4f9b1d' })
  assert.deepEqual(slotTimeStyle(3000000), { color: '#000000' })
})