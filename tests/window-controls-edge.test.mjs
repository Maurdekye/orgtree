import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-edge-unit-'))
const recoveryCjs = path.join(tempDir, 'window-load-recovery.cjs')
await build({
  entryPoints: [path.join(root, 'apps/desktop/main/window-load-recovery.ts')],
  outfile: recoveryCjs,
  bundle: true,
  format: 'cjs',
  platform: 'node',
})
const { holdingPageHtml } = createRequire(import.meta.url)(recoveryCjs)

test('CSS rules anchor window controls flush against the top-right edges with zero dead gaps', () => {
  const styles = read('apps/desktop/renderer/src/styles.css')

  // Native header zeroes top and right padding so controls reach the physical window boundary
  assert.match(styles, /\.orgbar\.native-header \{[^}]*padding-top:\s*0/, 'native-header has padding-top: 0')
  assert.match(styles, /\.orgbar\.native-header \{[^}]*padding-right:\s*0/, 'native-header has padding-right: 0')

  // Window controls group is anchored to grid column 3 with no margin in native header
  assert.match(styles, /\.orgbar\.native-header > \.window-controls \{[^}]*grid-column:\s*3/)
  assert.match(styles, /\.orgbar\.native-header > \.window-controls \{[^}]*justify-self:\s*end/)
  assert.match(styles, /\.orgbar\.native-header > \.window-controls \{[^}]*margin:\s*0/)
  assert.match(styles, /\.orgbar\.native-header > \.window-controls \{[^}]*height:\s*32px/)

  // Home header (welcome screen) has padding-top: 0 and padding-right: 0
  assert.match(styles, /\.orgbar\.native-header\.home-header \{[^}]*position:\s*fixed/)
  assert.match(styles, /\.orgbar\.native-header\.home-header \{[^}]*padding:\s*0 0 6px 14px/)

  // Main container removes top and right padding when housing native window chrome
  assert.match(styles, /main:has\(> \.orgbar\.native-header\) \{[^}]*padding-top:\s*0/)
  assert.match(styles, /main:has\(> \.orgbar\.native-header\) \{[^}]*padding-right:\s*0/)
  assert.match(styles, /main:has\(> \.orgbar\.native-header\) > \.canvas-stage \{[^}]*padding-right:\s*18px/)

  // Controls are 46px wide with no-drag regions and active states
  assert.match(styles, /\.window-controls \{[^}]*-webkit-app-region:\s*no-drag/)
  assert.match(styles, /\.window-control \{[^}]*flex:\s*0 0 46px/)
  assert.match(styles, /\.window-control:active \{[^}]*background:/)
  assert.match(styles, /\.window-control\.close:active \{[^}]*background:\s*#b02619/)
})

test('holding page HTML places window controls flush against top-right corner with no drag interception', () => {
  const html = holdingPageHtml('errorCode=-102 ERR_CONNECTION_REFUSED url=http://127.0.0.1:21350/o/orgtree')
  assert.match(html, /\.orgbar\{[^}]*align-items:flex-start/, 'header aligns items to flex-start')
  assert.match(html, /\.orgbar\{[^}]*padding:0 0 6px 14px/, 'header zeroes top and right padding')
  assert.match(html, /\.orgbar h2\{margin:6px 0/, 'title preserves vertical breathing margin')
  assert.match(html, /\.window-controls\{[^}]*height:32px;margin:0/, 'controls sit at top edge with 32px hit height')
  assert.match(html, /\.window-controls\{[^}]*-webkit-app-region:no-drag/, 'controls are no-drag')
  assert.match(html, /\.orgbar\{[^}]*-webkit-app-region:drag/, 'header is drag')
})

test('CrashBoundary renders fallback header with zero top/right padding', () => {
  const crashBoundary = read('apps/desktop/renderer/src/CrashBoundary.tsx')
  assert.match(crashBoundary, /padding:\s*'0 0 6px 14px'/, 'fallback header has zero top and right padding')
  assert.match(crashBoundary, /<WindowControls \/>/, 'contains WindowControls')
})

test('real Electron frameless window probe passes edge hit tests across restored and maximized states', () => {
  const script = path.join(root, 'tools/test-window-controls-edge-native.mjs')
  const res = spawnSync(process.execPath, [
    '-e',
    `process.chdir(${JSON.stringify(root)}); import(${JSON.stringify('file:///' + script.replace(/\\/g, '/'))})`,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 45000,
  })
  assert.equal(res.status, 0, `native probe failed: ${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /WINDOW_CONTROLS_EDGE_NATIVE_PASS/)
})
