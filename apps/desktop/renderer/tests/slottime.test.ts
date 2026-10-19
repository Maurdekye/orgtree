import test from 'node:test'
import assert from 'node:assert/strict'
import { slotTimeStyle, slotEndedTimeStyle } from '../src/canvas/slottime'

const colours = ['#e6ffe0', '#4f9b1d', '#a6b51c', '#efa02a', '#df4b28', '#32140f', '#000000']
const atStop = (index: number) => 3 * (86400 / 3) ** (index / 6)
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
  assert.equal(slotTimeStyle(10).color, '#7cb957')
  assert.equal(slotTimeStyle(100).color, '#aab41d')
  assert.equal(slotTimeStyle(1000).color, '#e97e29')
})

test('slot time scale blends linearly from white to lime over the first three seconds', () => {
  assert.equal(slotTimeStyle(1.5).color, '#f3fff0')
})
test('slot time scale clamps to its end colours', () => {
  assert.equal(slotTimeStyle(-5).color, '#ffffff')
  assert.equal(slotTimeStyle(86400).color, '#000000')
  assert.equal(slotTimeStyle(86401).color, '#000000')
  assert.equal(slotTimeStyle(Infinity).color, '#000000')
})
test('time styles apply the scale directly to text with no background', () => {
  assert.equal(slotTimeStyle(3).color, '#e6ffe0')
  assert.equal(slotTimeStyle(86400).color, '#000000')
  assert.equal('backgroundColor' in slotTimeStyle(3), false)
})

const greys = ['#ffffff', '#dedede', '#bdbdbd', '#9d9d9d', '#7c7c7c', '#5b5b5b', '#3a3a3a']
for (const [index, color] of greys.entries()) {
  test(`ended age greyscale at logarithmic stop ${index}`, () => {
    assert.equal(slotEndedTimeStyle(atStop(index)).color, color)
  })
}

test('ended age is white through three seconds and clamps to dark grey from twenty four hours', () => {
  for (const seconds of [-1, 0, 1.5, 3]) assert.equal(slotEndedTimeStyle(seconds).color, '#ffffff')
  for (const seconds of [86400, 86401, Infinity]) assert.equal(slotEndedTimeStyle(seconds).color, '#3a3a3a')
})

test('both shared time scales have thin black or white outlines contrasting with their text', () => {
  const luminance = (hex: string) => {
    const c = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722
  }
  for (const styleOf of [slotTimeStyle, slotEndedTimeStyle]) {
    for (const seconds of [0, 1.5, ...colours.map((_, i) => atStop(i)), 100, 1000, 86401]) {
      const style = styleOf(seconds)
      const outline = luminance(style.color) >= .179 ? '#000000' : '#ffffff'
      assert.equal(style.textShadow, `-0.5px 0 ${outline}, 0.5px 0 ${outline}, 0 -0.5px ${outline}, 0 0.5px ${outline}`)
      assert.equal('backgroundColor' in style, false)
    }
  }
})
