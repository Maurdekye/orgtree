import test from 'node:test'
import assert from 'node:assert/strict'
import { slotTimeStyle, slotEndedTimeStyle } from '../src/canvas/slottime'

const colours = ['#e6ffe0', '#4f9b1d', '#a6b51c', '#efa02a', '#df4b28', '#ff4040']
const atStop = (index: number) => 3 * (86400 / 3) ** (index / 5)
const stops: [number, string][] = [[0, '#ffffff'], ...colours.map((color, index): [number, string] => [atStop(index), color])]
for (const [seconds, color] of stops) {
  test(`slot time colour stop at ${seconds}s`, () => {
    assert.equal(slotTimeStyle(seconds).color, color)
  })
}
test('slot time scale interpolates at the logarithmic midpoint', () => {
  assert.equal(slotTimeStyle(Math.sqrt(atStop(1) * atStop(2))).color, '#7ba81d')
  assert.equal(slotTimeStyle(Math.sqrt(atStop(0) * atStop(1))).color, '#9bcd7f')
})

test('slot time scale blends intermediate values on the rescaled logarithmic axis', () => {
  assert.equal(slotTimeStyle(10).color, '#8dc46e')
  assert.equal(slotTimeStyle(100).color, '#8dad1c')
  assert.equal(slotTimeStyle(1000).color, '#e2a428')
})

test('slot time scale blends linearly from white to lime over the first three seconds', () => {
  assert.equal(slotTimeStyle(1.5).color, '#f3fff0')
})
test('slot time scale clamps to its end colours', () => {
  assert.equal(slotTimeStyle(-5).color, '#ffffff')
  assert.equal(slotTimeStyle(86400).color, '#ff4040')
  assert.equal(slotTimeStyle(86401).color, '#ff4040')
  assert.equal(slotTimeStyle(Infinity).color, '#ff4040')
})
test('time styles apply the scale directly to text with no background', () => {
  assert.equal(slotTimeStyle(3).color, '#e6ffe0')
  assert.equal(slotTimeStyle(86400).color, '#ff4040')
  assert.equal('backgroundColor' in slotTimeStyle(3), false)
})

const greys = ['#ffffff', '#ebebeb', '#d6d6d6', '#c2c2c2', '#adadad', '#999999']
for (const [index, color] of greys.entries()) {
  test(`ended age greyscale at logarithmic stop ${index}`, () => {
    assert.equal(slotEndedTimeStyle(atStop(index)).color, color)
  })
}

test('ended age is white through three seconds and clamps to readable mid grey from twenty four hours', () => {
  for (const seconds of [-1, 0, 1.5, 3]) assert.equal(slotEndedTimeStyle(seconds).color, '#ffffff')
  for (const seconds of [86400, 86401, Infinity]) assert.equal(slotEndedTimeStyle(seconds).color, '#999999')
})

test('every duration and ended age is plain coloured text with no treatment', () => {
  for (const styleOf of [slotTimeStyle, slotEndedTimeStyle]) {
    for (const seconds of [0, 3, 2820, 14400, 86400, 86401]) {
      assert.deepEqual(Object.keys(styleOf(seconds)), ['color'])
    }
  }
})