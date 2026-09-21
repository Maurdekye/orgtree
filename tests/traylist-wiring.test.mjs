// The tray org list is wired end to end: the tray's primary click builds the
// popup from live engine data, a row selection is a cancelled navigation that
// opens the org in the main window, the renderer acts on that event, and the
// backend counts agree with the rows. Companion to traylist.test.mjs (the
// pure behavior); this file pins the connective tissue the way
// updater-wiring.test.mjs does for the update flow.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('primary tray click opens the org list popup; double-click still opens the app', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /tray\.on\('click', \(_event, iconBounds\) => \{ void showTrayList\(iconBounds\) \}\)/)
  // v3: 'the app' is no longer one window. A double-click with nothing
  // visible restores the window the user was last in, or opens a Homepage
  // when there is none - the same routing an ordinary second launch uses.
  assert.match(main, /if \(!BrowserWindow\.getAllWindows\(\)\.some\(w => !w\.isDestroyed\(\) && w\.isVisible\(\)\)\) void showLastUsedOrHomepage\(\)/)
  assert.match(main, /const showLastUsedOrHomepage = async \(\) => \{/)
  assert.doesNotMatch(main, /label: 'Open Orgtree'|label: label\(\), enabled: false/)
  // the rows come from the engine's own validated fetch, per click — the
  // 5 s stats poll must not gain a full org-list parse
  assert.match(main, /const rows = await engine\.orgActivity\(\)/)
  assert.doesNotMatch(main, /orgActivity\(\); rebuildTray/)
})

test('the popup is a capability-free window and selection is a cancelled navigation', () => {
  const main = read('apps/desktop/main/index.ts')
  // sandboxed, no preload, no node — the popup must never receive a bridge
  const popup = /const popup = new BrowserWindow\(\{ \.\.\.bounds[\s\S]*?webPreferences: \{ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false \} \}\)/.exec(main)
  assert.ok(popup, 'the popup window construction changed shape')
  assert.doesNotMatch(popup[0], /preload/)
  // both navigation doors are covered and both cancel unconditionally
  assert.match(main, /popup\.webContents\.setWindowOpenHandler\(\(\{ url \}\) => \{ followSelection\(url\); return \{ action: 'deny' \} \}\)/)
  assert.match(main, /popup\.webContents\.on\('will-navigate', \(event, url\) => \{ event\.preventDefault\(\); followSelection\(url\) \}\)/)
  assert.match(main, /const slug = trayNavigationSlug\(url\)/)
  // selecting shows the app and hands the org to the renderer as an event
  // ⚠ v3: selecting a row opens THAT organization's own window, or focuses
  // it if it is already open. The v2 line showed the single window and
  // broadcast the organization at it, which in a multi-window app is an
  // org-specific navigation command sent to windows bound to other orgs.
  assert.match(main, /const openOrgFromTray = \(slug: string\) => \{\s*\n\s*closeTrayPopup\(\)\s*\n\s*void requestOrgWindow\(slug, null\)/)
  assert.doesNotMatch(main, /broadcastAll\(\{ type: 'open-org'/,
    'an organization is never announced to every window')
  // it dismisses itself when it loses focus and dies with the app's quit
  assert.match(main, /popup\.on\('blur', \(\) => \{ if \(trayPopup === popup\) closeTrayPopup\(\) \}\)/)
  assert.match(main, /quitting = true\r?\n\s*if \(poll\) clearInterval\(poll\)\r?\n\s*trayPopupSeq\+\+; closeTrayPopup\(\)/)
})

test('the renderer listens for open-org and makes it the active organization', () => {
  const contracts = read('packages/contracts/index.ts')
  assert.match(contracts, /'main-window-shown' \| 'window-state' \| 'popout-state' \| 'open-org'/)
  const app = read('apps/desktop/renderer/src/App.tsx')
  assert.match(app, /if \(\(event\.type as string\) !== 'open-org'\) return/)
  assert.match(app, /if \(typeof org !== 'string' \|\| !org\) return/)
  assert.match(app, /setSlug\(org\)/)
  // v3 STRENGTHENS this, it does not weaken it. Native resolves an org-scoped
  // event to its target window before delivery, so a BOUND window only ever
  // receives its own organization and must not re-aim itself on one that
  // somehow arrives for another — switching would hide the fault while
  // throwing away this window's organization. One window carrying them all is
  // the v2 world, and that is the only world the switch above is for.
  assert.match(app, /if \(nativeWindows\(\)\) return\s+setSlug\(org\)/,
    'the v2 switch is guarded by the absence of the native window model')
})

test('the sidebar rows and the tray tooltip carry the same n/m active-hired vocabulary', () => {
  // THE ROWS MOVED to shell/orgrows.tsx (v3): the compact menu and the
  // Homepage both render them, and importing them from App.tsx — which
  // renders both — would be a cycle. App.tsx re-exports the component, so no
  // importer changed; the vocabulary is asserted where the markup now lives.
  const app = read('apps/desktop/renderer/src/App.tsx')
  assert.match(app, /export \{ AdvancedOrgModal, OrgRows \}/,
    'App.tsx is still the public door to the rows')
  const rows = read('apps/desktop/renderer/src/shell/orgrows.tsx')
  // every row renders the three aligned cells; n/m is not gated on activity
  assert.match(rows, /className="org-activity"/)
  assert.match(rows, /title=\{current \? 'active \/ hired agents'/)
  assert.match(rows, /typeof o\.working === 'number' \? `\$\{o\.working\}\/\$\{o\.live\}` : `\$\{o\.live\}`/)
  // the spinner is the activity cell's conditional CONTENT, not a fourth
  // column — and since `show-current-organization-statuses-immediately` it is
  // ALSO gated on the snapshot being current, because an animation claiming a
  // turn is executing NOW may not run on a remembered count
  assert.match(rows, /\{current && \(o\.working \?\? 0\) > 0 &&\s+<span className="working-ct"/)
  const css = read('apps/desktop/renderer/src/styles.css')
  assert.match(css, /\.org \{\r?\n  display: grid; grid-template-columns: 14px minmax\(0, 1fr\) max-content auto;/)
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /\$\{stats\.activeAgents\} active \/ \$\{stats\.totalAgents\} hired/)
  // and the backend total the tooltip sums is HIRED agents, not every node
  const launch = read('engine/launch.py')
  assert.match(launch, /total \+= int\(row\.get\("live"\) or 0\)/)
  assert.doesNotMatch(launch, /total \+= int\(row\.get\("nodes"\) or 0\)/)
})
