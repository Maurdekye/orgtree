// UI freeze while typing with streamer mode on (USER 2026-11-04 19:01Z): after one free-form text node changes in a large page
// (121 agents x 30 messages, ~18k text nodes) the mask must catch up quickly. This probe uses no new exports, so it runs on the
// old code too: it measures the time from the mutation to the next highlight update (scan end), pacing wait included.
// Measured: old code 2,2xx ms (a whole-document scan per mutation); the incremental scan well under 220 ms (jsdom).
import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStreamerBoundary } from '../src/streamer-boundary'

test('one changed free-form text node: mutation to updated mask in under 220 ms at 18k text nodes', { timeout: 180000 }, async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const doc = dom.window.document
  let sets = 0
  const registry = new Map<string, unknown>(); const set = registry.set.bind(registry)
  registry.set = (k, v) => { sets++; return set(k, v) }
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  const boundary = installStreamerBoundary(doc)
  try {
    let html = ''
    for (let a = 0; a < 121; a++) {
      html += '<section class="desk">'
      for (let m = 0; m < 30; m++) html += `<div class="msg"><p>Agent ${a} message ${m}: working on the <code>thing</code> now.<br>second line with words</p><pre>line one\nline two ${m}</pre></div>`
      html += '</section>'
    }
    doc.body.innerHTML = html + '<div id="draft" class="msg">x</div>'
    boundary.update(true, { cover: true })
    for (let quiet = 0, last = -1; quiet < 3;) { await new Promise(r => setTimeout(r, 700)); quiet = sets === last ? quiet + 1 : 0; last = sets }
    const draft = doc.getElementById('draft')!.firstChild as Text
    const before = sets, began = performance.now()
    draft.data = 'xy sk-ant-api03-AbCdeF0123456789xyz'
    while (sets === before && performance.now() - began < 20000) await new Promise(r => setTimeout(r, 5))
    const took = performance.now() - began
    console.log(`LATENCY mutation to mask update: ${took.toFixed(0)} ms`)
    assert.ok(took < 220, `mutation to mask update took ${took.toFixed(0)} ms`)
  } finally { boundary.dispose(); dom.window.close() }
})
