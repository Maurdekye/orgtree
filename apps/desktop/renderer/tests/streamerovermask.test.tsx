// 4.5.5-alpha.2 over-masking (USER 2026-11-03 m73a2e0a527ec "way too much is being hidden here in streamer mode") under the
// DEFINITIVE list (m63438d6bebc3): only the listed types are ever blurred; every element from the user's three screenshots
// stays visible, with EVERY switch on. Positives: samples per type in free-form text.
import { JSDOM, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { sensitiveSpans, tokenLike, type StreamerTypes } from '../../../../packages/contracts/streamer'
import { installStreamerBoundary } from '../src/streamer-boundary'

const ON: StreamerTypes = { paths: true, ips: true, emails: true, secrets: true, phones: true, tokenUrls: true, externals: true, orgs: true }
const OFF: StreamerTypes = { paths: false, ips: false, emails: false, secrets: false, phones: false, tokenUrls: false, externals: false, orgs: false }
const masked = (text: string, types: StreamerTypes = ON) => sensitiveSpans(text, types).map(s => text.slice(s.start, s.end))
const SHA = 'e1de8636a62548949d84637477687bbcc024ffa0', SHA256 = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef'

const visible: [string, string][] = [
  ['agent name in a chart row', 'liaison-opus'], ['agent name', 'coordinator-opus'], ['agent name', 'build-sol'],
  ['account selector', 'claude/primary'], ['account id', 'claude-5'], ['model name', 'claude-opus-5-5'], ['chip', '@build-slot'],
  ['mention chip (project path)', 'orgtree/build-slot'], ['mention chip (docket item)', '@item:orgtree/streamer-mode-hide-sensitive-information-in-the-u'],
  ['docket slug', 'streamer-mode-blanks-the-whole-window-in-4-5-5-a'], ['relative path', 'apps/desktop/renderer/src/streamer.ts'], ['repo-relative path', 'docs/agents/streamer-mode.md'],
  ['branch', 'integ/4.5.5'], ['branch with words', 'feature/fix-streamer-over-masking-4-5-5'],
  ['full commit SHA', SHA], ['SHA-256', SHA256], ['short SHA in prose', 'Commit bd44dbc5bed8 restarted'],
  ['message-header time', '19:19:15'], ['12-hour time', '7:19:15 PM'], ['time with zone', '19:19:15 GMT+2'],
  ['ISO timestamp', '2026-11-03T16:59:03.706Z'], ['date and time', '2026-11-03 18:59:03 GMT+2'], ['epoch', '1762189200'],
  ['version', '4.5.5-alpha.2'], ['four-part version', 'v4.5.5.2'], ['token counts', '~661t +341t'], ['queued line', '1 queued'],
  ['PID', 'PID: 15532'], ['plain URL', 'https://github.com/Maurdekye/orgtree/issues/12'], ['plain URL with query', 'https://example.test/search?q=streamer&page=2'],
  ['ordinary words after a slash', 'wait for and/or review, then merge'], ['camelCase identifier', 'getProviderLoginStatus'],
  ['collapsed row', 'Con'], ['restart notice', 'Orgtree 4.5.5-alpha.2 restarted. Commit: ' + SHA + '. Started at: 2026-11-03T16:59:03.706Z'],
]
test('agent names, account names, chips, timestamps, SHAs, branches, versions, relative paths and plain URLs are never blurred (every switch on)', () => {
  for (const [kind, value] of visible) {
    const text = `Backend ${value} Installed version: 4.5.5-alpha.2 notice`
    assert.deepEqual(masked(text), [], `${kind}: ${JSON.stringify(masked(text))}`)
  }
})

const positives: [keyof StreamerTypes, string, string][] = [
  ['paths', 'drive path', 'C:\\Users\\reader\\project\\file.txt'], ['paths', 'drive path with spaces', 'C:\\Users\\John Smith\\Desktop\\notes.txt'],
  ['paths', 'forward-slash drive', 'C:/Users/reader/file.txt'], ['paths', 'UNC', '\\\\private-server\\share\\x.txt'], ['paths', 'msys', '/c/Users/reader/code'], ['paths', 'unix home', '/home/reader/project/file.txt'],
  ['ips', 'ipv4', '192.168.12.34'], ['ips', 'ipv4 port', '10.0.0.5:8080'], ['ips', 'ipv6', '2001:db8::1234'], ['ips', 'ipv6 full', '2001:0db8:85a3:0000:0000:8a2e:0370:7334'], ['ips', 'loopback', '::1'], ['ips', 'zone', 'fe80::1%eth0'],
  ['emails', 'email', 'reader@example.test'],
  ['secrets', 'password=', 'password=short-private'], ['secrets', 'token=', 'token=abc123'], ['secrets', 'api_key', 'api_key=k3Y9'], ['secrets', 'bearer', 'Bearer abc.def-ghi'], ['secrets', 'sk key', 'sk_test_abcdefghijklmnopqrstuvwxyz123456'],
  ['secrets', 'gh token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'], ['secrets', 'mixed random', 'abCD0123456789efGH0123456789'], ['secrets', 'base64', 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZg'],
  ['secrets', 'private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'],
  ['phones', '+ intl', '+44 20 7946 0958'], ['phones', 'paren', '+1 (415) 555-0123'], ['phones', 'dashes', '415-555-0123'], ['phones', 'dots', '415.555.0123'], ['phones', 'local', '555-0123'],
  ['tokenUrls', 'token query', 'https://example.test/p?token=short-secret'], ['tokenUrls', 'sig', 'https://cdn.example.test/f.png?x=1&sig=abc123'], ['tokenUrls', 'fragment', 'https://app.example.test/#access_token=zzz'],
  ['tokenUrls', 'userinfo', 'https://user:pass@example.test/repo'], ['tokenUrls', 'invite', 'https://discord.example.test/invite/AbC12'], ['tokenUrls', 'magic', 'https://app.example.test/magic/abc'],
  ['externals', 'net', '@net:private-reader.abc123'], ['externals', 'org', '@org:other-org'],
]
test('every type has positive samples in free-form text; each is hidden only by its own switch', () => {
  for (const [type, kind, value] of positives) {
    const text = `Before ${value} after`
    const on = masked(text, { ...OFF, [type]: true })
    assert.ok(on.some(m => m.includes(value) || (value.startsWith(m) && m.length >= value.length - 2)), `${type}/${kind}: ${JSON.stringify(on)}`)
    assert.deepEqual(masked(text, OFF), [], `${kind} with every switch off`)
  }
})
test('a plain URL and a relative path next to a token URL are not swallowed; tokenLike skips SHAs and slugs', () => {
  assert.deepEqual(masked('see https://github.com/x/y and https://a.test/?token=zz then apps/desktop/x.ts'), ['https://a.test/?token=zz'])
  assert.equal(tokenLike(SHA), false); assert.equal(tokenLike('streamer-mode-blanks-the-whole-window-in-4-5-5-a'), false); assert.equal(tokenLike('abCD0123456789efGH0123456789'), true)
})
test('a Windows path stops at the last segment; a labelled secret is one token, not the rest of the line', () => {
  assert.deepEqual(masked('open C:\\Users\\reader\\notes.txt then close'), ['C:\\Users\\reader\\notes.txt'])
  assert.deepEqual(masked('password=hunter2 and the rest stays'), ['password=hunter2'])
})

test('the DOM boundary leaves the screenshot surfaces visible with every switch on, and blurs only real secrets in free-form text', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const registry = new Map<string, Range[]>()
  Object.defineProperty(dom.window, 'CSS', { value: { highlights: registry }, configurable: true })
  Object.defineProperty(dom.window, 'Highlight', { value: class extends Array<Range> { constructor(...r: Range[]) { super(...r) } }, configurable: true })
  const doc = dom.window.document, boundary = installStreamerBoundary(doc)
  doc.body.innerHTML = `<div class="row"><span>liaison-opus</span> <span>idle 4m ago</span> <span>claude/primary</span> <span>reader@example.test</span></div>
    <div class="queued">1 queued <span class="chip">orgtree/build-slot</span> <span class="chip">integ/4.5.5</span></div>
    <div class="msg sys"><b>Backend</b> <time>19:19:15 GMT+2</time> Installed version: 4.5.5-alpha.2 commit ${SHA} started 2026-11-03T16:59:03.706Z</div>
    <div class="msg"><details><summary>Con</summary></details> mail me at reader@example.test or password=k3Y9</div>`
  try {
    boundary.update(true, { types: ON, cover: true })
    await flush()
    const hidden = Array.from(registry.get('streamer-sensitive') ?? [], r => r.toString())
    assert.deepEqual(hidden.sort(), ['password=k3Y9', 'reader@example.test'].sort(), 'the structured chart-row email is NOT blurred; the free-form one is')
  } finally { boundary.dispose(); dom.window.close() }
})
