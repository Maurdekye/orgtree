// windowslinks.test.ts — Markdown links to absolute WINDOWS files.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs windowslinks
//
// THE BUG THIS PINS. The user wrote a link to a real file and the chat showed
// the raw markdown instead of a link:
//
//   [Orgtree Setup 2.1.2-3.exe](<C:\Users\…\Orgtree Setup 2.1.2-3.exe>)
//   [Orgtree Setup 2.1.2-3.exe](</C:/Users/…/Orgtree Setup 2.1.2-3.exe>)
//
// Both failed for ONE reason, and it is not the drive letter: `escapeAngles`
// (№16, which stops a bare `<Token>` in prose being eaten as an HTML tag) also
// escaped the `<` that OPENS a CommonMark angle-bracket link destination. Once
// `](<` became `](&lt;`, the destination was no longer a destination.
//
// ⚠ WHY THE ANGLE BRACKETS CANNOT SIMPLY BE DROPPED, which is the obvious
// "fix" and is wrong: an UNBRACKETED destination may not contain spaces, and
// every path in the report has them ("Orgtree v2", "Orgtree Setup 2.1.2-3.exe").
// §4 pins that, so nobody later "simplifies" the syntax back into a form that
// cannot parse.
//
// ⚠ SCOPE OF THIS FILE, STATED SO IT IS NOT MISREAD AS MORE THAN IT IS. These
// checks cover PARSING — whether the anchor forms at all. They do NOT claim a
// working link end to end: the backslash form still loses its href to
// DOMPurify's unknown-scheme rule (§3 pins that as a KNOWN GAP rather than
// hiding it), and clicking is not wired to anything yet. Those are the
// remaining halves of the ticket.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { md } from '../src/canvas/shared'

// String.raw so the backslashes are literal and survive every layer between
// here and the parser — a doubled-escape here would silently test a path that
// is not the one the user wrote.
const WIN = String.raw`C:\Users\ncola_k8bx\AppData\Roaming\Orgtree v2\data\scratch\orgtree\release-command\outbox\Orgtree Setup 2.1.2-3.exe`
const FWD = '/C:/Users/ncola_k8bx/AppData/Roaming/Orgtree v2/data/scratch/orgtree/release-command/outbox/Orgtree Setup 2.1.2-3.exe'

const anchorHref = (html: string): string | null => {
  const m = /<a[^>]*\shref="([^"]*)"/.exec(html)
  return m ? m[1]! : null
}

test('§1 ⭐ the reported forward-slash form renders as a real link', () => {
  const html = md(`[Orgtree Setup 2.1.2-3.exe](<${FWD}>)`).__html
  // ⚠ THE ASSERTION THAT CATCHES THE BUG. Before the fix this was
  // `<p>[Orgtree Setup 2.1.2-3.exe](&lt;/C:/Users/…&gt;)</p>` — the label and
  // the raw target, exactly what the user photographed.
  assert.ok(!html.includes('&lt;/C:'), `the opening < was escaped: ${html}`)
  assert.ok(!html.includes('](' ), `raw markdown survived into the output: ${html}`)
  const href = anchorHref(html)
  assert.ok(href, `no anchor was produced: ${html}`)
  // the exact intended target, spaces percent-encoded by marked and nothing else
  assert.equal(decodeURIComponent(href!), FWD)
})

test('§2 ⭐ the reported backslash form now PARSES as an anchor', () => {
  const html = md(`[Orgtree Setup 2.1.2-3.exe](<${WIN}>)`).__html
  // Before the fix the whole construct stayed literal text. It is now an
  // anchor element — the parse half of the bug is closed.
  assert.ok(!html.includes('&lt;C:'), `the opening < was escaped: ${html}`)
  assert.ok(/<a[\s>]/.test(html), `no anchor element was produced: ${html}`)
  assert.ok(html.includes('Orgtree Setup 2.1.2-3.exe'), `label lost: ${html}`)
})

test('§3 KNOWN GAP, pinned deliberately: DOMPurify drops the C:\\ href', () => {
  const html = md(`[Setup](<${WIN}>)`).__html
  // ⚠ THIS TEST ASSERTS THE BUG THAT IS STILL OPEN, on purpose. `C:` reads as
  // an unknown URI scheme to DOMPurify's default ALLOWED_URI_REGEXP, so the
  // anchor survives and its href does not. Recording it as a passing test of
  // the CURRENT state means the day it is fixed this file fails loudly and
  // whoever fixes it must come here and say so, rather than the gap being
  // quietly carried as "works now". §1's form is unaffected: a leading `/`
  // passes the same regexp, which is why one reported form is further along
  // than the other.
  assert.equal(anchorHref(html), null,
    'the C:\\ href now survives — good news: update §3 and §2 to assert it')
})

test('§4 an unbracketed destination with spaces cannot parse — the angle form is required', () => {
  const html = md(`[Setup](${WIN})`).__html
  // Not a defect and not something to "fix": CommonMark forbids spaces in a
  // bare destination. It is pinned so that no later change removes the angle
  // handling on the theory that plain paths would do just as well.
  assert.equal(anchorHref(html), null, `unexpectedly parsed: ${html}`)
})

test('§5 ⭐ NEGATIVE CONTROL — №16 still holds: a bare <Token> in prose is escaped', () => {
  // The reason `escapeAngles` exists. If the fix had spared every `<`, this
  // sentence would lose `<float3>` to the sanitizer and change meaning.
  const html = md('Sync<float3> is a type').__html
  assert.ok(html.includes('&lt;float3&gt;') || html.includes('Sync&lt;float3'),
    `the angle token was not escaped: ${html}`)
  assert.ok(html.includes('float3'), `the token was eaten entirely: ${html}`)
})

test('§6 ⭐ NEGATIVE CONTROL — a tag in prose is NOT un-escaped by the link rule', () => {
  // ⚠ THE SAFETY PROPERTY OF REQUIRING THE CLOSING `)`. A pattern matching a
  // bare `](<` would have spared this `<script>` too, handing an
  // author-controlled tag back to the parser. It must stay escaped text.
  const html = md('see ](<script>alert(1)</script>) here').__html
  assert.ok(!/<script/i.test(html), `a script tag reached the output: ${html}`)
  assert.ok(html.includes('&lt;script'), `the tag was not escaped: ${html}`)
})

test('§7 existing link kinds are untouched', () => {
  assert.equal(anchorHref(md('[web](https://example.com/a%20b)').__html),
    'https://example.com/a%20b')
  assert.equal(anchorHref(md('[rel](docs/readme.md)').__html), 'docs/readme.md')
  assert.equal(anchorHref(md('[anchor](#section)').__html), '#section')
  assert.equal(anchorHref(md('[posix](</usr/local/share/a b.txt>)').__html),
    '/usr/local/share/a%20b.txt')
  // a relative image still resolves as an image, not a link
  assert.ok(md('![](outbox/plot.png)').__html.includes('<img'))
})

test('§8 an angle destination inside a code fence stays literal', () => {
  // fenced code is quoted, not parsed — the fix must not reach into it
  const html = md('```\n[x](<' + WIN + '>)\n```').__html
  assert.ok(html.includes('<code'), `not rendered as code: ${html}`)
  assert.ok(!/<a[\s>]/.test(html), `a link was built inside a fence: ${html}`)
})
