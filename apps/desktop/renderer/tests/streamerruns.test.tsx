// Stage 2 of the typing-freeze fix (USER 2026-11-04 19:01Z): the regex pass is per text run, cached by run text, so a keystroke
// re-matches only the run that changed, and the result must be EXACTLY what one pass over the whole text gives.
import { JSDOM } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installStreamerBoundary, spansByRun, streamerScanStats } from '../src/streamer-boundary'
import { DEFAULT_STREAMER_TYPES, sensitiveSpans } from '../../../../packages/contracts/streamer'

const types = { ...DEFAULT_STREAMER_TYPES, paths: true }
const PIECES = ['hello world', 'password', ' : ', '=', 'hunter2', 'Bearer', 'abc.DEF-123_xyz', 'sk-ant-api03-AbCdeF0123456789xyz', 'me@example.test',
  '192.168.12.34', 'C:\\Users\\me\\x.txt', '', ' ', '-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkq', '-----END PRIVATE KEY-----', 'token', '"', 'api key', '+1 (415) 555-0123',
  'AbCdEfGhIjKlMnOpQrStUvWxYz0123', '@net:someone.abc123', '=', ':', '   ', '  ', 'plain words here', 'x'.repeat(100), 'api_key']
const rnd = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32

test('per-run spans equal one pass over the whole text, including matches split across runs (key = value, Bearer, PEM, split keys)', () => {
  const cache = new Map<string, { start: number; end: number }[]>()
  for (let seed = 1; seed <= 400; seed++) {
    const next = rnd(seed), runs: string[] = []
    for (let r = 1 + Math.floor(next() * 7); r > 0; r--) {
      let run = ''
      for (let p = 1 + Math.floor(next() * 3); p > 0; p--) run += PIECES[Math.floor(next() * PIECES.length)]!
      runs.push(run)
    }
    const expected = sensitiveSpans(runs.join('\n'), types, ['someorg'])
    const actual = spansByRun(runs, types, ['someorg'], cache, 'k|')
    assert.deepEqual(actual, expected, `seed ${seed}: ${JSON.stringify(runs)}`)
  }
  // fixed seams
  // build-sol 2026-11-04: a key word and its value separated by MANY whitespace-only runs (the global regex's \s takes them all)
  for (const runs of [['password =', ...Array(8).fill(' '), 'hunter2'], ['Bearer', ...Array(8).fill(' '), 'abcdef123456'], ['api key', ' ', ':', ...Array(20).fill('  '), ' ', 'sekret99'],
    ['token', '=', ...Array(12).fill(''), 'longvalue1234'], ['x'.repeat(10) + ' password', ...Array(50).fill(' '), ':', ' ', 'v1']]) {
    assert.deepEqual(spansByRun(runs, types, [], new Map(), 'k|'), sensitiveSpans(runs.join(String.fromCharCode(10)), types, []), JSON.stringify(runs))
  }
  for (const runs of [['password', 'hunter2'], ['the password:', '  ', 'hunter2'], ['Bearer', 'abcdef123456'], ['x token =', '"quoted value"'], ['-----BEGIN PRIVATE KEY-----', 'AAAA', 'BBBB']]) {
    assert.deepEqual(spansByRun(runs, types, [], new Map(), 'k|'), sensitiveSpans(runs.join('\n'), types, []), JSON.stringify(runs))
  }
})

test('a keystroke re-runs the regexes on the changed run only (work count), at 18k text nodes', { timeout: 180000 }, async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  const doc = dom.window.document, boundary = installStreamerBoundary(doc)
  try {
    let html = ''
    for (let a = 0; a < 121; a++) { html += '<section>'; for (let m = 0; m < 30; m++) html += `<div class="msg"><p>Agent ${a} message ${m}: working on the <code>thing</code> now.<br>second line</p><pre>line one\nline ${m}</pre></div>`; html += '</section>' }
    doc.body.innerHTML = html + '<div id="draft" class="msg">x</div>'
    boundary.update(true, { cover: true })
    for (let quiet = 0, last = -1; quiet < 3;) { await new Promise(r => setTimeout(r, 700)); const c = streamerScanStats().scans.length; quiet = c === last ? quiet + 1 : 0; last = c }
    const seen = streamerScanStats().scans.length
    ;(doc.getElementById('draft')!.firstChild as Text).data = 'xy'
    for (let i = 0; i < 100 && streamerScanStats().scans.length === seen && seen < 32; i++) await new Promise(r => setTimeout(r, 50))
    const last = streamerScanStats().scans.at(-1)!
    console.log(`REGEX regex_chars=${last.regex_chars} of text_chars=${last.text_chars} ms=${last.ms.toFixed(0)}`)
    assert.ok(last.regex_chars < 2000, `regex input for one keystroke: ${last.regex_chars} of ${last.text_chars} chars`)
  } finally { boundary.dispose(); dom.window.close() }
})

// build-sol 2026-11-04: a page with over 1,000,000 characters of free-form text threw IndexSizeError (offset 4294967295): the
// whole-text fallback span starts at 0 but the first text node starts at 1 (after the leading run separator), so setStart got -1.
test('over 1,000,000 characters of free-form text: everything is hidden and nothing throws', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  const doc = dom.window.document, boundary = installStreamerBoundary(doc)
  try {
    doc.body.innerHTML = `<div class="md"><p id="a">first words</p><p>${'word '.repeat(210000)}</p><p id="z">last words</p></div>`
    boundary.update(true, { cover: true })
    const hidden = (registry.get('streamer-sensitive') ?? []).map(r => r.toString())
    assert.ok(hidden.some(t => t.startsWith('first words')) && hidden.some(t => t.endsWith('last words')), 'the whole text is covered')
  } finally { boundary.dispose(); dom.window.close() }
})
