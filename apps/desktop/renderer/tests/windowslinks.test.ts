// windowslinks.test.ts — Markdown links to absolute WINDOWS files: parsing,
// normalization, the rendered anchor, and what a click does.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs windowslinks
//
// THE BUG. The user wrote a link to a real file and chat showed the raw
// markdown instead of a link, in both of these forms:
//
//   [Orgtree Setup 2.1.2-3.exe](<C:\Users\…\Orgtree Setup 2.1.2-3.exe>)
//   [Orgtree Setup 2.1.2-3.exe](</C:/Users/…/Orgtree Setup 2.1.2-3.exe>)
//
// Both failed for ONE reason, and it is not the drive letter: `escapeAngles`
// (№16, which stops a bare `<Token>` in prose being eaten as an HTML tag) also
// escaped the `<` that OPENS a CommonMark angle-bracket link destination. Once
// `](<` became `](&lt;`, the destination was no longer a destination.
//
// A SECOND, INDEPENDENT BARRIER sat behind it: DOMPurify destroys
// `href="C:\…"`, because `C:` reads as an unknown URI scheme — the anchor
// survives and its href does not. That is why the two reported forms were not
// equally broken underneath, and why the fix normalizes to the leading-slash
// form the sanitizer already accepts instead of configuring the sanitizer.
//
// ⚠ WHY THE ANGLE BRACKETS CANNOT SIMPLY BE DROPPED, which is the obvious
// "fix" and is wrong: an UNBRACKETED destination may not contain spaces, and
// every path in the report has them ("Orgtree v2", "Orgtree Setup 2.1.2-3.exe").
// §5 pins that, so nobody later "simplifies" the syntax into a form that
// cannot parse at all.

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { md, winFileHref, winFilePath, revealFileFromEvent } from '../src/canvas/shared'

// String.raw so the backslashes are literal and survive every layer between
// here and the parser — a doubled escape here would silently test a path that
// is not the one the user wrote.
const WIN = String.raw`C:\Users\ncola_k8bx\AppData\Roaming\Orgtree v2\data\scratch\orgtree\release-command\outbox\Orgtree Setup 2.1.2-3.exe`
const FWD = '/C:/Users/ncola_k8bx/AppData/Roaming/Orgtree v2/data/scratch/orgtree/release-command/outbox/Orgtree Setup 2.1.2-3.exe'

const parse = (src: string): Element | null => {
  const host = document.createElement('div')
  host.innerHTML = md(src).__html
  return host.querySelector('a')
}
const localPath = (src: string) => parse(src)?.getAttribute('data-local-path') ?? null

test('§1 ⭐ the reported backslash form becomes a link carrying the exact path', () => {
  const a = parse(`[Orgtree Setup 2.1.2-3.exe](<${WIN}>)`)
  // ⚠ THE ASSERTION THAT CATCHES THE ORIGINAL BUG. Before the fix the whole
  // construct stayed literal text — the label and the raw target, exactly what
  // the user photographed.
  assert.ok(a, 'no anchor was produced')
  assert.equal(a!.textContent, 'Orgtree Setup 2.1.2-3.exe')
  // the EXACT native path, spaces and all, unchanged from what was written
  assert.equal(a!.getAttribute('data-local-path'), WIN)
})

test('§2 ⭐ the reported forward-slash form does too', () => {
  const a = parse(`[Orgtree Setup 2.1.2-3.exe](<${FWD}>)`)
  assert.ok(a, 'no anchor was produced')
  assert.equal(a!.getAttribute('data-local-path'), WIN)
})

test('§3 ⭐ both reported forms normalize to the SAME exact target', () => {
  // acceptance condition 2: documented and practical forms reach one target.
  //
  // ⚠ THE NON-NULL ASSERTION IS LOAD-BEARING, and this test did not have it
  // at first. Comparing the two results alone passes vacuously against the
  // BROKEN renderer, where both are null — `null === null` is agreement that
  // neither form works. The mutation run caught that; it is checked here so
  // the comparison can only pass when both forms actually resolved.
  const back = localPath(`[a](<${WIN}>)`)
  const fwd = localPath(`[a](<${FWD}>)`)
  const slash = localPath(`[a](<${WIN.replace(/\\/g, '/')}>)`)
  assert.equal(back, WIN)
  assert.equal(fwd, WIN)
  assert.equal(slash, WIN)
})

test('§4 ⭐ the href is NEUTRALIZED so a click cannot navigate the app away', () => {
  const a = parse(`[a](<${WIN}>)`)
  // ⚠ WHY THIS MATTERS. The normalized destination `/C:/…` is a path-absolute
  // URL. Left in the href, clicking would navigate the SPA to `<origin>/C:/…`
  // and walk the app off its own route — a worse outcome than the literal text
  // this feature set out to fix.
  assert.equal(a!.getAttribute('href'), '#')
  assert.ok(!/\/C:/.test(a!.getAttribute('href') ?? ''))
})

test('§5 an unbracketed destination WITH spaces cannot parse — the angle form is required', () => {
  // Not a defect and not something to "fix": CommonMark forbids spaces in a
  // bare destination. Pinned so no later change drops the angle handling on
  // the theory that plain paths would do just as well.
  assert.equal(parse(`[Setup](${WIN})`), null)
})

test('§6 an unbracketed destination WITHOUT spaces is still accepted', () => {
  // the practical form agents actually write for a short path
  assert.equal(localPath(String.raw`[cfg](C:\tools\app.cfg)`), String.raw`C:\tools\app.cfg`)
  assert.equal(localPath('[cfg](C:/tools/app.cfg)'), String.raw`C:\tools\app.cfg`)
})

test('§7 ⭐ NEGATIVE CONTROL — №16 still holds: a bare <Token> in prose is escaped', () => {
  // The reason `escapeAngles` exists. If the fix had spared every `<`, this
  // sentence would lose `<float3>` to the sanitizer and change meaning.
  const html = md('Sync<float3> is a type').__html
  assert.ok(html.includes('&lt;float3&gt;') || html.includes('Sync&lt;float3'),
    `the angle token was not escaped: ${html}`)
  assert.ok(html.includes('float3'), `the token was eaten entirely: ${html}`)
})

test('§8 ⭐ NEGATIVE CONTROL — a tag in prose is NOT un-escaped by the link rule', () => {
  // ⚠ THE SAFETY PROPERTY OF SPELLING OUT WHAT MAY FOLLOW THE `>`. A looser
  // pattern spared this `<script>` too, handing an author-controlled tag back
  // to the parser — and the sanitizer then deleted the tag AND its text. This
  // check is what caught that during development; it is not decoration.
  const html = md('see ](<script>alert(1)</script>) here').__html
  assert.ok(!/<script/i.test(html), `a script tag reached the output: ${html}`)
  assert.ok(html.includes('&lt;script'), `the tag was not escaped: ${html}`)
})

test('§9 ⭐ unsupported and dangerous schemes never become local-file links', () => {
  for (const src of [
    '[x](javascript:alert(1))',
    '[x](data:text/html,<b>hi</b>)',
    '[x](file:///C:/Windows/System32/cmd.exe)',
    '[x](vbscript:msgbox)',
    String.raw`[x](\\evil-server\share\payload.exe)`,
  ]) {
    const a = parse(src)
    assert.equal(a?.getAttribute('data-local-path') ?? null, null,
      `${src} was turned into a local-file link`)
    assert.ok(!/javascript:|vbscript:|^data:/i.test(a?.getAttribute('href') ?? ''),
      `${src} kept a dangerous href`)
  }
})

test('§10 existing link kinds are untouched', () => {
  const href = (s: string) => parse(s)?.getAttribute('href') ?? null
  assert.equal(href('[web](https://example.com/a%20b)'), 'https://example.com/a%20b')
  assert.equal(href('[rel](docs/readme.md)'), 'docs/readme.md')
  assert.equal(href('[anchor](#section)'), '#section')
  // a POSIX absolute path keeps its own href and is NOT claimed as a Windows file
  assert.equal(href('[posix](</usr/local/share/a b.txt>)'), '/usr/local/share/a%20b.txt')
  assert.equal(localPath('[posix](</usr/local/share/a b.txt>)'), null)
  assert.ok(md('![](outbox/plot.png)').__html.includes('<img'))
})

test('§11 an angle destination inside a code fence stays literal', () => {
  const html = md('```\n[x](<' + WIN + '>)\n```').__html
  assert.ok(html.includes('<code'), `not rendered as code: ${html}`)
  assert.ok(!/<a[\s>]/.test(html), `a link was built inside a fence: ${html}`)
})

test('§12 ⭐ clicking REVEALS the file and cancels the navigation', () => {
  const host = document.createElement('div')
  host.innerHTML = md(`[Setup](<${WIN}>)`).__html
  document.body.appendChild(host)
  const anchor = host.querySelector('a')!

  const revealed: string[] = []
  let prevented = 0
  ;(window as unknown as { orgtreeDesktop: unknown }).orgtreeDesktop = {
    revealFile: (p: string) => { revealed.push(p); return Promise.resolve({ ok: true }) },
  }

  const handled = revealFileFromEvent({
    target: anchor, preventDefault: () => { prevented++ },
  })

  assert.equal(handled, true, 'the click was not handled')
  // ⚠ THE EXACT NATIVE PATH, not the normalized href. This is the assertion
  // that proves the round trip: what the author wrote is what Explorer is
  // asked to select.
  assert.deepEqual(revealed, [WIN])
  assert.equal(prevented, 1, 'the anchor navigation was not cancelled')
  document.body.removeChild(host)
  delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
})

test('§13 a click somewhere else is left entirely alone', () => {
  const host = document.createElement('div')
  host.innerHTML = md('[web](https://example.com/)').__html
  const anchor = host.querySelector('a')!
  let prevented = 0
  const handled = revealFileFromEvent({
    target: anchor, preventDefault: () => { prevented++ },
  })
  // an ordinary web link must keep its normal behaviour — Electron's existing
  // will-navigate route is what opens it, and cancelling here would break it
  assert.equal(handled, false)
  assert.equal(prevented, 0)
})

test('§14 a missing native bridge is survivable, not a thrown click handler', () => {
  const host = document.createElement('div')
  host.innerHTML = md(`[Setup](<${WIN}>)`).__html
  delete (window as unknown as { orgtreeDesktop?: unknown }).orgtreeDesktop
  // browser/kiosk, or a portal that never received a bridge
  assert.doesNotThrow(() => revealFileFromEvent({
    target: host.querySelector('a')!, preventDefault: () => {},
  }))
})

test('§15 the pure helpers round-trip, and refuse what is not a Windows path', () => {
  assert.equal(winFileHref(WIN), FWD)
  assert.equal(winFilePath(FWD), WIN)
  assert.equal(winFilePath(winFileHref(WIN)!), WIN)
  // drive-letter case is the author's, not ours to rewrite
  assert.equal(winFileHref(String.raw`d:\tmp\x`), '/d:/tmp/x')
  for (const notWindows of ['/usr/local/bin', 'https://x.test/a', 'docs/readme.md',
    '#anchor', String.raw`\\server\share`, 'C:relative\\x']) {
    assert.equal(winFileHref(notWindows), null, `${notWindows} was claimed`)
  }
})
