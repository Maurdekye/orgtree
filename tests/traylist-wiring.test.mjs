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
  assert.match(main, /popup\.on\('blur', \(\) => \{\s*if \(trayPopup !== popup\) return/)
  // Dismissal and blur/click ordering execute in tray-toggle.test.mjs.
  assert.match(main, /quitting = true\r?\n\s*if \(poll\) clearInterval\(poll\)\r?\n\s*trayPopupSeq\+\+; closeTrayPopup\(\)/)
})

test('the renderer listens for open-org and makes it the active organization', () => {
  const contracts = read('packages/contracts/index.ts')
  assert.match(contracts, /'main-window-shown' \| 'window-state' \| 'popout-state' \| 'open-org'/)
  const app = read('apps/desktop/renderer/src/App.tsx')
  // ⚠ THE SUBSCRIPTION MOVED, AND THE REASON IS THE POINT OF THIS CHECK.
  // `open-org` is one of the four types native HOLDS until a renderer is
  // listening, and the preload acknowledges from inside `onEvent` — so the
  // FIRST `onEvent` in the document ends the holding, and in this renderer
  // that is `startThemeSync()` on line 20 of main.tsx, which cares about
  // `preferences` alone. A raw `bridge.onEvent` here subscribed AFTER the
  // event had already been delivered to nobody. `onHeldEvent` is the shipping
  // route (events/heldbus.ts): the bus attaches before anything else and
  // hands the event over when this consumer registers, however much later.
  assert.match(app, /onHeldEvent\('open-org', \(event\) => \{/,
    'open-org is consumed through the held bus, not a raw onEvent')
  assert.doesNotMatch(app, /\(event\.type as string\) !== 'open-org'/,
    'and not ALSO off the bridge directly, which would double-deliver every live one')
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
  // REMOTE ORGANIZATIONS (docs/rust-engine/remote-org.md) are drawn by the same
  // `row` as this computer's own, so one whose engine is connected carries the
  // same n/m and the same words by construction, not by a second copy of the
  // markup that could drift.
  assert.match(rows, /\{local\.map\(row\)\}/)
  assert.match(rows, /\{orgs\.filter\(\(o\) => o\.remote\?\.id === remote\.id\)\.map\(row\)\}/)
  // The one row that says something else is a remote organization whose engine
  // is NOT connected: its numbers would be the last ones that engine sent, so
  // the cell shows none, and its tooltip says why instead of naming a
  // vocabulary for numbers that are not there. `away` needs `o.remote`, so a
  // row of this computer can never lose its numbers or its words this way.
  // (The rows are executed in apps/desktop/renderer/tests/remoteorg.test.tsx,
  // the tray list's own remote rows in tests/traylist-remote.test.mjs.)
  assert.match(rows, /const away = !!o\.remote && o\.remote\.state !== 'connected'/)
  assert.match(rows, /title=\{away \? 'not connected: no current numbers' : current \? 'active \/ hired agents' : staleTitle\}>/)
  assert.match(rows, /\{away \? '' : freshness === 'loading' \? '…'\s+: typeof o\.working === 'number' \? `\$\{o\.working\}\/\$\{o\.live\}` : `\$\{o\.live\}`\}/)
  // the spinner is the activity cell's conditional CONTENT, not a fourth
  // column — and since `show-current-organization-statuses-immediately` it is
  // ALSO gated on the snapshot being current, because an animation claiming a
  // turn is executing NOW may not run on a remembered count. While a remote
  // organization's engine is away its count is a remembered one too, so the
  // spinner waits for that as well.
  assert.match(rows, /\{attn === 0 && current && !away && \(o\.working \?\? 0\) > 0 &&\s+<span className="working-ct"/)
  const css = read('apps/desktop/renderer/src/styles.css')
  assert.match(css, /\.org \{\r?\n  display: grid; grid-template-columns: minmax\(14px, max-content\) minmax\(0, 1fr\) max-content auto;/)
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /\$\{stats\.activeAgents\} active \/ \$\{stats\.totalAgents\} hired/)
  // and the backend total the tooltip sums is HIRED agents, not every node
  const desktop = read('engine/rs/orgtree-engine/src/http/desktop.rs')
  assert.match(desktop, /SELECT count\(\*\) FROM ot\.agents WHERE state = 'live' AND kind = 'agent'/)
  assert.match(desktop, /"totalAgents": total/)
})
