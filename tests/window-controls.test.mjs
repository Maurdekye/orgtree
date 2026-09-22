import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('frameless windows expose only sender-scoped window controls', () => {
  const main = read('apps/desktop/main/index.ts')
  const preload = read('apps/desktop/preload/index.ts')
  const contracts = read('packages/contracts/index.ts')
  assert.match(main, /frame: false/)
  assert.match(main, /desktop:window-minimize/)
  assert.match(main, /desktop:window-toggle-maximize/)
  assert.match(main, /desktop:window-close/)
  assert.match(main, /desktop:window-controls-state/)
  // ⚠ v3 RESOLVES THE SENDER INSTEAD OF ASSERTING IT, and the property is
  // STRONGER, not weaker. v2 asked 'is this the one window?'; v3 asks 'WHICH
  // window is this?', refuses on the same three grounds plus one more - it
  // must be a REGISTERED main window - and then acts on the window that
  // actually called. See tests/org-windows.test.mjs for the refusal matrix
  // driven directly against resolveNativeSender.
  assert.match(main, /const entry = resolveNativeSender\(event, windows, engine\.origin\)/)
  assert.doesNotMatch(main, /assertNativeSender/,
    'the single-window gate is gone, not merely bypassed')
  // and every window command acts on its CALLER, never on a window named by
  // an argument the renderer chose
  assert.match(main, /handle\('desktop:window-minimize', caller => \{ caller\.window\.minimize\(\) \}\)/)
  assert.match(main, /handle\('desktop:window-close', caller => \{ caller\.window\.close\(\) \}\)/)
  assert.match(main, /handle\('desktop:popout-minimize', \(caller, name\) => \{ caller\.popouts\.window\(name\)\?\.minimize\(\) \}\)/,
    "a popout command resolves against the calling window's OWN registry")
  assert.match(preload, /minimizeWindow: \(\) => ipcRenderer\.invoke\('desktop:window-minimize'\)/)
  assert.match(preload, /getWindowControlsState: \(\) => ipcRenderer\.invoke\('desktop:window-controls-state'\)/)
  assert.match(preload, /toggleMaximizeWindow: \(\) => ipcRenderer\.invoke\('desktop:window-toggle-maximize'\)/)
  assert.match(preload, /closeWindow: \(\) => ipcRenderer\.invoke\('desktop:window-close'\)/)
  assert.match(contracts, /minimizeWindow\(\): Promise<void>/)
  assert.match(contracts, /toggleMaximizeWindow\(\): Promise<void>/)
  assert.match(contracts, /closeWindow\(\): Promise<void>/)
})

test('renderer keeps interactive controls out of drag regions and offers top/bottom margins', () => {
  const app = read('apps/desktop/renderer/src/App.tsx')
  const controls = read('apps/desktop/renderer/src/window-controls.tsx')
  const styles = read('apps/desktop/renderer/src/styles.css')
  const nativeProbe = read('tests/window-controls-native.probe.ts')
  assert.match(app, /<WindowControls \/>/)
  assert.match(app, /native-header/)
  assert.match(app, /native-header-main/)
  assert.match(app, /<h1>[\s\S]*showControls && <WindowControls \/>[\s\S]*<\/h1>/)
  assert.doesNotMatch(app, /<Onboarding windowControls=/)
  assert.match(app, /<div className="welcome">[\s\S]*?home-header[\s\S]*?<WindowControls \/>[\s\S]*?showOnboarding[\s\S]*?<Onboarding>/)
  assert.match(app, /fallback-orgbar/)
  // the update indicator (list-controls' placement rule: a sibling immediately
  // before WindowControls, in every native header state) — each bounded to its
  // OWN header/heading close so one site's indicator cannot satisfy another's.
  assert.match(app, /<header className="orgbar fallback-orgbar native-header">[\s\S]*?<UpdateNotice \/>[\s\S]*?<WindowControls \/>[\s\S]*?<\/header>/)
  assert.match(app, /<h1>[\s\S]*?showControls && <UpdateNotice \/>[\s\S]*?showControls && <WindowControls \/>[\s\S]*?<\/h1>/)
  assert.match(app, /<header className=\{'orgbar' \+ \(desktop\(\) \? ' native-header' : ''\)\}>[\s\S]*?<UpdateNotice \/>[\s\S]*?<WindowControls \/>[\s\S]*?<\/header>/)
  // HOME page (user report 2026-09-10): the controls anchor to the window
  // corner via a fixed top-level header, and the centered card drops its
  // in-card controls exactly when that header exists (desktop shell)
  assert.match(app, /<header className="orgbar native-header home-header">[\s\S]*?<UpdateNotice \/>[\s\S]*?<WindowControls \/>[\s\S]*?<\/header>\}/)
  assert.match(app, /<div className="welcome-card">\{orgPanel\(!desktop\(\)\)\}<\/div>/)
  assert.match(styles, /\.orgbar\.native-header\.home-header \{[^}]*position: fixed/)
  assert.match(app, /orgPanel\(false\)/)
  assert.match(controls, /aria-label="Minimize window"/)
  assert.match(controls, /aria-label="Refresh app view"/)
  // W1 (2026-09-20): the refresh control's DEFAULT action is the renderer-
  // local reload, and the crash fallback renders the control WITH that
  // default — together with the boundary test's seam click, this is what
  // makes an inert crash-fallback refresh a failing test rather than a
  // silent regression.
  assert.match(controls, /onRefresh = \(\) => window\.location\.reload\(\)/)
  const crashBoundary = read('apps/desktop/renderer/src/CrashBoundary.tsx')
  assert.match(crashBoundary, /<WindowControls \/>/)
  assert.match(controls, /aria-label=\{state\.maximized \? 'Restore window' : 'Maximize window'\}/)
  assert.match(controls, /aria-label="Close window"/)
  assert.match(app, /!desktop\(\) && <button type="button" className="iconbtn" title="refresh app view"/)
  assert.equal((app.match(/className="window-drag-margin"/g) ?? []).length, 2, 'top and bottom canvas margins')
  assert.match(app, /desktop\(\) && <div className="window-drag-margin"/)
  assert.match(styles, /\.window-controls \{[^}]*-webkit-app-region: no-drag/)
  assert.match(styles, /\.window-controls \{[^}]*flex: 0 0 auto[^}]*flex-wrap: nowrap/)
  assert.match(styles, /\.window-control \{[^}]*flex: 0 0 46px/)
  // Only the native controls occupy a fixed column; ordinary content wraps.
  assert.match(styles, /\.orgbar\.native-header \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto/)
  assert.match(styles, /\.orgbar\.native-header > \.native-header-main \{[^}]*flex-wrap: wrap[^}]*overflow: visible/)
  assert.match(styles, /\.orgbar\.native-header > \.window-controls \{[^}]*grid-column: 3[^}]*grid-row: 1/)
  assert.match(styles, /\.orgbar button, \.orgbar a, \.orgbar input, \.orgbar select,[\s\S]*?\.orgbar \[role="button"\]/)
  assert.match(styles, /\.canvas-stage > \.viewport \{[^}]*-webkit-app-region: no-drag/)
  assert.match(nativeProbe, /native BrowserWindow state operations only/)
})
