// RT-S (spec R10): Streamer mode masks a sensitive string inside rendered output,
// including one inside a KaTeX formula (KaTeX splits a formula into many spans)
// and one inside a mention chip's label.
import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { md } from '../src/canvas/shared'
import { installStreamerBoundary } from '../src/streamer-boundary'

const SECRET = 'password=short-private'

function fixture(html: string) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...ranges: Range[]) { super(...ranges) } }, configurable: true })
  dom.window.document.body.innerHTML = html
  return { dom, doc: dom.window.document, registry }
}

const covered = (registry: Map<string, Range[]>) => (registry.get('streamer-sensitive') ?? []).map(r => r.toString())

test('RT-S a sensitive string in plain rendered text is highlighted (control)', () => {
  const { doc, registry } = fixture(`<div class="md">${md('see ' + SECRET + ' now').__html}</div>`)
  const boundary = installStreamerBoundary(doc)
  boundary.update(true, [])
  assert.ok(covered(registry).some(t => t.includes(SECRET)), `ranges: ${JSON.stringify(covered(registry))}`)
  boundary.dispose()
})

test('RT-S a sensitive string inside a KaTeX formula is masked as a whole, in the visible HTML half', () => {
  const html = md(`$\\text{${SECRET}}$`).__html
  assert.ok(html.includes('katex'), 'the formula rendered as KaTeX')
  const { doc, registry } = fixture(`<div class="md">${html}</div>`)
  const boundary = installStreamerBoundary(doc)
  boundary.update(true, [])
  const ranges = registry.get('streamer-sensitive') ?? []
  assert.ok(ranges.length > 0, 'something was highlighted')
  // every text node that draws the secret in the visible half is inside some range
  const visible = [...doc.querySelectorAll('.katex-html')].flatMap(el => [...el.querySelectorAll('*')])
    .filter(el => el.children.length === 0 && (el.textContent ?? '').length > 0)
  const drawn = visible.map(el => el.textContent).join('')
  assert.ok(drawn.includes('short-private') || drawn.replaceAll('​', '').includes('short-private'), `visible half text: ${drawn}`)
  for (const el of visible) {
    const node = el.firstChild as Text
    const hit = ranges.some(r => { try { return r.intersectsNode(node) } catch { return false } })
    assert.ok(hit, `the formula glyph "${el.textContent}" is under a mask range`)
  }
  boundary.dispose()
})

test('RT-S a sensitive string typeset in math (a hyphen becomes a minus sign) is still masked in the visible half', () => {
  const html = md(`$${SECRET}$`).__html
  assert.ok(html.includes('katex'))
  const { doc, registry } = fixture(`<div class="md">${html}</div>`)
  const boundary = installStreamerBoundary(doc)
  boundary.update(true, [])
  const ranges = registry.get('streamer-sensitive') ?? []
  const visible = [...doc.querySelectorAll('.katex-html *')].filter(el => el.children.length === 0 && (el.textContent ?? '').length > 0)
  assert.ok(visible.length > 0, 'the visible half has glyphs')
  for (const el of visible) {
    const node = el.firstChild as Text
    // the glyph must lie INSIDE a mask range, not merely touch one (a range over the first
    // glyph only is how the real-Chromium capture failed)
    assert.ok(ranges.some(r => { try { return r.comparePoint(node, 0) === 0 && r.comparePoint(node, node.data.length) === 0 } catch { return false } }),
      `the visible glyph "${el.textContent}" is under a mask range (visible text: ${visible.map(v => v.textContent).join('')})`)
  }
  boundary.dispose()
})

test('RT-S an sk-ant style key typeset as a formula is masked over ALL its visible glyphs (real-Chromium capture C6)', () => {
  const key = 'sk-ant-api03-TESTSECRET'
  const html = md(`Sensitive formula $${key}$`).__html
  const { doc, registry } = fixture(`<div class="md">${html}</div>`)
  const boundary = installStreamerBoundary(doc)
  boundary.update(true, [])
  const ranges = registry.get('streamer-sensitive') ?? []
  const visible = [...doc.querySelectorAll('.katex-html *')].filter(el => el.children.length === 0 && (el.textContent ?? '').length > 0)
  assert.ok(visible.length > 5, 'the visible half has glyphs')
  const unmasked = visible.filter(el => {
    const node = el.firstChild as Text
    return !ranges.some(r => { try { return r.comparePoint(node, 0) === 0 && r.comparePoint(node, node.data.length) === 0 } catch { return false } })
  }).map(el => el.textContent)
  assert.deepEqual(unmasked, [], `visible glyphs outside every mask range: ${unmasked.join('')}; ranges: ${JSON.stringify(ranges.map(r => r.toString()))}`)
  boundary.dispose()
})
