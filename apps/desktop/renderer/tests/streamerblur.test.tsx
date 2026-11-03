// Streamer mode BLURS masked values in place (USER 2026-11-03 m4f8233662107 "also for hiding elements in streamer mode,
// make it blur things"): text through a blurred glyph shadow (::highlight takes no filter), form values the same, media
// through `filter: blur()` clipped to its own box with no cover. A window that cannot blur falls back to the opaque cover.
import { JSDOM, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStreamerBoundary, BLUR_EM, MEDIA_BLUR_PX } from '../src/streamer-boundary'

function fixture(supports: boolean) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry, ...(supports ? { supports: () => true } : {}) }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  return { dom, doc: dom.window.document }
}
const css = (doc: Document) => doc.querySelector('style[data-streamer-style]')!.textContent!
const rule = (text: string, selector: string) => { const i = text.indexOf(selector); assert.ok(i >= 0, selector + ' rule missing'); return text.slice(text.indexOf('{', i) + 1, text.indexOf('}', i)) }

test('masked text is transparent glyphs with a heavy blurred shadow, not a solid box', () => {
  const { dom, doc } = fixture(true), boundary = installStreamerBoundary(doc)
  try {
    const text = css(doc), hl = rule(text, '::highlight(streamer-sensitive)')
    assert.match(hl, /color:transparent/)
    assert.match(hl, /background-color:transparent/, 'no solid box behind masked text')
    assert.ok(!/#686868!important;text-shadow:none/.test(hl))
    const shadow = hl.match(/text-shadow:([^;]+?)!important/)![1]!
    assert.ok(shadow.split(',').every(s => new RegExp(`^0 0 ${BLUR_EM}em #`).test(s.trim())), 'every shadow is a pure blur of radius ' + BLUR_EM + 'em: ' + shadow)
    assert.ok(BLUR_EM >= 0.7, 'radius is at least 0.7em (about 9 px at 13 px text)')
    // form values: the same recipe
    assert.match(text, /textarea[^{]*\{[^}]*text-shadow:0 0 0\.7em/)
  } finally { boundary.dispose(); dom.window.close() }
})

test('media is blurred in place (filter, clipped to its box, no cover) when the window can blur', async () => {
  const { dom, doc } = fixture(true), boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = '<img id="a" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><iframe id="b"></iframe><p>text</p>'
    boundary.update(true, [])
    await flush()
    assert.ok(doc.documentElement.classList.contains('streamer-blur'))
    assert.equal(doc.querySelectorAll('[data-streamer-cover]').length, 0, 'no box over a blurred surface')
    const media = rule(css(doc), 'html.streamer-on.streamer-blur :is(')
    assert.match(media, new RegExp(`filter:blur\\(${MEDIA_BLUR_PX}px\\)`))
    assert.match(media, /clip-path:inset\(0\)/)
    assert.ok(MEDIA_BLUR_PX >= 24)
    boundary.update(false)
    assert.equal(doc.documentElement.classList.contains('streamer-blur'), false, 'turning the mode off removes the blur class')
  } finally { boundary.dispose(); dom.window.close() }
})

test('a window that cannot apply the blur keeps the opaque cover and the hidden-visibility rule (fail closed)', async () => {
  const { dom, doc } = fixture(false), boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = '<img id="a" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="200" height="120">'
    boundary.update(true, [])
    await flush()
    assert.equal(doc.documentElement.classList.contains('streamer-blur'), false)
    assert.match(css(doc), /html\.streamer-on:not\(\.streamer-blur\) :is\(/)
    assert.equal(doc.querySelectorAll('[data-streamer-cover]').length, 1, 'the cover stands in for the blur')
  } finally { boundary.dispose(); dom.window.close() }
})
