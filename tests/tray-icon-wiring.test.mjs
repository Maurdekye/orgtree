// tray-icon-wiring.test.mjs — UI-05: the macOS menu-bar tray icon becomes a
// Template image (auto-inverting for light/dark menu bars) while the Dock
// icon and every window icon keep their full-color runtimeIcon() untouched.
//
// index.ts requires Electron and runs an application, so — same idiom as
// lifetime-wiring.test.mjs and updater-wiring.test.mjs — this asserts the
// wiring at source level rather than executing it.
//
// Run: node --test tests/tray-icon-wiring.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('trayIcon() branches on darwin and only sets Template mode in that branch', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /const trayIcon = \(\) => \{/,
    'trayIcon() must exist next to runtimeIcon()')

  const fnMatch = /const trayIcon = \(\) => \{([\s\S]*?)\n  \}/.exec(main)
  assert.ok(fnMatch, 'could not find the trayIcon() function body')
  const body = fnMatch[1]

  assert.match(body, /if \(process\.platform !== 'darwin'\) return runtimeIcon\(\)/,
    'every non-darwin platform must return runtimeIcon() unchanged — zero behavior change off-mac')

  const setTemplateCalls = [...body.matchAll(/\.setTemplateImage\(true\)/g)]
  assert.equal(setTemplateCalls.length, 1,
    'setTemplateImage(true) must only be called on the darwin branch, never unconditionally')

  // the darwin branch must derive from runtimeIcon(), not a second image source
  assert.match(body, /const base = runtimeIcon\(\)/,
    'the darwin branch must start from runtimeIcon() — the same possibly-provider-recolored image, never a second base image')
})

test('trayIcon() zeroes the B/G/R bytes and preserves the alpha byte', () => {
  const main = read('apps/desktop/main/index.ts')
  const fnMatch = /const trayIcon = \(\) => \{([\s\S]*?)\n  \}/.exec(main)
  const body = fnMatch[1]

  // Electron bitmap bytes are BGRA (documented at the recolor loop this
  // mirrors, in runtimeIcon() above). Byte i+3 (alpha) must never be
  // assigned — the eye silhouette's shape must survive untouched.
  assert.match(body, /for \(let i = 0; i < bitmap\.length; i \+= 4\) \{ bitmap\[i\] = 0; bitmap\[i \+ 1\] = 0; bitmap\[i \+ 2\] = 0 \}/,
    'the loop must zero exactly the B/G/R bytes (indices i, i+1, i+2) of every 4-byte pixel')
  assert.doesNotMatch(body, /bitmap\[i \+ 3\]/,
    'the alpha byte (i+3) must never be written — only color, never shape, is discarded')

  // matches the same byte-manipulation idiom icon-assets.test.mjs uses when
  // asserting pixel bytes directly, applied here to prove the loop's
  // arithmetic actually implements "zero every color channel, keep alpha"
  const width = 2, height = 1
  const bitmap = Buffer.from([10, 20, 30, 255, 40, 50, 60, 128]) // two BGRA pixels
  for (let i = 0; i < bitmap.length; i += 4) { bitmap[i] = 0; bitmap[i + 1] = 0; bitmap[i + 2] = 0 }
  assert.deepEqual([...bitmap], [0, 0, 0, 255, 0, 0, 0, 128],
    'sanity check: this is the exact transform the source loop above performs — B/G/R to zero, alpha untouched, for every pixel')
})

test('only the two tray-specific call sites use trayIcon(); window icons stay on runtimeIcon()', () => {
  const main = read('apps/desktop/main/index.ts')

  assert.match(main, /tray\?\.setImage\(trayIcon\(\)\)/,
    "rebuildTray()'s tray image assignment must use trayIcon()")
  assert.match(main, /tray = new Tray\(trayIcon\(\)\)/,
    'the initial Tray construction must use trayIcon()')

  // the Dock icon and every window icon must stay on the unwrapped,
  // full-color runtimeIcon() — never trayIcon(). The variable is still
  // named `image` (unchanged from before this task) precisely so the
  // pre-existing pinned assertions in icon-assets.test.mjs that don't
  // concern the tray-specific swap keep matching without churn.
  assert.match(main, /tray\?\.setImage\(trayIcon\(\)\)\s*\n\s*const image = runtimeIcon\(\)/,
    "rebuildTray()'s all-windows setIcon loop must use its own runtimeIcon() call, not the tray's trayIcon() image")
  assert.match(main, /window\.setIcon\(image\)/)
  for (const call of ['viewer.setIcon(runtimeIcon())', 'main.setIcon(runtimeIcon())', 'child.setIcon(runtimeIcon())']) {
    assert.match(main, new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${call} must be unchanged — window icons never go through trayIcon()`)
  }

  // trayIcon() itself must only be CALLED from those two call sites (strip
  // // line comments first — the doc comments above legitimately mention
  // "trayIcon()" as prose, which is not a call site)
  const code = main.split('\n').map(line => line.replace(/\/\/.*/, '')).join('\n')
  const trayIconCallSites = (code.match(/\btrayIcon\(\)/g) ?? []).length
  assert.equal(trayIconCallSites, 2,
    'trayIcon() must be called from exactly two places: the tray image assignment and the initial Tray construction')
})

test('tray tooltip is untouched — it remains the provider/engine-state carrier per the flagged tradeoff', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /tray\.setToolTip\(`Orgtree - \$\{label\(\)\}`\)/,
    'the tooltip must keep carrying provider/engine-state text now that the icon itself cannot show color')
})
