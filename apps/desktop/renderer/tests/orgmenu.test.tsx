// orgmenu.test.tsx — regression coverage for the polished organizations menu:
// compact width, theme-consistent subtle hover highlight (no broad gray block),
// reuse of the spinning-arrows working icon matching active agents, 1.6s actspin
// animation, theme accent coloring (orange under Orgtree / Claude theme),
// and keyboard navigation, focus, selection, and inactive row alignment.
//
// Run: node tests/run.mjs orgmenu

import { mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { OrgRows } from '../src/App'
import type { OrgListEntry } from '../src/types'
import { TRAY_LIST_W, AUTORENEW_SVG, trayListHtml } from '../../main/traylist'
import { THEME_ACCENTS, themeAccent } from '../../../../packages/contracts/visual-theme'

declare const __SRC_DIR__: string

const entry = (slug: string, patch: Partial<OrgListEntry> = {}): OrgListEntry => ({
  slug, name: slug, nodes: 9, live: 4, kiosk: false, created: null, ...patch,
})

const ORGS: OrgListEntry[] = [
  entry('orgtree', { name: 'Orgtree', working: 1, live: 4 }),
  entry('idle-org', { name: 'Idle Project', working: 0, live: 2 }),
  entry('public-org', { name: 'Public Org', live: 3 }),
]

async function mountRows(t: TestContext, orgs: OrgListEntry[],
  onPick: (slug: string) => void = () => {}, onDelete: (o: OrgListEntry) => void = () => {}) {
  useFakeClock()
  const view = await mountView(
    <OrgRows orgs={orgs} slug={null} onPick={onPick} onDelete={onDelete} />,
    (el) => el)
  t.after(async () => { await view.unmount(); realClock() })
  return view.el
}

test('menu width: compact width appropriate to labels and counts, rejecting wide defaults', () => {
  // 1. In-app drawer width in styles.css is tightened to 220px and rejects 280px
  const css = fs.readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const drawerRule = /\.drawer\s*\{([^}]*)\}/.exec(css)
  assert.ok(drawerRule, 'the .drawer rule exists in styles.css')
  assert.match(drawerRule![1]!, /width:\s*220px;/, 'drawer uses compact width 220px')
  assert.doesNotMatch(drawerRule![1]!, /width:\s*280px;/, 'drawer rejects the wide 280px default')

  // 2. Toolbar/tray popup width is compact 200px and rejects wide 288px
  assert.equal(TRAY_LIST_W, 200, 'TRAY_LIST_W is tightened to 200px')
  assert.notEqual(TRAY_LIST_W, 288, 'TRAY_LIST_W rejects former wide 288px')
})

test('hover styling: subtle, theme-consistent treatment that rejects the broad gray block', () => {
  const css = fs.readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  const orgHover = /\.org:hover\s*\{([^}]*)\}/.exec(css)
  assert.ok(orgHover, 'the .org:hover rule exists')
  assert.match(orgHover![1]!, /background:\s*color-mix\(in srgb,\s*var\(--accent\)\s*10%,\s*transparent\);/)
  assert.match(orgHover![1]!, /color:\s*var\(--ink-strong\);/)
  assert.doesNotMatch(orgHover![1]!, /background:\s*var\(--panel-2\);/,
    'must not use var(--panel-2) solid gray block')

  // Tray popup document also uses color-mix with --accent and rejects #2c2c2c
  const trayHtml = trayListHtml([{ slug: 'orgtree', name: 'Orgtree', working: 1, live: 4 }])
  assert.match(trayHtml, /\.row:hover>span\{background:color-mix\(in srgb,var\(--accent\) 10%,transparent\)/)
  assert.doesNotMatch(trayHtml, /\.row:hover>span\{background:#2c2c2c\}/,
    'tray popup must not use solid #2c2c2c gray block')
})

test('active organization indicator: reuses spinning-arrows working icon and animation', async (t) => {
  const el = await mountRows(t, ORGS)
  const rows = [...el.querySelectorAll('.org')]

  // 1. In-app active row renders AutorenewIcon with .cc-spin
  const busyRow = rows[0]!
  const spinIcon = busyRow.querySelector('.org-activity .cc-spin')
  assert.ok(spinIcon, 'active organization renders spinning icon')
  assert.equal(spinIcon.getAttribute('data-testid'), 'AutorenewIcon',
    'active organization reuses AutorenewIcon (spinning arrows)')

  // 2. Tray popup document renders SVG with AutorenewIcon path coordinates
  assert.match(AUTORENEW_SVG, /<svg class="spin" viewBox="0 0 24 24"/)
  assert.match(AUTORENEW_SVG, /d="M12 6v3l4-4-4-4v3c-4\.42 0-8 3\.58-8 8/)
  const trayHtml = trayListHtml([{ slug: 'orgtree', name: 'Orgtree', working: 1, live: 4 }])
  assert.match(trayHtml, /<svg class="spin"[^>]*><path d="M12 6v3/)
  assert.doesNotMatch(trayHtml, /border:\s*2px solid #4f8aef/,
    'tray popup rejects generic blue border circle spinner')

  // 3. Animation in both surfaces matches active agent turn spinner (actspin 1.6s)
  const css = fs.readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.cc-spin\s*\{[^}]*animation:\s*actspin 1\.6s linear infinite;/)
  assert.match(css, /@keyframes actspin\s*\{\s*to\s*\{\s*transform:\s*rotate\(360deg\);\s*\}\s*\}/)
  assert.match(trayHtml, /\.spin\{display:inline-block;line-height:1;color:var\(--accent\);animation:actspin 1\.6s linear infinite;flex:none\}/)
  assert.match(trayHtml, /@keyframes actspin\{to\{transform:rotate\(360deg\)\}\}/)
})

test('theme color: activity icon color comes from organization theme accent (orange under Orgtree / Claude)', () => {
  // In-app styles: .cc-spin and .working-ct wear var(--accent)
  const css = fs.readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /\.cc-spin\s*\{[^}]*color:\s*var\(--accent\);/)
  assert.match(css, /\.working-ct\s*\{[^}]*color:\s*var\(--accent\);/)

  // Orgtree selected theme is Claude Terracotta (orange #d97757)
  assert.equal(THEME_ACCENTS.claude, '#d97757')
  assert.equal(themeAccent('claude'), '#d97757')
  assert.equal(themeAccent(), '#d97757')

  // Tray popup rendered under claude theme wears --accent: #d97757
  const claudeHtml = trayListHtml([{ slug: 'orgtree', name: 'Orgtree', working: 1, live: 4 }], 'claude')
  assert.match(claudeHtml, /:root\{color-scheme:dark;--accent:#d97757\}/)

  // Other themes resolve to their respective accents
  assert.equal(themeAccent('codex'), '#22c4bd')
  const codexHtml = trayListHtml([{ slug: 'orgtree', name: 'Orgtree', working: 1, live: 4 }], 'codex')
  assert.match(codexHtml, /:root\{color-scheme:dark;--accent:#22c4bd\}/)

  assert.equal(themeAccent('antigravity'), '#75a5ff')
  const antiHtml = trayListHtml([{ slug: 'orgtree', name: 'Orgtree', working: 1, live: 4 }], 'antigravity')
  assert.match(antiHtml, /:root\{color-scheme:dark;--accent:#75a5ff\}/)

  assert.equal(themeAccent('custom:#e67e22'), '#e67e22')
  const customHtml = trayListHtml([{ slug: 'orgtree', name: 'Orgtree', working: 1, live: 4 }], 'custom:#e67e22')
  assert.match(customHtml, /:root\{color-scheme:dark;--accent:#e67e22\}/)
})

test('interactive behavior: inactive rows, selection, counts, and keyboard focus', async (t) => {
  const picked: string[] = []
  const doomed: string[] = []
  const el = await mountRows(t, ORGS, (s) => picked.push(s), (o) => doomed.push(o.slug))
  const rows = [...el.querySelectorAll('.org')]

  // Inactive rows do not show spinner, but activity cell keeps columns aligned
  assert.ok(rows[0]!.querySelector('.org-activity .cc-spin'), 'busy row has spinner')
  assert.equal(rows[1]!.querySelector('.cc-spin'), null, 'idle row has no spinner')
  assert.equal(rows[2]!.querySelector('.cc-spin'), null, 'public row has no spinner')
  assert.ok(rows[1]!.querySelector('.org-activity'), 'idle row retains activity cell for alignment')
  assert.ok(rows[2]!.querySelector('.org-activity'), 'public row retains activity cell for alignment')

  // Counts column
  const counts = rows.map((r) => r.querySelector('.org-counts')!.textContent)
  assert.deepEqual(counts, ['1/4', '0/2', '3'])

  // Click selection
  ;(rows[1] as HTMLElement).click()
  assert.deepEqual(picked, ['idle-org'])

  // Keyboard navigation (Enter key)
  const event = new (rows[0]!.ownerDocument.defaultView!.KeyboardEvent)('keydown', { key: 'Enter', bubbles: true })
  rows[0]!.dispatchEvent(event)
  assert.deepEqual(picked, ['idle-org', 'orgtree'])

  // Delete button does not trigger pick
  ;(rows[2]!.querySelector('.org-del') as HTMLElement).click()
  assert.deepEqual(doomed, ['public-org'])
  assert.deepEqual(picked, ['idle-org', 'orgtree'])
})
