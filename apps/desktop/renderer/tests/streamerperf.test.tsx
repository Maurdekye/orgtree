// UI freeze while typing with streamer mode on (USER 2026-11-04 19:01Z): a one-node mutation must not cost a whole-document scan.
import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStreamerBoundary } from '../src/streamer-boundary'
import { streamerScanStats } from '../src/streamer-boundary'
import { sensitiveSpans } from '../../../../packages/contracts/streamer'

function fixture() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  return { dom, doc: dom.window.document, registry }
}
const AGENTS = 121, MSGS = 30
function build(doc: Document) {
  let html = ''
  for (let a = 0; a < AGENTS; a++) {
    html += `<section class="desk">`
    for (let m = 0; m < MSGS; m++) html += `<div class="msg"><p>Agent ${a} message ${m}: working on the <code>thing</code> now.<br>second line with a path-ish word and more words here</p><pre>line one\nline two ${m}</pre></div>`
    html += `</section>`
  }
  html += `<div class="composer"><span id="count">0</span><div id="draft" class="msg">x</div></div>`
  doc.body.innerHTML = html
}
test('perf probe: one-node mutation scan work', { timeout: 120000 }, async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    build(doc)
    const nodes = doc.createTreeWalker(doc.body, 4); let n = 0; while (nodes.nextNode()) n++
    let t = performance.now(); boundary.update(true, { cover: true }); const full = performance.now() - t
    // count text nodes visited by the walker during a one-node mutation
    const proto = dom.window.TreeWalker.prototype as unknown as { nextNode(): Node | null }
    const orig = proto.nextNode; let visits = 0
    proto.nextNode = function (this: TreeWalker) { visits++; return orig.call(this) }
    const draft = doc.getElementById('draft')!.firstChild as Text
    // let the build's own mutation records and their (paced) rescans finish first
    for (let quiet = 0, last = -1; quiet < 3;) {
      await new Promise(r => setTimeout(r, 700))
      const count = streamerScanStats().scans.length
      quiet = count === last ? quiet + 1 : 0; last = count
    }
    // (A) chrome text (a typing counter, outside every zone) changes: no scan at all
    const counter = doc.getElementById('count')!.firstChild as Text
    let seen = streamerScanStats().scans.length
    counter.data = '1'; doc.getElementById('count')!.setAttribute('class', 'hint'); doc.body.appendChild(doc.createElement('i'))
    await new Promise(r => setTimeout(r, 400))
    assert.equal(streamerScanStats().scans.length, seen, 'a chrome-only mutation must not start a scan')
    // (B) one free-form text node changes: one scan, 10x cheaper than the 2220 ms whole-document scan
    seen = streamerScanStats().scans.length
    draft.data = 'xy'
    for (let i = 0; i < 100 && streamerScanStats().scans.length === seen && seen < 32; i++) await new Promise(r => setTimeout(r, 50))
    const last = streamerScanStats().scans.at(-1)!
    const one = last.ms
    proto.nextNode = orig
    const all = doc.body.textContent ?? ''; t = performance.now(); sensitiveSpans(all); const spans = performance.now() - t
    console.log(`PERF textNodes=${n} full=${full.toFixed(0)}ms oneNode=${one.toFixed(0)}ms walkerVisits=${visits} nodes_walked=${last.nodes_walked} trigger=${last.trigger} spansOnly=${spans.toFixed(0)}ms hidden=${registry.get('streamer-sensitive')?.length}`)
    assert.ok(one < 220, `a one-node mutation scan must be 10x faster than the 2220 ms whole-document scan: ${one.toFixed(0)} ms`)
  } finally { boundary.dispose(); dom.window.close() }
})

const key = 'sk-ant-api03-AbCdeF0123456789xyz'
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const spansOf = (registry: Map<string, Range[]>) => Array.from(registry.get('streamer-sensitive') ?? [], r => r.toString())

test('a class toggled on an ancestor re-classifies the text below in the same microtask', async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = `<div id="box"><p>see ${key} here</p></div>`
    boundary.update(true, { cover: true, types: { paths: false, ips: true, emails: true, secrets: true, phones: true, tokenUrls: true, externals: true, orgs: true } })
    assert.deepEqual(spansOf(registry), [], 'not a free-form zone yet: nothing matched')
    doc.getElementById('box')!.className = 'msg'
    await tick()
    assert.deepEqual(spansOf(registry), [key], 'now free-form: masked at once')
    doc.getElementById('box')!.className = ''
    await tick()
    assert.deepEqual(spansOf(registry), [], 'and un-masked again')
  } finally { boundary.dispose(); dom.window.close() }
})

test('a secret split across inline nodes, and an unterminated private key across blocks, still match; removed nodes drop their ranges', async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = `<div class="msg"><p>x <b>sk-ant-</b><i>api03-AbCdeF0123456789xyz</i> y</p></div><div class="msg"><p id="pem">-----BEGIN PRIVATE KEY-----</p></div><div class="msg"><p>MIIEvQIBADANBgkq</p><p id="later">later words</p></div>`
    boundary.update(true, { cover: true, types: { paths: false, ips: true, emails: true, secrets: true, phones: true, tokenUrls: true, externals: true, orgs: true } })
    const all = spansOf(registry).join('|')
    assert.match(all, /sk-ant-api03-AbCdeF0123456789xyz/)
    assert.match(all, /later words/, 'the unterminated key runs to the end of the text, across blocks')
    doc.getElementById('pem')!.remove()
    await tick()
    assert.doesNotMatch(spansOf(registry).join('|'), /later words|BEGIN/, 'removed start: no stale range')
    const before = streamerScanStats().scans.length
    for (let i = 0; i < 40; i++) { doc.getElementById('later')!.firstChild!.textContent = 'w' + i; await tick() }
    const stats = streamerScanStats()
    assert.equal(stats.on, true)
    assert.ok(stats.scans.length <= 32 && before <= 32, 'ring capped at 32')
    assert.equal(stats.scans[stats.scans.length - 1]!.trigger, 'mutation')
    assert.ok(stats.scans.at(-1)!.text_nodes > 0 && stats.scans.at(-1)!.text_chars >= 0, 'text_nodes counted')
    assert.ok(stats.masks.length > 0 && stats.masks.length <= 64, 'maskSelection calls are ringed (max 64)')
  } finally { boundary.dispose(); dom.window.close() }
})

test('sustained per-frame structural mutations keep the scan share of the main thread bounded', { timeout: 120000 }, async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = '<div id="t" class="md"></div>'
    const host = doc.getElementById('t')!
    for (let i = 0; i < 4000; i++) { const p = doc.createElement('p'); p.textContent = `row ${i} text`; host.appendChild(p) }
    boundary.update(true, { cover: true })
    await tick()
    const before = streamerScanStats().scans.length
    const began = performance.now()
    for (let i = 0; i < 400; i++) {
      const p = doc.createElement('p'); p.textContent = `fresh ${i}`; host.appendChild(p)
      await new Promise(r => setImmediate(r))
    }
    const elapsed = performance.now() - began
    const scans = streamerScanStats().scans.slice(before > 32 ? 0 : before)
    const spent = scans.reduce((n, s) => n + s.ms, 0)
    assert.ok(scans.length < 400, `scans were coalesced/paced: ${scans.length} for 400 mutations`)
    assert.ok(spent / elapsed < 0.5, `scan share ${(100 * spent / elapsed).toFixed(0)}% of ${elapsed.toFixed(0)} ms (ring ${scans.length} scans)`)
    // masking still lands: a key appended now is hidden once the (paced) scan runs
    const secret = doc.createElement('p'); secret.textContent = `k ${key}`; host.appendChild(secret)
    for (let i = 0; i < 100 && !(doc.defaultView as unknown as { CSS: { highlights: Map<string, Range[]> } }).CSS.highlights.get('streamer-sensitive')?.some(r => r.toString() === key); i++) await new Promise(r => setTimeout(r, 50))
    assert.ok((doc.defaultView as unknown as { CSS: { highlights: Map<string, Range[]> } }).CSS.highlights.get('streamer-sensitive')?.some(r => r.toString() === key), 'the appended key is masked')
  } finally { boundary.dispose(); dom.window.close() }
})

test('while a slow scan is paced, new or changed text is blurred whole at once and masked by the scan (nothing shows unmasked)', { timeout: 120000 }, async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = '<div id="t" class="md"></div>'
    const host = doc.getElementById('t')!
    for (let i = 0; i < 4000; i++) { const p = doc.createElement('p'); p.textContent = `row ${i} text`; host.appendChild(p) }
    boundary.update(true, { cover: true })
    for (let quiet = 0, last = -1; quiet < 2;) { await new Promise(r => setTimeout(r, 400)); const c = streamerScanStats().scans.length; quiet = c === last ? quiet + 1 : 0; last = c }
    assert.ok(streamerScanStats().scans.at(-1)!.ms >= 16, 'the scan is slow enough to be paced in this fixture')
    const secret = doc.createElement('p'); secret.textContent = `k ${key}`; host.appendChild(secret)
    const edited = host.children[3]!; edited.firstChild!.textContent = `now ${key}`
    await tick()
    assert.equal(secret.hasAttribute('data-streamer-pending'), true, 'the appended paragraph is blurred before the paced scan runs')
    assert.equal(edited.hasAttribute('data-streamer-pending'), true, 'the edited paragraph is blurred too')
    for (let i = 0; i < 200 && secret.hasAttribute('data-streamer-pending'); i++) await new Promise(r => setTimeout(r, 50))
    assert.equal(secret.hasAttribute('data-streamer-pending'), false, 'the scan ran and cleared the temporary blur')
    assert.equal(spansOf(registry).filter(t => t === key).length, 2, 'both keys are masked by the scan')
    const box = doc.createElement('div'); box.innerHTML = '<span>me@example.test</span>'; doc.body.appendChild(box)
    await new Promise(r => setTimeout(r, 1500))
    const before = spansOf(registry).length
    box.setAttribute('data-streamer-field', 'email')
    for (let i = 0; i < 200 && spansOf(registry).length === before; i++) await new Promise(r => setTimeout(r, 50))
    assert.ok(spansOf(registry).includes('me@example.test'), 'a data-streamer-field added later is honoured')
  } finally { boundary.dispose(); dom.window.close() }
})

test('sustained per-frame free-form edits at 18k text nodes: scan time per second stays bounded (number reported)', { timeout: 180000 }, async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  try {
    build(doc)
    boundary.update(true, { cover: true })
    for (let quiet = 0, last = -1; quiet < 3;) { await new Promise(r => setTimeout(r, 700)); const c = streamerScanStats().scans.length; quiet = c === last ? quiet + 1 : 0; last = c }
    const draft = doc.getElementById('draft')!.firstChild as Text
    const baseline = streamerScanStats().scans.at(-1)?.start ?? -1
    const began = performance.now()
    for (let i = 0; i < 150; i++) { draft.data = 'frame ' + i; await new Promise(r => setTimeout(r, 16)) }
    const elapsed = performance.now() - began
    const scans = streamerScanStats().scans
    const fresh = scans.filter(s => s.start > baseline)
    const spent = fresh.reduce((n, s) => n + s.ms, 0)
    const perSecond = spent / (elapsed / 1000)
    console.log(`FRAMES 150 edits at ~60 fps in ${elapsed.toFixed(0)} ms (jsdom, 18k nodes): ${fresh.length} scans, scan time ${perSecond.toFixed(0)} ms per second`)
    assert.ok(perSecond < 300, `scan time per second ${perSecond.toFixed(0)} ms`)
  } finally { boundary.dispose(); dom.window.close() }
})
