import test from 'node:test'
import assert from 'node:assert/strict'
import { slotTimeStyle } from '../src/canvas/slottime'

const colours = ['#b6ff00', '#4f9b1d', '#a6b51c', '#efa02a', '#df4b28', '#32140f', '#000000']
const atStop = (index: number) => 3 * (86400 / 3) ** (index / 6)
const stops: [number, string][] = [[0, '#ffffff'], ...colours.map((color, index): [number, string] => [atStop(index), color])]
for (const [seconds, color] of stops) {
  test(`slot time colour stop at ${seconds}s`, () => {
    assert.equal(slotTimeStyle(seconds).color, color)
  })
}
test('slot time scale interpolates at the logarithmic midpoint', () => {
  assert.equal(slotTimeStyle(Math.sqrt(atStop(1) * atStop(2))).color, '#7ba81d')
  assert.equal(slotTimeStyle(Math.sqrt(atStop(0) * atStop(1))).color, '#83cd0f')
})

test('slot time scale blends intermediate values on the rescaled logarithmic axis', () => {
  assert.equal(slotTimeStyle(10).color, '#6eb914')
  assert.equal(slotTimeStyle(100).color, '#aab41d')
  assert.equal(slotTimeStyle(1000).color, '#e97e29')
})

test('slot time scale blends linearly from white to lime over the first three seconds', () => {
  assert.equal(slotTimeStyle(1.5).color, '#dbff80')
})
test('slot time scale clamps to its end colours', () => {
  assert.equal(slotTimeStyle(-5).color, '#ffffff')
  assert.equal(slotTimeStyle(86400).color, '#000000')
  assert.equal(slotTimeStyle(86401).color, '#000000')
  assert.equal(slotTimeStyle(Infinity).color, '#000000')
})
test('time styles apply the scale directly to text with no background', () => {
  assert.deepEqual(slotTimeStyle(3), { color: '#b6ff00' })
  assert.deepEqual(slotTimeStyle(86400), { color: '#000000' })
})
