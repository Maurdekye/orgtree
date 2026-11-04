// Stage 4 of the typing-freeze fix (coordinator m0d71b751b586): a batch of edits to free-form text whose runs stay clean changes no
// mask, so the scan does no join and no walk; any edit that could change a mask takes the full pass. Plus the scan ring's `cause`.
import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStreamerBoundary, streamerScanStats } from '../src/streamer-boundary'
import { DEFAULT_STREAMER_TYPES, sensitiveSpans } from '../../../../packages/contracts/streamer'

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

test('clean text-only edits at 18k text nodes: no walk, no join, no regex work; the scan says why it ran', { timeout: 180000 }, async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    let html = ''
    for (let a = 0; a < 121; a++) { html += '<section>'; for (let m = 0; m < 30; m++) html += `<div class="msg"><p>Agent ${a} message ${m}: working on the <code>thing</code> now.<br>second line</p><pre>line one</pre></div>`; html += '</section>' }
    doc.body.innerHTML = html + '<div id="draft" class="msg">x</div>'
    boundary.update(true, { cover: true })
    for (let quiet = 0, last = -1; quiet < 3;) { await wait(700); const c = streamerScanStats().scans.length; quiet = c === last ? quiet + 1 : 0; last = c }
    const draft = doc.getElementById('draft')!.firstChild as Text
    const seen = streamerScanStats().scans.length
    draft.data = 'xy'
    for (let i = 0; i < 100 && streamerScanStats().scans.length === seen && seen < 32; i++) await wait(50)
    const last = streamerScanStats().scans.at(-1)!
    console.log(`FAST nodes_walked=${last.nodes_walked} regex_chars=${last.regex_chars} ms=${last.ms.toFixed(1)} cause=${last.cause}`)
    assert.equal(last.nodes_walked, 0, 'no text node was walked')
    assert.ok(last.regex_chars < 100, 'only the changed run reached the regexes: ' + last.regex_chars)
    assert.ok(last.ms < 10, `the scan took ${last.ms} ms`)
    assert.match(last.cause, /characterData .*#draft/, 'the ring names the mutation that made it run: ' + last.cause)
  } finally { boundary.dispose(); dom.window.close() }
})

test('random edit sequences: the highlight always equals one pass over the whole text (keys typed, deleted, key words, seams, private keys)', { timeout: 180000 }, async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  const PIECES = ['hello', ' world ', 'password', ' = ', 'hunter2', 'Bearer', 'abcDEF12345', KEY, 'me@example.test', '', ' ', '-----BEGIN PRIVATE KEY-----', 'MIIEvQIB', 'token', ':', 'x']
  let seed = 7; const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
  try {
    const N = 8
    doc.body.innerHTML = '<div class="md">' + Array.from({ length: N }, (_, i) => `<p id="p${i}">start ${i}</p>`).join('') + '</div>'
    boundary.update(true, { cover: true })
    await wait(500)
    for (let step = 0; step < 120; step++) {
      const i = Math.floor(next() * N)
      const node = doc.getElementById('p' + i)!.firstChild as Text
      let data = ''
      for (let k = 1 + Math.floor(next() * 3); k > 0; k--) data += PIECES[Math.floor(next() * PIECES.length)]
      node.data = data
      await wait(60)
      const texts = Array.from({ length: N }, (_, j) => (doc.getElementById('p' + j)!.firstChild as Text).data)
      const whole = ['', ...texts].join('\n')
      const expected = sensitiveSpans(whole, DEFAULT_STREAMER_TYPES, []).map(s => whole.slice(s.start, s.end).split(String.fromCharCode(10)).join(''))
      assert.deepEqual(spansOf(registry).sort(), expected.sort(), `step ${step}: ${JSON.stringify(texts)}`)
    }
  } finally { boundary.dispose(); dom.window.close() }
})

test('edits to the whitespace / separator / value runs after a key word match one whole-text pass (the seam window reaches them)', { timeout: 180000 }, async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    const N = 14
    doc.body.innerHTML = '<div class="md">' + Array.from({ length: N }, (_, i) => `<p id="p${i}">${i === 0 ? 'password' : i === 1 ? '=' : i === N - 1 ? 'hunter2' : ' '}</p>`).join('') + '</div>'
    boundary.update(true, { cover: true })
    await wait(500)
    const check = (label: string) => {
      const texts = Array.from({ length: N }, (_, j) => (doc.getElementById('p' + j)!.firstChild as Text).data)
      const whole = ['', ...texts].join('\n')
      const expected = sensitiveSpans(whole, DEFAULT_STREAMER_TYPES, []).map(s => whole.slice(s.start, s.end).split(String.fromCharCode(10)).join(''))
      assert.deepEqual(spansOf(registry).sort(), expected.sort(), `${label}: ${JSON.stringify(texts)}`)
    }
    check('initial')
    const edit = async (i: number, data: string, label: string) => { (doc.getElementById('p' + i)!.firstChild as Text).data = data; await wait(80); check(label) }
    await edit(N - 1, 'abc', 'value run edited')
    await edit(N - 1, 'hunter3x', 'value run edited again')
    await edit(5, ' x ', 'a gap run gets text (breaks the chain)')
    await edit(5, ' ', 'the gap run is whitespace again')
    await edit(1, ':', 'separator changed')
    await edit(0, 'plain', 'key word removed')
    await edit(0, 'token', 'key word back')
  } finally { boundary.dispose(); dom.window.close() }
})
