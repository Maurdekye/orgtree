// Stage 5 of the typing-freeze fix (rig-opus b008abc cause ring: all 32 scans while typing were 'childList div.cc-composer > textarea'):
// content changes inside an element the walk never masks cost no scan; what the walk DOES mask is unchanged.
import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStreamerBoundary, streamerScanStats } from '../src/streamer-boundary'

const KEY = 'sk-ant-api03-AbCdeF0123456789xyz'
function fixture() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  return { dom, doc: dom.window.document, registry }
}
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const spansOf = (registry: Map<string, Range[]>) => Array.from(registry.get('streamer-sensitive') ?? [], r => r.toString())

test('typing into a textarea / contenteditable / UI element costs no scan; a toggle and real content still do', async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = `<div class="msg"><p id="m">hello</p></div><div class="cc-composer"><textarea id="t">draft</textarea></div><div id="ce" contenteditable="true">edit</div><div data-streamer-visible id="vis">@net:me.abc</div>`
    boundary.update(true, { cover: true })
    await wait(400)
    const before = streamerScanStats().scans.length
    const t = doc.getElementById('t')!
    for (let i = 0; i < 20; i++) { t.textContent = 'typed ' + KEY + i; t.appendChild(doc.createTextNode('x')) }   // React-style child rewrites
    ;(doc.getElementById('ce')!.firstChild as Text).data = 'edited ' + KEY
    doc.getElementById('ce')!.appendChild(doc.createElement('b'))
    ;(doc.getElementById('vis')!.firstChild as Text).data = '@net:me.abc.def'
    await wait(400)
    assert.equal(streamerScanStats().scans.length, before, 'no scan for content inside skipped elements')
    assert.deepEqual(spansOf(registry), [], 'and nothing was (or needed to be) masked there')
    // real free-form content still scans and masks
    ;(doc.getElementById('m')!.firstChild as Text).data = `secret ${KEY}`
    await wait(400)
    assert.equal(streamerScanStats().scans.length > before, true, 'free-form text still scans')
    assert.deepEqual(spansOf(registry), [KEY])
    // a contenteditable toggled OFF turns its content into a classifiable... (the attribute record is kept)
    const afterContent = streamerScanStats().scans.length
    doc.getElementById('ce')!.setAttribute('contenteditable', 'false'); doc.getElementById('ce')!.className = 'msg'
    await wait(400)
    assert.equal(streamerScanStats().scans.length > afterContent, true, 'a contenteditable toggle still scans')
    assert.deepEqual(spansOf(registry).sort(), [KEY, 'edited ' + KEY].sort(), 'the formerly editable text is now masked')
  } finally { boundary.dispose(); dom.window.close() }
})
