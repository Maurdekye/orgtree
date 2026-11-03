import { JSDOM, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { sensitiveSpans, redactScreenText, nativeScreenText, STREAMER_TYPE_LIST } from '../../../../packages/contracts/streamer'
import { installStreamerBoundary } from '../src/streamer-boundary'

function fixture(highlights = true) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  if (highlights) {
    Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
    Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...ranges: Range[]) { super(...ranges) } }, configurable: true })
  }
  return { dom, doc: dom.window.document, registry }
}
// The one boundary, with the DEFINITIVE list (USER 2026-11-03 m63438d6bebc3): free-form text is pattern-matched for the
// enabled types; everything else is never hidden. One positive sample per type, in a free-form container.
const samples: [string, string][] = [
  ['paths', 'C:\\Users\\private-reader\\project\\file.txt'], ['ips', '192.168.12.34'], ['emails', 'reader@example.test'],
  ['secrets', 'password=short-private'], ['phones', '+1 (415) 555-0123'], ['tokenUrls', 'https://example.test/path?token=short-secret'],
  ['externals', '@net:private-reader.abc123'],
]
const ALL_ON = { paths: true, ips: true, emails: true, secrets: true, phones: true, tokenUrls: true, externals: true, orgs: true } as const
test('every type is blurred in free-form text on every surface class, safe prose remains, copy and links are unchanged', () => {
  for (const surface of ['md', 'msg', 'mailer-body', 'docket-desc-body']) {
    const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
    try {
      const root = doc.createElement('div'); root.className = surface
      for (const [, value] of samples) { const p = doc.createElement('p'); p.textContent = 'Before ' + value + ' after'; root.appendChild(p) }
      const link = doc.createElement('a'); link.href = 'https://example.test/?token=original-token'; link.textContent = 'Open'; root.appendChild(link)
      const input = doc.createElement('input'); input.value = 'original-editor-secret'; root.appendChild(input)
      doc.body.appendChild(root)
      const original = root.textContent
      boundary.update(true, { types: { ...ALL_ON }, cover: true })
      const ranges = Array.from(registry.get('streamer-sensitive') ?? [], r => r.toString())
      for (const [kind, value] of samples) assert.ok(ranges.some(r => r.includes(value)), `${surface}: ${kind} in ${JSON.stringify(ranges)}`)
      assert.ok(!ranges.some(r => /Before|after/.test(r) && !/password|token/.test(r)), 'ordinary words stay: ' + JSON.stringify(ranges))
      assert.equal(root.textContent, original, 'original DOM text is intact')
      assert.equal(input.value, 'original-editor-secret')
      assert.equal(input.getAttribute('autocomplete'), 'off')
      assert.equal(link.getAttribute('href'), 'https://example.test/?token=original-token')
      boundary.update(false)
      assert.equal(registry.has('streamer-sensitive'), false)
      assert.equal(root.textContent, original)
    } finally { boundary.dispose(); dom.window.close() }
  }
})
test('split text and live updates are matched in free-form text; the same text outside free-form is never touched', async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<div class="md"><p>reader@<b>example.test</b></p></div><div class="row-name">reader@example.test</div>'
  try {
    boundary.update(true)
    const text = () => Array.from(registry.get('streamer-sensitive') ?? [], r => r.toString())
    assert.deepEqual(text(), ['reader@example.test'], 'only the free-form copy is blurred')
    doc.body.querySelector('p')!.textContent = 'new@example.test'
    await flush()
    assert.deepEqual(text(), ['new@example.test'])
  } finally { boundary.dispose(); dom.window.close() }
})
test('opaque surfaces stay mounted, each cover dismisses independently and returns after toggle or reopen', async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<iframe></iframe><img><video></video><canvas></canvas><object></object><embed><div class="md">Safe Markdown</div>'
  try {
    const original = [...doc.body.children]
    boundary.update(true)
    const covers = [...doc.querySelectorAll<HTMLButtonElement>('[data-streamer-dismiss]')]
    // four opaque surfaces (iframe, video, object, embed); images and the <canvas> are never hidden
    assert.equal(covers.length, 4)
    covers[0]!.click()
    assert.equal(doc.querySelectorAll('[data-streamer-revealed]').length, 1)
    assert.ok(original.every(el => el.isConnected), 'runtime DOM remains mounted')
    boundary.update(false); boundary.update(true)
    assert.equal(doc.querySelectorAll('[data-streamer-revealed]').length, 0)
    assert.equal(doc.querySelectorAll('[data-streamer-dismiss]').length, 4)
    doc.querySelector<HTMLButtonElement>('[data-streamer-dismiss]')!.click()
    original[0]!.remove(); await flush(); doc.body.appendChild(original[0]!); await flush()
    assert.equal(original[0]!.hasAttribute('data-streamer-revealed'), false)
    doc.querySelector<HTMLButtonElement>('[data-streamer-dismiss]')!.click()
    const reused = doc.querySelector('[data-streamer-revealed]')!
    reused.remove(); doc.body.appendChild(reused); await flush()
    assert.equal(reused.hasAttribute('data-streamer-revealed'), false, 'same-turn close/reopen also resets the cover')
    assert.equal(doc.querySelector('.md')!.textContent, 'Safe Markdown')
  } finally { boundary.dispose(); dom.window.close() }
})
test('unavailable masking withholds text paint, never the window; native picker values are not changed', () => {
  const { dom, doc } = fixture(false), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<div id="root">reader@example.test</div><input type="file">'
  try {
    boundary.update(true)
    assert.ok(doc.documentElement.classList.contains('streamer-textless'))
    boundary.update(false)
    assert.equal(doc.documentElement.classList.contains('streamer-textless'), false)
    assert.equal(doc.querySelector('input')!.disabled, false)
  } finally { boundary.dispose(); dom.window.close() }
})

test('streamer suppresses and restores autocomplete for all editable form controls', async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<input autocomplete="email"><textarea autocomplete="on">original</textarea><select autocomplete="on"><option>original</option></select>'
  const controls = [...doc.querySelectorAll('input,textarea,select')]
  const before = controls.map(el => el.getAttribute('autocomplete'))
  try {
    boundary.update(true)
    for (const el of controls) assert.equal(el.getAttribute('autocomplete'), 'off', el.tagName)
    const late = doc.createElement('textarea'); late.setAttribute('autocomplete', 'on'); doc.body.appendChild(late)
    await flush()
    assert.equal(late.getAttribute('autocomplete'), 'off', 'new editors are protected')
    boundary.update(false)
    assert.deepEqual(controls.map(el => el.getAttribute('autocomplete')), before)
    assert.equal(late.getAttribute('autocomplete'), 'on')
    assert.equal(doc.querySelector('textarea')!.value, 'original')
  } finally { boundary.dispose(); dom.window.close() }
})

test('streamer cover and banner buttons use theme button colours instead of inherited white fill', () => {
  for (const theme of ['contrast-dark', 'contrast-light']) {
    const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc, () => {})
    doc.documentElement.classList.add(theme)
    doc.body.innerHTML = '<iframe></iframe>'
    try {
      boundary.update(true)
      const buttons = [...doc.querySelectorAll<HTMLButtonElement>('[data-streamer-ui] button')]
      assert.equal(buttons.length, 2)
      for (const button of buttons) {
        // jsdom cannot resolve var() through currentColor; assert the actual matched
        // CSS rule here. Real Chromium pixel contrast is an integration capture gate.
        const rules = [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules])
        const rule = rules.find(rule => 'selectorText' in rule && (rule as CSSStyleRule).selectorText === '[data-streamer-ui] button') as CSSStyleRule | undefined
        assert.ok(rule && button.matches(rule.selectorText), 'both controls have a dedicated theme rule')
        const css = rule.style
        assert.equal(css.getPropertyValue('-webkit-text-fill-color').toLowerCase(), 'currentcolor', `${theme}: ${button.textContent} uses its own colour`)
        assert.equal(css.color, 'var(--ink)', `${theme}: standard ink token`)
        assert.equal(css.getPropertyValue('background'), 'var(--input)', `${theme}: standard button surface token`)
      }
    } finally { boundary.dispose(); dom.window.close() }
  }
})
