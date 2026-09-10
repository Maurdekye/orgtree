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
  assert.match(main, /assertNativeSender\(event, main, engine\.origin\)/)
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
  assert.match(controls, /aria-label=\{state\.maximized \? 'Restore window' : 'Maximize window'\}/)
  assert.match(controls, /aria-label="Close window"/)
  assert.match(app, /!desktop\(\) && <button type="button" className="iconbtn" title="refresh app view"/)
  assert.equal((app.match(/className="window-drag-margin"/g) ?? []).length, 2, 'top and bottom canvas margins')
  assert.match(app, /desktop\(\) && <div className="window-drag-margin"/)
  assert.match(styles, /\.window-controls \{[^}]*-webkit-app-region: no-drag/)
  assert.match(styles, /\.window-controls \{[^}]*flex: 0 0 auto[^}]*flex-wrap: nowrap/)
  assert.match(styles, /\.window-control \{[^}]*flex: 0 0 46px/)
  // the single-row native-header rules apply at EVERY width — the old
  // 600–780px media band left wider windows wrapping the frame controls
  // (installed-alpha.6 user report); its return would reintroduce that
  assert.doesNotMatch(styles, /@media [(]min-width: 600px[)] and [(]max-width: 780px[)]/)
  assert.match(styles, /\.orgbar\.native-header \{[^}]*flex-wrap: nowrap/)
  assert.match(styles, /\.orgbar\.native-header > \.window-controls \{[^}]*flex: 0 0 auto/)
  assert.ok(styles.includes('.orgbar.native-header > .update-notice'))
  assert.match(styles, /\.orgbar\.native-header > \.update-notice \{[^}]*max-width: 180px/)
  assert.ok(styles.includes('overflow-x: auto'))
  assert.ok(styles.includes('html.mobile .orgbar.native-header > .native-header-main > .bar-detail'))
  assert.match(styles, /\.orgbar button, \.orgbar a, \.orgbar input, \.orgbar select, \.orgbar \.chip/)
  assert.match(styles, /\.canvas-stage > \.viewport \{[^}]*-webkit-app-region: no-drag/)
  assert.match(nativeProbe, /native BrowserWindow state operations only/)
})
