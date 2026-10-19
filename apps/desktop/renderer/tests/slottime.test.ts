import test from 'node:test'
import assert from 'node:assert/strict'
import { slotTimeStyle as themedTimeStyle, slotEndedTimeStyle as themedEndedStyle } from '../src/canvas/slottime'
const slotTimeStyle = (seconds: number) => themedTimeStyle(seconds, 'dark')
const slotEndedTimeStyle = (seconds: number) => themedEndedStyle(seconds, 'dark')

const colours = ['#e6ffe0', '#4f9b1d', '#a6b51c', '#efa02a', '#e25a3b', '#ff4040']
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

test('light theme mirrors the scale with dark readable colours', () => {
  const light = ['#1b6b2a', '#2b8136', '#966900', '#bc5100', '#d60000']
  assert.equal(themedTimeStyle(0, 'light').color, '#1a1a1a')
  light.forEach((color, index) => assert.equal(themedTimeStyle(3*(86400/3)**(index/4), 'light').color, color))
  assert.equal(themedEndedStyle(0, 'light').color, '#1a1a1a')
  assert.equal(themedEndedStyle(86400, 'light').color, '#717171')
})

test('auto colours follow the surface colour scheme without a rerender or decoration', () => {
  for (const styleOf of [themedTimeStyle, themedEndedStyle]) {
    assert.deepEqual(styleOf(86400), {color:`light-dark(${styleOf(86400,'light').color}, ${styleOf(86400,'dark').color})`})
  }
})

test('all theme stops and sampled time colours meet 4.5 contrast on their surfaces', () => {
  const luminance = (hex:string) => {
    const c=hex.slice(1).match(/../g)!.map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
    return c[0]*.2126+c[1]*.7152+c[2]*.0722
  }
  for(const theme of ['dark','light'] as const){
    const bg=luminance(theme==='dark'?'#1f1f1f':'#f6f7f9'),count=theme==='dark'?5:4
    const samples=[0,1.5,...Array.from({length:count+1},(_,i)=>3*(86400/3)**(i/count)),...Array.from({length:101},(_,i)=>3*(86400/3)**(i/100))]
    for(const styleOf of [themedTimeStyle,themedEndedStyle])for(const seconds of samples){
      const fg=luminance(styleOf(seconds,theme).color)
      assert.ok((Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05)>=4.5,`${theme} ${seconds}s`)
    }
  }
})
