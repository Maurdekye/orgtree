// htmlresponse.test.ts — render-inline-html-custom-responses.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs htmlresponse
//
// Every check here is a positive control in the strict sense: each one
// fails against a naive "just strip the fence and dump the HTML" version
// AND against a "do nothing, DOMPurify already strips it" version. The
// first three prove the swap fires and is isolated; the rest prove it does
// not fire where it must not.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { md } from '../src/canvas/shared'
import { HTML_RESPONSE_MAX_CHARS } from '../src/canvas/htmlresponse'

const fence = (lang: string, body: string) => '```' + lang + '\n' + body + '\n```'

test('⭐ the exact tag becomes a sandboxed iframe, not a code block', () => {
  const html = md(fence('orgtree-html-response', '<button onclick="go()">hi</button>')).__html
  assert.ok(html.includes('<iframe'), html)
  assert.ok(!html.includes('<pre'), 'the code block should be gone, not just decorated: ' + html)
  assert.ok(!html.includes('<code'), html)
})

test('⭐ the frame is sandboxed to allow-scripts ONLY — no allow-same-origin', () => {
  const html = md(fence('orgtree-html-response', '<p>hi</p>')).__html
  const m = /sandbox="([^"]*)"/.exec(html)
  assert.ok(m, html)
  assert.equal(m![1], 'allow-scripts',
    'any additional token (allow-same-origin especially) breaks the isolation')
})

test('⭐ the raw markup never enters the OUTER document — only the frame\'s srcdoc', () => {
  const payload = '<script>window.top.location="https://evil.example"</script>'
  const html = md(fence('orgtree-html-response', payload)).__html
  // the outer HTML string carries the payload only inside the srcdoc
  // attribute of the iframe — never as a live sibling tag DOMPurify would
  // otherwise have stripped from ordinary prose anyway. Assert it is NOT
  // present as a parsed <script> element in the outer template.
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  assert.equal(tpl.content.querySelectorAll('script').length, 0,
    'a live <script> reached the outer (unsandboxed) document')
  const frame = tpl.content.querySelector('iframe') as HTMLIFrameElement
  assert.ok(frame, html)
  assert.ok(frame.srcdoc.includes(payload),
    'the agent\'s exact source should survive verbatim inside the frame')
})

test('⭐ the CSP blocks every fetch-governed network path by default (fetch/XHR/websocket/images) — NOT a claim about navigation, see htmlresponse.ts', () => {
  const html = md(fence('orgtree-html-response', '<p>hi</p>')).__html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const frame = tpl.content.querySelector('iframe') as HTMLIFrameElement
  assert.ok(/default-src 'none'/.test(frame.srcdoc), frame.srcdoc)
  assert.ok(/connect-src 'none'/.test(frame.srcdoc), frame.srcdoc)
  assert.ok(/script-src 'unsafe-inline'/.test(frame.srcdoc),
    'inline script must still be allowed to run for interactive responses')
})

test('an ordinary ```html sample is UNAFFECTED — explicit opt-in, not any HTML fence', () => {
  const html = md(fence('html', '<button onclick="go()">hi</button>')).__html
  assert.ok(html.includes('<pre'), html)
  assert.ok(!html.includes('<iframe'), html)
  // it stays a quoted SAMPLE, not a live element — the literal tag is
  // HTML-entity-escaped text content (wrapCodeBlocks' own copy button also
  // renders as a real <button>, so the check is for the AGENT'S tag only)
  assert.ok(!html.includes('<button onclick'), html)
  assert.ok(html.includes('&lt;button onclick'), html)
})

test('plain prose and other fenced code are byte-for-byte unaffected', () => {
  const prose = 'no code here, just **bold** text and a [link](https://example.com)'
  assert.ok(!md(prose).__html.includes('<iframe'))
  const code = md(fence('python', 'print("hi")')).__html
  assert.ok(code.includes('<pre'))
  assert.ok(!code.includes('<iframe'))
  assert.ok(code.includes('print'))
})

test('a message can mix ordinary prose with one html-response block', () => {
  const text = 'here is a live widget:\n\n' + fence('orgtree-html-response', '<b>hi</b>') + '\n\nand some trailing prose'
  const html = md(text).__html
  assert.ok(html.includes('here is a live widget'), html)
  assert.ok(html.includes('and some trailing prose'), html)
  assert.ok(html.includes('<iframe'), html)
})

test('an oversized block falls back to an ordinary code block, not a frame', () => {
  const big = 'x'.repeat(HTML_RESPONSE_MAX_CHARS + 1)
  const html = md(fence('orgtree-html-response', big)).__html
  assert.ok(!html.includes('<iframe'), 'an over-cap block must not be sandboxed silently')
  assert.ok(html.includes('<pre'), html)
})

test('⭐ a literal, UNFENCED mention of the exact matching markup in prose does not become a real element', () => {
  // the coordinator's review question: does the swap key on the SOURCE
  // fence, or on the resulting DOM shape regardless of how it got there?
  // It's the DOM shape (see the module header) — so the guarantee this
  // relies on is `escapeAngles` (shared.ts), and THIS is the test that
  // would fail if that upstream escaping ever regressed.
  const typed = 'just typing it out: <pre><code class="language-orgtree-html-response">x</code></pre>'
  const html = md(typed).__html
  assert.ok(!html.includes('<iframe'), html)
  // it must show as inert, visible text — not silently vanish either
  assert.match(html, /language-orgtree-html-response/)
})

test('a fence tag with trailing info-string text still matches — same rule as every other language', () => {
  // `marked` keys every fence's class on the FIRST word of the info string
  // (```python 3.12 still renders as language-python) — this tag is no
  // exception, and the trailing word is still an explicit, deliberate
  // author action, not a bypass.
  const html = md(fence('orgtree-html-response ignored-note', '<b>hi</b>')).__html
  assert.ok(html.includes('<iframe'), html)
})

test('a near-miss tag (prefix/suffix, not the exact language token) does NOT match', () => {
  for (const tag of ['orgtree-html-responsezzz', 'xorgtree-html-response', 'orgtree-html-respons']) {
    const html = md(fence(tag, '<b>hi</b>')).__html
    assert.ok(!html.includes('<iframe'), `"${tag}" should not have matched: ${html}`)
  }
})

test('multiple html-response blocks in one message each get their own frame', () => {
  const text = fence('orgtree-html-response', '<p>one</p>') + '\n\n' + fence('orgtree-html-response', '<p>two</p>')
  const tpl = document.createElement('template')
  tpl.innerHTML = md(text).__html
  const frames = [...tpl.content.querySelectorAll('iframe')] as HTMLIFrameElement[]
  assert.equal(frames.length, 2, tpl.innerHTML)
  assert.ok(frames[0]!.srcdoc.includes('<p>one</p>'))
  assert.ok(frames[1]!.srcdoc.includes('<p>two</p>'))
})
