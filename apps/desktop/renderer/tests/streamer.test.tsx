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
  const input = { accounts: [{ id: 'private-account', name: 'Private Account', label: 'Personal login', credential: { path: '/home/reader/.config' } }], settings: { token: 'tiny-token' } }
  const before = JSON.stringify(input), values = knownScreenValues(input)
  for (const value of ['private-account', 'Private Account', 'Personal login', '/home/reader/.config', 'tiny-token']) assert.ok(values.includes(value), value)
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
    assert.equal(covers.length, 6)
    covers[0]!.click()
    assert.equal(doc.querySelectorAll('[data-streamer-revealed]').length, 1)
    assert.ok(original.every(el => el.isConnected), 'runtime DOM remains mounted')
    boundary.update(false); boundary.update(true, known)
    assert.equal(doc.querySelectorAll('[data-streamer-revealed]').length, 0)
    assert.equal(doc.querySelectorAll('[data-streamer-dismiss]').length, 6)
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
test('unknown readiness or unavailable masking fails closed; native picker values are not changed', () => {
  const { dom, doc } = fixture(false), boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = '<div id="root">reader@example.test</div><input type="file">'
  try {
    boundary.update(true, known)
    assert.ok(doc.documentElement.classList.contains('streamer-covered'))
    boundary.update(false)
    assert.equal(doc.documentElement.classList.contains('streamer-covered'), false)
    assert.equal(doc.querySelector('input')!.disabled, false)
  } finally { boundary.dispose(); dom.window.close() }
})
