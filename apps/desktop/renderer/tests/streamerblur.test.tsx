// Streamer mode BLURS what it hides, in place (USER 2026-11-03 m4f8233662107 "make it blur things"): matched text spans and
// always-fields through transparent glyphs plus a heavy blurred shadow (::highlight accepts no `filter`), same box, no
// reflow. Opaque surfaces (HTML apps, HTML presentations, video) keep the dismissable cover (coordinator 17:35Z rule 4);
// a window that cannot mask single values hides all text (fail closed).
import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStreamerBoundary, BLUR_EM } from '../src/streamer-boundary'

function fixture(highlights = true) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  if (highlights) {
    Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
    Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  }
  return { dom, doc: dom.window.document }
}
const css = (doc: Document) => doc.querySelector('style[data-streamer-style]')!.textContent!
const rule = (text: string, selector: string) => { const i = text.indexOf(selector); assert.ok(i >= 0, selector + ' rule missing'); return text.slice(text.indexOf('{', i) + 1, text.indexOf('}', i)) }

test('masked text is transparent glyphs with a heavy blurred shadow, not a solid box; the same recipe blurs always-field inputs', () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    const text = css(doc), hl = rule(text, '::highlight(streamer-sensitive)')
    assert.match(hl, /color:transparent/)
    assert.match(hl, /background-color:transparent/, 'no solid box behind masked text')
    const shadow = hl.match(/text-shadow:([^;]+?)!important/)![1]!
    assert.ok(shadow.split(',').every(s => new RegExp(`^0 0 ${BLUR_EM}em #`).test(s.trim())), 'every shadow is a pure blur of radius ' + BLUR_EM + 'em: ' + shadow)
    assert.ok(BLUR_EM >= 0.7, 'radius is at least 0.7em (about 9 px at 13 px text)')
    const field = rule(text, 'html.streamer-on [data-streamer-blur]{')
    assert.match(field, /text-shadow:0 0 0\.7em/)
    assert.match(field, /-webkit-text-fill-color:transparent/)
    // no blanket rules: ordinary inputs, selects and images are never touched
    assert.ok(!/html\.streamer-on (input|textarea|select|\*)[ ,{:]/.test(text.replace(/\[data-streamer-blur\][^{]*\{[^}]*\}/g, '')), 'no blanket input/select/background rules')
    assert.ok(!/(^|[,\s])img\b/.test(text), 'images are not hidden')
  } finally { boundary.dispose(); dom.window.close() }
})

test('a window that cannot mask single values hides text paint, never the window (fail closed)', () => {
  const { dom, doc } = fixture(false), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<div class="md">reader@example.test</div>'
  try {
    boundary.update(true)
    assert.ok(doc.documentElement.classList.contains('streamer-textless'))
    assert.match(css(doc), /html\.streamer-textless body :not\(\[data-streamer-ui\]/)
  } finally { boundary.dispose(); dom.window.close() }
})
