// Stage 3 of the typing-freeze fix (rig-opus: ~430 ms of maskSelectionNow and a whole-document highlight repaint per 40 keys):
// the Highlight object is registered ONCE and diffed in place, an unchanged keystroke touches neither it nor CSS.highlights,
// and maskSelection returns at once for a caret or when nothing is hidden.
import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStreamerBoundary, streamerScanStats } from '../src/streamer-boundary'

const KEY = 'sk-ant-api03-AbCdeF0123456789xyz'
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  let sets = 0
  const registry = new Map<string, unknown>(); const set = registry.set.bind(registry)
  registry.set = (k, v) => { sets++; return set(k, v) }
  class Highlight extends Set<Range> { constructor(...r: Range[]) { super(r) } }
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: Highlight, configurable: true })
  return { dom, doc: dom.window.document, registry, sets: () => sets }
}
const texts = (registry: Map<string, unknown>) => Array.from((registry.get('streamer-sensitive') ?? []) as Iterable<Range>, r => r.toString())

test('one Highlight object is registered once and diffed in place; an unchanged keystroke does not touch it', async () => {
  const { dom, doc, registry, sets } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = `<div class="msg"><p id="a">first ${KEY}</p><p id="b">typing here</p></div>`
    boundary.update(true, { cover: true })
    const object = registry.get('streamer-sensitive'), after = sets()
    assert.deepEqual(texts(registry), [KEY])
    // keystrokes that change no masked span: no set(), same object, same range objects
    const ranges = [...(object as Set<Range>)]
    for (let i = 0; i < 5; i++) { (doc.getElementById('b')!.firstChild as Text).data = 'typing ' + i; await tick() }
    assert.equal(sets(), after, 'CSS.highlights.set not called again')
    assert.equal(registry.get('streamer-sensitive'), object, 'the same Highlight object')
    assert.deepEqual([...(object as Set<Range>)], ranges, 'the same range objects')
    // a new secret: added in place, the object stays
    ;(doc.getElementById('b')!.firstChild as Text).data = `now ${KEY}`; await tick()
    assert.equal(registry.get('streamer-sensitive'), object, 'still the same object')
    assert.equal(sets(), after, 'still no set(): the diff is in place')
    assert.deepEqual(texts(registry), [KEY, KEY])
    // and removed in place
    ;(doc.getElementById('b')!.firstChild as Text).data = 'clean'; await tick()
    assert.deepEqual(texts(registry), [KEY])
    assert.ok(streamerScanStats().masks.length >= 0)
  } finally { boundary.dispose(); dom.window.close() }
})

test('maskSelection does no work for a caret or when nothing is hidden; a real selection over a key is still covered', async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = `<div class="msg"><p id="a">first ${KEY} end</p><p id="b">plain words</p></div>`
    const w = dom.window as unknown as { Range: { prototype: { getClientRects(): unknown } }; getSelection(): Selection }
    w.Range.prototype.getClientRects = function (this: Range) { return [{ left: 10, top: 20, width: this.toString().length * 5, height: 12, right: 0, bottom: 0, x: 10, y: 20, toJSON() {} }] }
    boundary.update(true, { cover: true })
    const sel = w.getSelection()
    // a caret
    const b = doc.getElementById('b')!.firstChild!
    const caret = doc.createRange(); caret.setStart(b, 2); caret.setEnd(b, 2); sel.removeAllRanges(); sel.addRange(caret)
    doc.dispatchEvent(new dom.window.Event('selectionchange'))
    assert.equal(doc.querySelectorAll('[data-streamer-selmask]').length, 0, 'a caret draws nothing')
    // a selection over plain text: nothing to mask
    const plain = doc.createRange(); plain.setStart(b, 0); plain.setEnd(b, 5); sel.removeAllRanges(); sel.addRange(plain)
    doc.dispatchEvent(new dom.window.Event('selectionchange'))
    assert.equal(doc.querySelectorAll('[data-streamer-selmask]').length, 0, 'plain text is not masked')
    // a real selection over the key is covered (guarantee unchanged)
    const a = doc.getElementById('a')!.firstChild!
    const over = doc.createRange(); over.setStart(a, 0); over.setEnd(a, a.textContent!.length); sel.removeAllRanges(); sel.addRange(over)
    doc.dispatchEvent(new dom.window.Event('selectionchange'))
    assert.equal(doc.querySelectorAll('[data-streamer-selmask]').length, 1, 'the selected key is covered')
    // back to a caret: the box is removed
    sel.removeAllRanges(); sel.addRange(caret)
    doc.dispatchEvent(new dom.window.Event('selectionchange'))
    assert.equal(doc.querySelectorAll('[data-streamer-selmask]').length, 0, 'removed again')
  } finally { boundary.dispose(); dom.window.close() }
})
