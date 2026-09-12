// The tray's primary-click org list, at its pure boundary (traylist.ts):
// the /api/orgs row validator the engine feeds the popup from, the document
// the popup renders, the navigation parser that turns a row click into an
// org selection, and the popup placement. Run: node --test tests/traylist.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-traylist-test-'))
const req = createRequire(import.meta.url)
const out = path.join(temp, 'traylist.cjs')
await build({ entryPoints: ['apps/desktop/main/traylist.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
const { orgActivityRows, trayListHtml, trayNavigationSlug, popupBounds, TRAY_NAV_PREFIX, TRAY_ROW_H, TRAY_LIST_W, AUTORENEW_SVG } = req(out)

const rows = [
  { slug: 'alpha', name: 'Alpha Org', working: 2, live: 5 },
  { slug: 'idle-org', name: 'Idle', working: 0, live: 3 },
]

test('org rows validate the admin listing and refuse malformed payloads whole', () => {
  assert.deepEqual(orgActivityRows([
    { slug: 'alpha', name: 'Alpha Org', working: 2, live: 5, nodes: 99, kiosk: false },
    { slug: 'idle-org', name: 'Idle', working: 0, live: 3 },
  ]), rows, 'extra listing fields pass through as the two tray counts')
  // a deliberately working-less row (the public listing shape) reads as idle
  assert.deepEqual(orgActivityRows([{ slug: 'pub', name: 'P', live: 1 }]),
    [{ slug: 'pub', name: 'P', working: 0, live: 1 }])
  // an empty name falls back to the slug rather than a blank row
  assert.deepEqual(orgActivityRows([{ slug: 'x', name: '', live: 0 }]),
    [{ slug: 'x', name: 'x', working: 0, live: 0 }])
  assert.deepEqual(orgActivityRows([]), [])
  // all-or-nothing: one bad row must not silently drop organizations
  for (const bad of [null, {}, 'x', [null], [{ name: 'n', live: 1 }],
    [{ slug: 'UPPER', name: 'n', live: 1 }], [{ slug: 'a/b', name: 'n', live: 1 }],
    [{ slug: 'a', name: 7, live: 1 }], [{ slug: 'a', name: 'n' }],
    [{ slug: 'a', name: 'n', live: -1 }], [{ slug: 'a', name: 'n', live: 1.5 }],
    [rows[0], { slug: 'a', name: 'n', live: 'x' }]]) {
    assert.equal(orgActivityRows(bad), null, JSON.stringify(bad))
  }
  // a negative or fractional working count never becomes a spinner claim
  assert.deepEqual(orgActivityRows([{ slug: 'a', name: 'n', live: 1, working: -2 }]),
    [{ slug: 'a', name: 'n', working: 0, live: 1 }])
})

test('the popup document has one aligned grid, spinners only for active orgs, n/m always', () => {
  const html = trayListHtml(rows)
  // one grid holds every cell; rows are display:contents so the three
  // columns align ACROSS rows (a per-row grid would size its own columns)
  assert.match(html, /\.list\{display:grid;grid-template-columns:[^}]+\}/)
  assert.match(html, /\.row\{display:contents/)
  // both rows, in listing order, each linking to its own selection URL
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1])
  assert.deepEqual(links, [TRAY_NAV_PREFIX + 'alpha', TRAY_NAV_PREFIX + 'idle-org'])
  // n/m is always rendered — the idle row keeps its 0/3
  assert.match(html, /<span class="ct">2\/5<\/span>/)
  assert.match(html, /<span class="ct">0\/3<\/span>/)
  // the spinner exists ONLY in the active row; the activity CELL exists in
  // both (that is what keeps the name column flush)
  assert.equal([...html.matchAll(/class="spin"/g)].length, 1)
  assert.equal([...html.matchAll(/class="act"/g)].length, 2)
  const active = html.indexOf('<span class="name">Alpha Org'), spin = html.indexOf('class="spin"')
  assert.ok(spin >= 0 && active >= 0 && spin < active, 'the spinner sits in the active row, before its name cell')
  // no script may ever run in the popup: scriptless document under a
  // no-source CSP (style-src inline only)
  assert.doesNotMatch(html, /<script/i)
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/)
})

test('org names render as text, never as markup, and cannot mint selection links', () => {
  const html = trayListHtml([{ slug: 'evil', name: '<script>alert(1)</script>"<a href="x">', working: 1, live: 1 }])
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  // the only anchors are the row itself — the name's quote/anchor text was escaped
  assert.equal([...html.matchAll(/<a /g)].length, 1)
})

test('empty and unavailable listings say so instead of showing a blank popup', () => {
  assert.match(trayListHtml([]), /No organizations yet/)
  assert.match(trayListHtml(null), /list is unavailable/)
  assert.doesNotMatch(trayListHtml(null), /class="row"/)
})

test('row selection URLs parse back to their slug; everything else is refused', () => {
  assert.equal(trayNavigationSlug(TRAY_NAV_PREFIX + 'alpha'), 'alpha')
  assert.equal(trayNavigationSlug(TRAY_NAV_PREFIX + 'team@old'), 'team@old')
  for (const bad of [TRAY_NAV_PREFIX, TRAY_NAV_PREFIX + 'a/b', TRAY_NAV_PREFIX + 'UPPER',
    TRAY_NAV_PREFIX + 'a?x=1', 'https://example.com/open/alpha', 'file:///x',
    'https://orgtree-tray.invalid.example.com/open/alpha', '']) {
    assert.equal(trayNavigationSlug(bad), null, bad)
  }
})

test('the popup sits over the tray icon, above a bottom taskbar, clamped to the work area', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 }
  const icon = { x: 1700, y: 1044, width: 24, height: 24 }
  const b = popupBounds(icon, work, 3)
  assert.equal(b.height, 3 * TRAY_ROW_H + 12)
  assert.equal(b.y, icon.y - b.height - 4, 'opens upward from a bottom tray')
  assert.ok(b.x + b.width <= work.x + work.width, 'clamped inside the right edge')
  assert.ok(b.x >= work.x)
  // a top-of-screen anchor opens downward instead of off-screen
  const top = popupBounds({ x: 40, y: 0, width: 24, height: 24 }, work, 3)
  assert.equal(top.y, 28, 'below the anchor when there is no room above')
  // a huge org list is capped inside the work area (the document scrolls)
  const tall = popupBounds(icon, work, 500)
  assert.ok(tall.height <= Math.round(work.height * 0.6))
  assert.ok(tall.y >= work.y)
})

test('toolbar organizations menu uses a compact width and rejects the wide 288px default', () => {
  assert.equal(TRAY_LIST_W, 200)
  assert.notEqual(TRAY_LIST_W, 288)
  const work = { x: 0, y: 0, width: 1920, height: 1040 }
  const icon = { x: 1000, y: 1044, width: 24, height: 24 }
  const bounds = popupBounds(icon, work, 2)
  assert.equal(bounds.width, 200)
})

test('the active indicator reuses the spinning-arrows working icon and animation', () => {
  assert.match(AUTORENEW_SVG, /<svg class="spin" viewBox="0 0 24 24"/)
  assert.match(AUTORENEW_SVG, /d="M12 6v3l4-4-4-4v3c-4\.42 0-8 3\.58-8 8/)
  const html = trayListHtml(rows)
  assert.match(html, /<svg class="spin"[^>]*><path d="M12 6v3/)
  assert.match(html, /\.spin\{display:inline-block;line-height:1;color:var\(--accent\);animation:actspin 1\.6s linear infinite;flex:none\}/)
  assert.match(html, /@keyframes actspin\{to\{transform:rotate\(360deg\)\}\}/)
  assert.doesNotMatch(html, /border:\s*2px solid #4f8aef/)
})

test('hover styling uses a subtle theme-consistent tint and rejects the broad gray block', () => {
  const html = trayListHtml(rows)
  assert.match(html, /\.row:hover>span\{background:color-mix\(in srgb,var\(--accent\) 10%,transparent\)/)
  assert.match(html, /\.row:focus-visible>span\{background:color-mix\(in srgb,var\(--accent\) 15%,transparent\)/)
  assert.doesNotMatch(html, /\.row:hover>span\{background:#2c2c2c\}/)
})

test('activity indicator and menu styling use the organization theme accent', () => {
  // Orgtree under its selected Claude theme (orange #d97757)
  const claudeHtml = trayListHtml(rows, 'claude')
  assert.match(claudeHtml, /:root\{color-scheme:dark;--accent:#d97757\}/)

  // Default fallback also produces Claude orange #d97757
  const defaultHtml = trayListHtml(rows)
  assert.match(defaultHtml, /:root\{color-scheme:dark;--accent:#d97757\}/)

  // Other visual themes resolve to their respective theme accents
  const codexHtml = trayListHtml(rows, 'codex')
  assert.match(codexHtml, /:root\{color-scheme:dark;--accent:#22c4bd\}/)

  const customHtml = trayListHtml(rows, 'custom:#ff0077')
  assert.match(customHtml, /:root\{color-scheme:dark;--accent:#ff0077\}/)
})
