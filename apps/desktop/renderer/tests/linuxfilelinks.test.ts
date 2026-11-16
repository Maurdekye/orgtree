// linuxfilelinks.test.ts — Markdown links to absolute POSIX files on Linux and macOS.
//
// USER 2026-11-16 md4343645e6d2 (@item:orgtree/linux-clicking-a-file-link-opens-the-browser-at-h): on Linux a file
// link opened the browser at http://127.0.0.1:<engine port>/home/…, because only Windows paths were recognised and a
// path-absolute href resolves against the app's own origin. Now an absolute POSIX path or a file:/// URL is a local
// file link off Windows (data-local-path, href "#", click reveals), Windows behaviour is unchanged, and a link to the
// engine's own origin never goes to the browser.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs linuxfilelinks

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { md, setLinkPlatformForTests, posixFilePath } from '../src/canvas/shared'
import { opensInBrowser } from '../../main/policy'

const parse = (src: string): Element | null => {
  const host = document.createElement('div')
  host.innerHTML = md(src).__html
  return host.querySelector('a')
}
const on = (platform: string | null) => { setLinkPlatformForTests(platform) }

test('§1 Linux: an absolute path in angle brackets is a local file link', () => {
  on('Linux x86_64')
  try {
    const a = parse('[notes](</home/u/My Docs/a b.md>)')
    assert.ok(a, 'no anchor')
    assert.equal(a!.getAttribute('data-local-path'), '/home/u/My Docs/a b.md')
    assert.equal(a!.getAttribute('href'), '#')
    assert.ok(a!.classList.contains('local-file'))
    assert.match(a!.getAttribute('title') ?? '', /Show in folder/)
  } finally { on(null) }
})

test('§2 Linux: a bare absolute path destination works too', () => {
  on('Linux x86_64')
  try {
    const a = parse('[f](/home/u/f.md)')
    assert.equal(a!.getAttribute('data-local-path'), '/home/u/f.md')
    assert.equal(a!.getAttribute('href'), '#')
  } finally { on(null) }
})

test('§3 macOS: /Users/… is a local file link', () => {
  on('MacIntel')
  try {
    assert.equal(parse('[f](</Users/n/Desktop/x.pdf>)')!.getAttribute('data-local-path'), '/Users/n/Desktop/x.pdf')
  } finally { on(null) }
})

test('§4 Linux: file:/// URLs become local file links, percent-escapes decoded', () => {
  on('Linux x86_64')
  try {
    const a = parse('[f](file:///home/u/a%20b.md)')
    assert.ok(a, 'no anchor')
    assert.equal(a!.getAttribute('data-local-path'), '/home/u/a b.md')
    assert.equal(a!.getAttribute('href'), '#')
  } finally { on(null) }
})

test('§5 the app’s own routes and engine space are not files', () => {
  on('Linux x86_64')
  try {
    for (const route of ['/', '/index.html', '/o/alpha', '/api/orgs/x']) {
      assert.equal(posixFilePath(route), null, route)
    }
    assert.equal(parse('[o](</o/alpha>)')?.getAttribute('data-local-path') ?? null, null)
    assert.equal(posixFilePath('//host/share'), null, 'a network-path reference is not a local file')
  } finally { on(null) }
})

test('§6 relative links and http(s) links are unchanged', () => {
  on('Linux x86_64')
  try {
    const rel = parse('[r](docs/readme.md)')
    assert.equal(rel!.getAttribute('data-local-path'), null)
    assert.equal(rel!.getAttribute('href'), 'docs/readme.md')
    const web = parse('[w](https://example.com/a/b)')
    assert.equal(web!.getAttribute('data-local-path'), null)
    assert.equal(web!.getAttribute('href'), 'https://example.com/a/b')
  } finally { on(null) }
})

test('§7 Windows: a POSIX-looking path stays exactly as written, and drive paths still work', () => {
  on('Win32')
  try {
    assert.equal(posixFilePath('/home/u/f.md'), null)
    assert.equal(parse('[f](</home/u/f.md>)')!.getAttribute('data-local-path'), null)
    assert.equal(parse(String.raw`[f](<C:\Users\ncola\a b.exe>)`)!.getAttribute('data-local-path'), String.raw`C:\Users\ncola\a b.exe`)
  } finally { on(null) }
})

test('§8 Linux: Windows drive links keep working (unchanged)', () => {
  on('Linux x86_64')
  try {
    assert.equal(parse(String.raw`[f](<C:\Users\ncola\a b.exe>)`)!.getAttribute('data-local-path'), String.raw`C:\Users\ncola\a b.exe`)
  } finally { on(null) }
})

test('§9 GUARD: the engine’s own origin never goes to the browser; other http(s) still does', () => {
  const origin = 'http://127.0.0.1:28159'
  assert.equal(opensInBrowser('http://127.0.0.1:28159/home/u/x.md', origin), false)
  assert.equal(opensInBrowser('http://127.0.0.1:28159/', origin), false)
  assert.equal(opensInBrowser('https://example.com/x', origin), true)
  assert.equal(opensInBrowser('http://127.0.0.1:9999/x', origin), true, 'another port is someone else’s server')
  assert.equal(opensInBrowser('file:///home/u/x', origin), false)
})
