// 4.5.5-alpha.2 over-masking (USER 2026-11-03 17:18Z m73a2e0a527ec "way too much is being hidden here in
// streamer mode"). Each ordinary surface from the user's screenshots must stay visible, and every real
// secret category must still be masked. Fixtures use the real API shapes (mail rows carry *_address with
// agent names; slugs, branches, SHAs and clock times are plain text).
import { JSDOM, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { sensitiveSpans, knownScreenValues } from '../../../../packages/contracts/streamer'
import { installStreamerBoundary } from '../src/streamer-boundary'

const masked = (text: string, known: readonly string[] = []) => sensitiveSpans(text, known).map(s => text.slice(s.start, s.end))
const SHA = 'e1de8636a62548949d84637477687bbcc024ffa0', SHA256 = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef'

const visible: [string, string][] = [
  ['agent name in a chart row', 'liaison-opus'], ['agent name', 'coordinator-opus'],
  ['mention chip (project path)', 'orgtree/build-slot'], ['mention chip (docket item)', '@item:orgtree/streamer-mode-hide-sensitive-information-in-the-u'],
  ['docket slug', 'streamer-mode-blanks-the-whole-window-in-4-5-5-a'],
  ['branch', 'integ/4.5.5'], ['branch with words', 'feature/fix-streamer-over-masking-4-5-5'],
  ['full commit SHA', SHA], ['SHA-256', SHA256], ['short SHA in prose', 'Commit bd44dbc5bed8 restarted'],
  ['message-header time', '19:19:15'], ['12-hour time', '7:19:15 PM'], ['time with zone', '19:19:15 GMT+2'],
  ['ISO timestamp', '2026-11-03T16:59:03.706Z'], ['date and time', '2026-11-03 18:59:03 GMT+2'],
  ['version', '4.5.5-alpha.2'], ['token counts', '~661t +341t'], ['queued line', '1 queued'],
  ['ordinary words after a slash', 'wait for and/or review, then merge'],
  ['camelCase identifier', 'getProviderLoginStatus'],
]
test('agent names, slugs, branches, SHAs, times, versions and chips are not masked by any pattern', () => {
  for (const [kind, value] of visible) {
    const text = `Backend ${value} Installed version: 4.5.5-alpha.2 notice`
    assert.deepEqual(masked(text), [], `${kind}: ${JSON.stringify(masked(text))}`)
  }
})
test('a slash path never swallows the ordinary words after it', () => {
  assert.deepEqual(masked('see /tmp after the merge and then more words'), ['/tmp'])
  assert.deepEqual(masked('open /Users/John Smith/Desktop/notes.txt then close'), ['/Users/John Smith/Desktop/notes.txt'])
})

const secrets: [string, string][] = [
  ['unix path', '/home/reader/project/file.txt'], ['home path', '~/work/notes'], ['single-segment path', '/tmp'],
  ['windows path', 'C:\\Users\\reader\\file.txt'], ['email', 'reader@example.test'], ['ipv4', '192.168.12.34'],
  ['ipv6', '2001:db8::1234'], ['ipv6 full', '2001:0db8:85a3:0000:0000:8a2e:0370:7334'], ['ipv6 loopback', '::1'], ['ipv6 zone', 'fe80::1%eth0'],
  ['phone plus', '+1 (415) 555-0123'], ['phone intl', '+44 20 7946 0958'], ['phone dashes', '415-555-0123'], ['phone dots', '415.555.0123'], ['phone local', '555-0123'], ['local digits', '5550123'],
  ['sk key', 'sk_test_abcdefghijklmnopqrstuvwxyz123456'], ['gh token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['mixed token', 'abCD0123456789efGH0123456789'], ['base64', 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg=='], ['uuid', '3f2b8c1e-9d4a-4e7b-8a61-5c0d2f9b7e14'],
  ['letters-only random', 'XkQmPzRtLvWbNcJhYdFgSa'], ['hub address', '@net:private-reader.abc123'],
  ['labelled secret', 'password=short-private'], ['bearer', 'Bearer abc.def'], ['url token', 'https://example.test/p?token=short-secret'],
]
test('every real secret category is still masked', () => {
  for (const [kind, value] of secrets) {
    const text = `Before ${value} after`, spans = masked(text)
    assert.ok(spans.some(m => (/labelled|url/.test(kind) && m.includes(value)) || m === value || (value.startsWith(m) && m.length >= value.length - 2)), `${kind}: ${JSON.stringify(spans)}`)
    if (!/labelled|bearer|url/.test(kind)) assert.ok(!spans.join('|').includes('after'), `${kind} ate the trailing word: ${JSON.stringify(spans)}`)
  }
})

test('mail and connection rows: agent addresses are not learned as identities, real addresses and keys still are', () => {
  const known = knownScreenValues({
    mail: [{ from_address: 'liaison-opus', to_address: 'coordinator-opus', path: 'orgtree', key: 'build-slot' }],
    connections: [{ address: 'build-sol' }, { address: 'maurdekye.77ded7' }],
    accounts: [{ id: 'claude-5', email: 'owner@example.test', credential: { path: '/home/reader/.config' } }],
    settings: { api_key: 'live-secret-value' },
  })
  for (const name of ['liaison-opus', 'coordinator-opus', 'orgtree', 'build-slot', 'build-sol']) assert.ok(!known.includes(name), `${name} was learned: ${JSON.stringify(known)}`)
  for (const v of ['maurdekye.77ded7', 'claude-5', 'owner@example.test', '/home/reader/.config', 'live-secret-value']) assert.ok(known.includes(v), `${v} is still learned`)
  const text = 'liaison-opus wrote to coordinator-opus; sol replied. claude-5 by owner@example.test'
  const m = masked(text, known)
  assert.ok(!m.some(x => /opus/.test(x)), JSON.stringify(m))
  assert.ok(m.includes('owner@example.test') && m.some(x => x.includes('claude-5')))
})
test('a known identity matches whole words only ("Con" never masks the start of "Context")', () => {
  assert.deepEqual(masked('Context and Contents', ['Con']), [])
  assert.deepEqual(masked('Signed in as Con, ok', ['Con']), ['Con'])
  assert.deepEqual(masked('Private Account 2', ['Private Account']), ['Private Account'])
})

test('the DOM boundary leaves the screenshot surfaces visible and masks only a real secret beside them', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  const doc = dom.window.document, boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = `<div class="row"><span>liaison-opus</span> <span>idle 4m ago</span></div>
    <div class="queued">1 queued <span class="chip">orgtree/build-slot</span> <span class="chip">integ/4.5.5</span></div>
    <div class="msg"><b>Backend</b> <time>19:19:15 GMT+2</time> Installed version: 4.5.5-alpha.2 commit ${SHA} started 2026-11-03T16:59:03.706Z</div>
    <div class="msg">mail me at reader@example.test or /home/reader/x</div>`
  try {
    boundary.update(true, [])
    await flush()
    const hidden = Array.from(registry.get('streamer-sensitive') ?? [], r => r.toString())
    assert.deepEqual(hidden.sort(), ['/home/reader/x', 'reader@example.test'].sort())
  } finally { boundary.dispose(); dom.window.close() }
})
