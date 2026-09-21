// The multi-window host, asserted against the source the way
// updater-wiring.test.mjs and traylist-wiring.test.mjs assert theirs: the
// behaviour behind these lines needs a real Electron app, so what the host
// CALLS is pinned here and the rules themselves are driven directly in
// tests/org-windows.test.mjs.
//
// Every assertion in this file is about something that USED to be true of one
// window and is now a statement about which window. The negative assertions
// are the point: a single-window habit reintroduced here would not fail any
// test that only checks the happy path.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

test('the sender is resolved to a window, and every window command acts on its caller', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /const entry = resolveNativeSender\(event, windows, engine\.origin\)/)
  assert.doesNotMatch(main, /assertNativeSender/, 'the single-window gate is gone, not bypassed')

  // ⚠ THE CALLER, NEVER AN ARGUMENT. A window id from the renderer is chosen
  // by the renderer, so acting on one would let an organization's bridge
  // command another organization's window.
  for (const line of [
    /handle\('desktop:window-minimize', caller => \{ caller\.window\.minimize\(\) \}\)/,
    /handle\('desktop:window-close', caller => \{ caller\.window\.close\(\) \}\)/,
    /handle\('desktop:window-state', caller => windowState\(caller\)\)/,
    /handle\('desktop:show', caller => revealWindow\(caller\)\)/,
  ]) assert.match(main, line)
})

test('popout commands resolve against the CALLING window\'s own registry', () => {
  const main = read('apps/desktop/main/index.ts')
  // v2 had one app-wide map keyed by frame name alone, so the same name from
  // any window resolved to the same popout.
  for (const line of [
    /handle\('desktop:popout-state', \(caller, name\) => typeof name === 'string' \? caller\.popouts\.state\(name\) : null\)/,
    /handle\('desktop:popout-minimize', \(caller, name\) => \{ caller\.popouts\.window\(name\)\?\.minimize\(\) \}\)/,
    /handle\('desktop:popout-close', \(caller, name\) => \{ caller\.popouts\.window\(name\)\?\.close\(\) \}\)/,
    /handle\('desktop:popout-focus', \(caller, name\) => \{ revealPopout\(caller\.popouts\.window\(name\)\) \}\)/,
  ]) assert.match(main, line)
  // each window builds its own, rather than sharing a module-scoped one
  assert.match(main, /popouts: popoutRegistry<BrowserWindow>\(state => sendTo\(id, \{ type: 'popout-state',/)
  assert.doesNotMatch(main, /^\s*const popouts = popoutRegistry/m, 'no app-wide popout registry remains')
})

test('an organization is never announced to a window bound to another one', () => {
  const main = read('apps/desktop/main/index.ts')
  // the two delivery routes are distinct, and the org-specific ones are not
  // reachable through the app-wide one
  assert.match(main, /const sendTo = \(id: string, event: DesktopEvent\) => \{/)
  assert.match(main, /const broadcastAll = \(event: DesktopEvent\) => \{ for \(const id of records\.keys\(\)\) sendTo\(id, event\) \}/)
  for (const orgScoped of ['open-org', 'notification-click', 'window-identity', 'restore-skipped', 'window-state', 'popout-state', 'main-window-shown']) {
    assert.doesNotMatch(main, new RegExp(`broadcastAll\\(\\{ type: '${orgScoped}'`),
      `${orgScoped} is window-scoped and must never be broadcast`)
  }
  // and the app-wide facts genuinely do go everywhere
  for (const appWide of ['engine-status', 'preferences', 'update', 'maintenance', 'open-orgs']) {
    assert.match(main, new RegExp(`broadcastAll\\(\\{ type: '${appWide}'`), appWide)
  }
})

test('the notification poll goes to ONE window and its writes are gated on ownership', () => {
  const main = read('apps/desktop/main/index.ts')
  // routing the wake is only half: the renderer also polls on mount, on a
  // preference change and on a live bump, which native never triggers
  assert.match(main, /const owner = windows\.notificationOwner\(\)\s*\r?\n\s*if \(owner\) sendTo\(owner\.id, \{ type: 'notification-poll', data: null \}\)/)
  assert.doesNotMatch(main, /broadcastAll\(\{ type: 'notification-poll'/)
  assert.match(main, /if \(!windows\.isNotificationOwner\(caller\.id\)\) return undefined/)
  for (const ownerOnly of ['notify', 'sync-notifications', 'pending-attention']) {
    assert.match(main, new RegExp(`handleOwner\\('desktop:${ownerOnly}'`), ownerOnly)
  }
})

test('the taskbar pulse is routed from the organization, not from a window id', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /const taskbarAttention = new TaskbarAttention\(org => \{\s*\r?\n\s*const bound = org \? windows\.byOrg\(org\) : undefined/)
  assert.match(main, /return \(record \?\? lastUsed\(\)\)\?\.window/, 'last-used is the fallback, not the target')
  // ⚠ the pulse must not follow the notification owner, which is chosen by
  // registration order and has nothing to do with where the item lives
  assert.doesNotMatch(main, /new TaskbarAttention\([\s\S]{0,200}notificationOwner/)
  // and activation clears THIS window's flash only
  assert.match(main, /taskbarAttention\.focused\(window\)/)
})

test('closing one of several windows closes it; the tray behaviour is the LAST window\'s', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /const otherMains = \[\.\.\.records\.values\(\)\]\.some\(other => other !== record && !other\.window\.isDestroyed\(\) && other\.window\.isVisible\(\)\)\s*\r?\n\s*if \(otherMains\) return/)
  // the existing last-window rule is reached unchanged
  assert.match(main, /const action = closeAction\(preferences\.get\(\)\.exitOnClose, quitting, otherViews\)/)
  // and it closes its OWN popouts, nobody else's
  assert.match(main, /for \(const child of record\.owned\) if \(!child\.isDestroyed\(\)\) child\.close\(\)/)
  assert.match(main, /record\.tearingDown = true/, 'so their state events say the parent took them')
})

test('an unfinished creation form is confirmed on a deliberate close and on a quit', () => {
  const main = read('apps/desktop/main/index.ts')
  // ONE dialog definition for every route: a discard prompt that differs
  // between them is how two of them end up with different defaults
  assert.match(main, /const CREATION_DISCARD_DIALOG = \{/)
  assert.match(main, /defaultId: 1,\s*\r?\n\s*cancelId: 1,/,
    'Escape and the window X must mean KEEP; the destructive answer is never the dismissal')
  assert.equal(main.split('CREATION_DISCARD_DIALOG').length - 1, 3,
    'defined once, used by the close route and the quit route')

  // the close route
  assert.match(main, /const decision = windows\.beginClose\(id\)\s*\r?\n\s*if \(decision === 'awaiting'\) \{ event\.preventDefault\(\); return \}/)
  // the quit route, and Cancel aborts the WHOLE shutdown
  assert.match(main, /const gate = windows\.quitCreationGate\(\)/)
  assert.match(main, /if \(gate\.action === 'busy'\) return false/)
  assert.match(main, /if \(!discard\) return false/)
  // ⚠ an update install and an installer upgrade are shutdowns the user
  // already approved, and a dialog inside them is what wedges the app
  assert.equal(main.split('quitConfirmed = true').length - 1, 3)
})

test('a quit records what was open BEFORE teardown, in both shutdown routes', () => {
  const main = read('apps/desktop/main/index.ts')
  // teardown closes every window; if those closes counted as the user closing
  // them the reopen set would be emptied and the next launch would restore
  // nothing at all
  assert.equal(main.split('placement?.beginShutdown(').length - 1, 2,
    'the ordinary quit and the update path both capture it')
  assert.match(main, /if \(record\.placementKey && !quitting\) placement\?\.closedWindow\(record\.placementKey\)/,
    'a close during a shutdown is not the user closing a window')
})

test('startup restores what was open, and an unreadable list is not an empty one', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /preferences\.get\(\)\.startupMode === 'homepage' \? \[\] : \(placement\?\.sessionWindows\(\) \?\? \[\]\)/)
  // ⚠ null means "could not read", which must not be read as "none of these
  // organizations exist" — that would drop every saved window on exactly the
  // launch where something was already wrong
  assert.match(main, /const known = rows \? new Set\(rows\.map\(row => row\.slug\)\) : null/)
  assert.match(main, /org => known === null \|\| known\.has\(org\)/)
  // and what it could not reopen is SAID
  assert.match(main, /sendTo\(first\.id, \{ type: 'restore-skipped',/)
  assert.match(main, /data: \{ orgs: plan\.skippedOrgs, panels: \[\], notice: plan\.notice \}/,
    'native reports organizations; the panels half is the renderer\'s to originate')
})

test('a window is registered BEFORE its document loads', () => {
  const main = read('apps/desktop/main/index.ts')
  // the preload resolves this window's identity synchronously through sender
  // lookup, so the window is not addressable until it is registered — which
  // is also why openOrg's create must not await the load
  const build = main.slice(main.indexOf('const buildMainWindow ='), main.indexOf('const routeFor ='))
  const registered = build.indexOf('windows.register({ id, senderId: window.webContents.id')
  assert.ok(registered > 0, 'the window is registered in the factory')
  // it hands a load CALLBACK to the recovery, but never navigates the window
  // itself - the document is loaded by the caller, after registration
  assert.doesNotMatch(build, /await [\w.]*loadURL/, 'the factory itself never awaits a navigation')
  assert.match(main, /const openWindow = async \(\{ kind, org \}: \{ kind: OrgWindowKind; org\?: string \}\) => \{\s*\r?\n\s*const record = buildMainWindow\(kind, org\)\s*\r?\n\s*await record\.window\.loadURL/)
  assert.match(main, /ipcMain\.on\('desktop:window-identity-sync', event => \{/,
    'and the identity is answered synchronously, before the bridge exists')
})

test('the preload resolves identity before it exposes the bridge', () => {
  const preload = read('apps/desktop/preload/index.ts')
  const exposed = preload.indexOf('contextBridge.exposeInMainWorld')
  const resolved = preload.indexOf("ipcRenderer.sendSync('desktop:window-identity-sync')")
  assert.ok(resolved > 0 && resolved < exposed, 'the identity is in hand before the bridge is')
  assert.match(preload, /windowIdentity,/, 'and it is a plain value, not a promise')
  // a launch argument would be fixed for the window's life, so a Homepage that
  // binds itself would report the wrong kind for ever after
  assert.doesNotMatch(preload, /--orgtree-window-kind|--orgtree-window-org/)
})

test('the tray and a second instance route through the registry, never through one window', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /void requestOrgWindow\(slug, null\)/)
  assert.doesNotMatch(main, /broadcast\(\{ type: 'open-org'/)
  assert.equal(main.split('showLastUsedOrHomepage()').length - 1, 3,
    'the helper itself, the tray double-click and an ordinary second launch')
  assert.match(main, /app\.on\('activate', \(\) => \{ void showLastUsedOrHomepage\(\) \}\)/)
  // the installer control path is untouched
  assert.match(main, /if \(hasInstallerUpgradeRequest\(commandLine\)\) \{ void requestInstallerUpgradeShutdown\(\); return \}/)
})

test('events that cannot be asked for again are held until the renderer can listen', () => {
  const main = read('apps/desktop/main/index.ts')
  // ⚠ ONLY the events a renderer has no way to rediscover. Window state,
  // popout state and main-window-shown are all re-readable through the
  // bridge, so holding them would only risk delivering a stale duplicate.
  assert.match(main, /const HELD_EVENT_TYPES = new Set<DesktopEvent\['type'\]>\(\['open-org', 'notification-click', 'window-identity', 'restore-skipped'\]\)/)
  for (const readable of ['window-state', 'popout-state', 'main-window-shown', 'engine-status', 'preferences']) {
    assert.doesNotMatch(main, new RegExp(`HELD_EVENT_TYPES[\s\S]{0,200}'${readable}'`), readable)
  }
  // bounded, so a window whose renderer never arrives cannot grow without limit
  assert.match(main, /if \(record\.outbox\.length > HELD_EVENT_LIMIT\) record\.outbox\.shift\(\)/)
  // the renderer collects them and switches the window to live delivery
  assert.match(main, /handle\('desktop:take-pending-events', caller => flushOutbox\(caller\)\)/)
  assert.match(main, /record\.flushed = true/)
  // ⚠ AND A RENDERER THAT NEVER ASKS STILL GETS THEM. The v2 renderer does not
  // call this; without the grace its events would sit in the outbox for ever,
  // which is worse than the dropping this replaced.
  assert.match(main, /record\.flushTimer = setTimeout\(\(\) => \{/)
  assert.match(main, /const HELD_EVENT_GRACE_MS = 2_000/)
  // and a window that closes mid-grace leaves no timer behind
  assert.match(main, /if \(record\.flushTimer\) \{ clearTimeout\(record\.flushTimer\); record\.flushTimer = undefined \}/)
})
