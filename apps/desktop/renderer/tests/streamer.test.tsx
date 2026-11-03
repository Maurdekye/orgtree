import { JSDOM, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { sensitiveSpans, redactScreenText, knownScreenValues, nativeScreenText } from '../../../../packages/contracts/streamer'
import { installStreamerBoundary } from '../src/streamer-boundary'

const samples = [
  ['secret', 'password=short-private'], ['email', 'reader@example.test'],
  ['Windows path', 'C:\\Users\\private-reader\\project\\file.txt'], ['Unix path', '/home/private-reader/project/file.txt'],
  ['key', 'sk_test_abcdefghijklmnopqrstuvwxyz123456'], ['IPv4', '192.168.12.34'],
  ['IPv6', '2001:db8::1234'], ['account', 'Private Account'], ['hub address', '@net:private-reader.abc123'],
  ['phone', '+1 (415) 555-0123'], ['URL token', 'https://example.test/path?token=short-secret'],
  ['uncertain token', 'abCD0123456789efGH0123456789'],
  ['short path', '/tmp'], ['UNC share', '\\\\private-server\\share'], ['local phone', '5550123'], ['IPv6 loopback', '::1'],
] as const
const known = ['Private Account']
test('every sensitive category is hidden, safe prose remains, and the source is unchanged', () => {
  for (const [kind, value] of samples) {
    const text = `Before ${value} after`
    assert.ok(sensitiveSpans(text, known).length > 0, kind)
    assert.ok(!redactScreenText(text, known).includes(value), kind)
    assert.equal(text, `Before ${value} after`)
  }
  assert.equal(redactScreenText('Ready to review the draft.', known), 'Ready to review the draft.')
  const input = { accounts: [{ id: 'private-account', name: 'Private Account', label: 'Personal login', identity:{login:'private-login'}, credential: { path: '/home/reader/.config' } }], settings: { token: 'tiny-token', api_key:'small-key' } }
  const before = JSON.stringify(input), values = knownScreenValues(input)
  for (const value of ['private-account', 'Private Account', 'Personal login', '/home/reader/.config', 'tiny-token', 'small-key', 'private-login']) assert.ok(values.includes(value), value)
  assert.equal(JSON.stringify(input), before)
  assert.equal(nativeScreenText('reader@example.test', true), 'Hidden in Streamer mode')
  assert.equal(nativeScreenText('reader@example.test', false), 'reader@example.test')
})

function fixture(highlights = true) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  if (highlights) {
    Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
    Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...ranges: Range[]) { super(...ranges) } }, configurable: true })
  }
  return { dom, doc: dom.window.document, registry }
}
test('one boundary masks each category on canvas, desk, transcript, panel, popout and Markdown presentation without changing copy or links', () => {
  for (const surface of ['canvas', 'desk-body', 'msgs', 'panel', 'popout', 'markdown-presentation']) {
    const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
    try {
      const root = doc.createElement('div'); root.className = surface
      for (const [, value] of samples) { const p = doc.createElement('p'); p.textContent = value; root.appendChild(p) }
      const link = doc.createElement('a'); link.href = 'https://example.test/?token=original-token'; link.textContent = 'Open'; root.appendChild(link)
      const input = doc.createElement('input'); input.value = 'original-editor-secret'; root.appendChild(input)
      doc.body.appendChild(root)
      const original = root.textContent
      boundary.update(true, known)
      const ranges = registry.get('streamer-sensitive') ?? []
      for (const [kind, value] of samples) assert.ok(ranges.some(r => r.toString().includes(value)), `${surface}: ${kind}`)
      assert.equal(root.textContent, original, 'original DOM selection/copy text is intact')
      assert.equal(input.value, 'original-editor-secret')
      assert.equal(input.getAttribute('autocomplete'), 'off')
      assert.equal(input.disabled, false, 'privacy does not disable editors')
      assert.equal(link.getAttribute('href'), 'https://example.test/?token=original-token')
      boundary.update(false)
      assert.equal(registry.has('streamer-sensitive'), false)
      assert.equal(input.getAttribute('autocomplete'), null)
      assert.equal(root.textContent, original)
    } finally { boundary.dispose(); dom.window.close() }
  }
})
test('split text and live updates are masked; known-value updates apply without remounting', async () => {
  const { dom, doc, registry } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<p>reader@<b>example.test</b></p><p>Private Account</p>'
  try {
    boundary.update(true)
    assert.ok((registry.get('streamer-sensitive') ?? []).some(r => r.toString().includes('reader@example.test')))
    doc.body.querySelector('p')!.textContent = 'new@example.test'
    await flush()
    assert.ok((registry.get('streamer-sensitive') ?? []).some(r => r.toString().includes('new@example.test')))
    boundary.update(true, known)
    assert.ok((registry.get('streamer-sensitive') ?? []).some(r => r.toString().includes('Private Account')))
  } finally { boundary.dispose(); dom.window.close() }
})
test('opaque surfaces stay mounted, each cover dismisses independently and returns after toggle or reopen', async () => {
  const { dom, doc } = fixture(), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<iframe></iframe><img><video></video><canvas></canvas><object></object><embed><div class="md">Safe Markdown</div>'
  try {
    const original = [...doc.body.children]
    boundary.update(true, known)
    const covers = [...doc.querySelectorAll<HTMLButtonElement>('[data-streamer-dismiss]')]
    // five content surfaces; the <canvas> is app chrome (streamerblank.test.tsx)
    assert.equal(covers.length, 5)
    covers[0]!.click()
    assert.equal(doc.querySelectorAll('[data-streamer-revealed]').length, 1)
    assert.ok(original.every(el => el.isConnected), 'runtime DOM remains mounted')
    boundary.update(false); boundary.update(true, known)
    assert.equal(doc.querySelectorAll('[data-streamer-revealed]').length, 0)
    assert.equal(doc.querySelectorAll('[data-streamer-dismiss]').length, 5)
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
    boundary.update(true, known)
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
