// EPIC Mode — typing sparks land at the caret wherever its field is drawn
// (docket epic-mode-typing-effects-desync-in-canvas-desks; user report
// 2026-10-15 10:59Z: with EPIC Mode on, the typing effects fall out of sync in
// a desk on the canvas and stay in sync in a pinned one).
//
// A desk on the canvas sits inside the camera's `scale(view.z)` and
// `.desk-inner`'s counter-scale, so its composer's box on screen is scaled
// while the text, padding and scroll offsets inside it stay in the field's
// own px. Adding the unscaled text width to the scaled box ran the sparks
// ahead of the caret zoomed out and behind it zoomed in, further with every
// character. A pinned or popped-out desk is unscaled, which is why it was right.
//
// jsdom has no layout, so each field is given the geometry a transform gives
// it: getBoundingClientRect() scaled, offsetWidth/offsetHeight not. With no
// canvas (epicmode-fakes answers null) the director measures text at 7px a
// character. Real layout, real transforms and real keystrokes are checked in
// Electron by tools/rig/epic-mode-visual.mjs (the typing scene).
//
// A line that wraps at the field's edge (user report 2026-10-16: past a full
// line the sparks stayed at the end of the first) needs the browser's own
// layout: the director lays the text out in a hidden copy of the field, which
// jsdom cannot, so here it falls back to newlines alone. The wrapping is
// checked in Electron (the typing scene's narrow composers); here, only that
// the copy leaves nothing behind.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { startEpic } from '../src/epic/director'
import type { EpicShow, Kind } from '../src/epic/director'
import type { Spot } from '../src/epic/locate'
// a quiet canvas, and the app feed answered as a legacy engine
import './epicmode-fakes'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
/** the field's own geometry: its untransformed size and the line height */
const LEFT = 100, TOP = 200, W = 400, H = 40, LINE = 20, CHAR = 7

type Field = HTMLTextAreaElement | HTMLInputElement

/** a text field drawn at `scale` screen px per field px, the way a CSS
 *  transform draws it, scrolled by `scroll` (field px) */
function field(tag: 'textarea' | 'input', scale: number, scroll = { left: 0, top: 0 }): Field {
  const el = document.createElement(tag)
  el.style.cssText = `font-size: 14px; line-height: ${LINE}px; padding: 0; border: 0`
  document.body.append(el)
  const box = { left: LEFT, top: TOP, width: W * scale, height: H * scale }
  el.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width,
    bottom: box.top + box.height, toJSON: () => box }) as DOMRect
  Object.defineProperty(el, 'offsetWidth', { configurable: true, get: () => W })
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => H })
  Object.defineProperty(el, 'scrollLeft', { configurable: true, get: () => scroll.left })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => scroll.top })
  return el
}

/** every spot the show is cued at, in order */
function watch(show: EpicShow): { kind: Kind; spot: Spot }[] {
  const seen: { kind: Kind; spot: Spot }[] = []
  const cue = show.cue.bind(show)
  show.cue = (kind, ev = {}) => {
    if (ev.spot) seen.push({ kind, spot: ev.spot })
    cue(kind, ev)
  }
  return seen
}

/** one keystroke with the caret at the end of `value`: where its effect is cued */
async function press(run: { seen: { kind: Kind; spot: Spot }[] }, el: Field, value: string, key: string) {
  el.value = value
  el.setSelectionRange(value.length, value.length)
  const before = run.seen.length
  el.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key }))
  await wait(50)   // past the gap between two cues of one kind
  assert.equal(run.seen.length, before + 1, `one effect for ${key}`)
  return run.seen[run.seen.length - 1]!
}

const near = (got: Spot, x: number, y: number, what: string) => {
  assert.equal(Math.abs(got.x - x) < 0.01, true, `${what}: x ${got.x} should be ${x}`)
  assert.equal(Math.abs(got.y - y) < 0.01, true, `${what}: y ${got.y} should be ${y}`)
}

/** the composer of a desk drawn at `scale`: typing on the first and second
 *  line, Enter and Backspace all spark at the caret */
async function composerAt(scale: number) {
  const show = startEpic({ audio: null, greet: 'none' })
  const run = { seen: watch(show) }
  const el = field('textarea', scale)
  try {
    const first = await press(run, el, 'hello world', 'd')
    assert.equal(first.kind, 'type')
    near(first.spot, LEFT + 11 * CHAR * scale, TOP + LINE / 2 * scale, `typing on the first line at ${scale}`)
    const second = await press(run, el, 'hello\nworld!', 'x')
    near(second.spot, LEFT + 6 * CHAR * scale, TOP + 1.5 * LINE * scale, `typing on the second line at ${scale}`)
    const erase = await press(run, el, 'hello\nworld!', 'Backspace')
    assert.equal(erase.kind, 'erase')
    near(erase.spot, LEFT + 6 * CHAR * scale, TOP + 1.5 * LINE * scale, `erasing at ${scale}`)
    const enter = await press(run, el, 'hello wor', 'Enter')
    assert.equal(enter.kind, 'enter')
    near(enter.spot, LEFT + 9 * CHAR * scale, TOP + LINE / 2 * scale, `Enter at ${scale}`)
  } finally { el.remove(); show.stop() }
}

test('a desk on the canvas, zoomed out (half a screen px per field px): the sparks land at the caret', async () => {
  await composerAt(0.5)
})

test('a desk on the canvas, zoomed in (1.5 screen px per field px): the sparks land at the caret', async () => {
  await composerAt(1.5)
})

test('a pinned desk (unscaled): the sparks land at the caret, as they always did', async () => {
  await composerAt(1)
})

test('scrolled fields: the scroll is in the field\'s own px, so it scales with the text', async () => {
  const show = startEpic({ audio: null, greet: 'none' })
  const run = { seen: watch(show) }
  // a one-line field scrolled 30px sideways, zoomed in: the caret is 40 field
  // px in, at the middle of the box
  const input = field('input', 1.5, { left: 30, top: 0 })
  // a three-line textarea scrolled down a line, zoomed out
  const area = field('textarea', 0.5, { left: 0, top: LINE })
  try {
    const one = await press(run, input, 'abcdefghij', 'k')
    near(one.spot, LEFT + (10 * CHAR - 30) * 1.5, TOP + H * 1.5 / 2, 'the scrolled one-line field')
    const three = await press(run, area, 'one\ntwo\nthree', 's')
    near(three.spot, LEFT + 5 * CHAR * 0.5, TOP + (2.5 * LINE - LINE) * 0.5, 'the scrolled textarea')
  } finally { input.remove(); area.remove(); show.stop() }
})

test('placing the sparks leaves nothing in the document: no element, none of the draft', async () => {
  const show = startEpic({ audio: null, greet: 'none' })
  const run = { seen: watch(show) }
  const el = field('textarea', 1)
  // a content width, so the director does make its copy (jsdom lays nothing out)
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => W })
  const elements = () => [...document.body.children].filter(e => !e.matches('canvas.epic-stage')).length
  const before = elements()
  try {
    await press(run, el, 'a secret draft, long enough to wrap\nonto a second line', 'x')
    await press(run, el, 'a secret draft', 'Enter')
    await press(run, el, 'a secret draft', 'Backspace')
    assert.equal(elements(), before, 'no element left in the document')
    assert.equal((document.body.textContent ?? '').includes('secret'), false, 'no copy of the draft left in the document')
  } finally { el.remove(); show.stop() }
})
