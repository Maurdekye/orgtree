import test from 'node:test'
import assert from 'node:assert/strict'
import { slotTimeStyle } from '../src/canvas/slottime'

const stops = [[0, '#ffffff'], [3, '#b6ff00'], [30, '#4f9b1d'], [300, '#a6b51c'], [3000, '#efa02a'],
  [30000, '#df4b28'], [300000, '#32140f'], [3000000, '#000000']] as const
for (const [seconds, backgroundColor] of stops) {
  test(`slot time colour stop at ${seconds}s`, () => {
    assert.equal(slotTimeStyle(seconds).backgroundColor, backgroundColor)
  })
}
test('slot time scale interpolates at the logarithmic midpoint', () => {
  assert.equal(slotTimeStyle(Math.sqrt(30 * 300)).backgroundColor, '#7ba81d')
  assert.equal(slotTimeStyle(Math.sqrt(3 * 30)).backgroundColor, '#83cd0f')
})

test('slot time scale blends intermediate values on the log10 axis', () => {
  assert.equal(slotTimeStyle(10).backgroundColor, '#80cb0f')
  assert.equal(slotTimeStyle(100).backgroundColor, '#7ca91c')
  assert.equal(slotTimeStyle(1000).backgroundColor, '#ccaa23')
})

test('slot time scale blends linearly from white to lime over the first three seconds', () => {
  assert.equal(slotTimeStyle(1.5).backgroundColor, '#dbff80')
})
test('slot time scale clamps to its end colours', () => {
  assert.equal(slotTimeStyle(-5).backgroundColor, '#ffffff')
  assert.equal(slotTimeStyle(30000000).backgroundColor, '#000000')
  assert.equal(slotTimeStyle(Infinity).backgroundColor, '#000000')
})
test('every sampled time pill picks black or white text with at least 4.5 contrast', () => {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
  }
  for (const seconds of [0, 1, 10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000, 300000, 1000000, 3000000]) {
    const style = slotTimeStyle(seconds)
    assert.equal(['#000000', '#ffffff'].includes(style.color), true)
    const a = luminance(style.backgroundColor), b = luminance(style.color)
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `contrast at ${seconds}s`)
  }
})
