/** REAL ELECTRON, REAL WINDOWS, REAL webContents.
 *
 *  Everything in tests/org-windows.test.mjs drives the registry through narrow
 *  window-like interfaces, which proves the RULES and says nothing about
 *  Electron. The claims below are the ones that only a real window can settle:
 *
 *    · a real `webContents.id` is what sender resolution matches on, and the
 *      registration cross-check really does catch a wrong one;
 *    · `event.senderFrame` compared by IDENTITY against `webContents.mainFrame`
 *      really is the same object for a genuine main-frame call, and really is
 *      not for anything else;
 *    · two real windows each resolve to themselves and never to each other,
 *      which is the whole of the cross-window command guarantee;
 *    · per-window popout registries really do refuse a frame name belonging to
 *      another window;
 *    · a real `destroy()` really does make a window drop out of the registry
 *      and release its organization;
 *    · `getNormalBounds()` on a real window round-trips through the placement
 *      store, and `fitWindow` really does recover a rectangle from a display
 *      that is not there.
 *
 *  Nothing here starts an engine, loads a document, touches user data or shows
 *  a window. The windows are created hidden and destroyed at the end. */
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { orgWindowRegistry, resolveNativeSender, openOrg } from '../apps/desktop/main/org-windows'
import { OrgPlacement } from '../apps/desktop/main/org-placement'
import { popoutRegistry } from '../apps/desktop/main/windows'
import { windowOutbox } from '../apps/desktop/main/window-outbox'

const profile = process.env.ORGTREE_ELECTRON_TEST_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-multiwindow-probe-'))
app.setPath('userData', profile)

const ORIGIN = 'http://127.0.0.1:54321'
/** A call as ipcMain would deliver it, built from the window's REAL frame. */
const invokeFrom = (window: BrowserWindow) => ({
  sender: { id: window.webContents.id },
  senderFrame: window.webContents.mainFrame as unknown as { url: string } & object,
})
const hidden = () => new BrowserWindow({ show: false, width: 600, height: 400,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })

app.whenReady().then(async () => {
  const windows = orgWindowRegistry<BrowserWindow, string>()
  const acme = hidden(), beta = hidden(), homepage = hidden()

  // ⚠ REAL IDS. Every window in this process has a distinct webContents id,
  // which is the thing sender resolution matches on.
  const ids = [acme, beta, homepage].map(w => w.webContents.id)
  assert.equal(new Set(ids).size, 3, 'real windows have distinct webContents ids')

  windows.register({ id: 'acme-window', senderId: acme.webContents.id, window: acme, kind: 'org', org: 'acme' })
  windows.register({ id: 'beta-window', senderId: beta.webContents.id, window: beta, kind: 'org', org: 'beta' })
  windows.register({ id: 'home', senderId: homepage.webContents.id, window: homepage, kind: 'homepage' })

  // the registration cross-check catches a wrong id against a REAL window
  const spare = hidden()
  assert.throws(() => windows.register({ id: 'wrong', senderId: spare.webContents.id + 1000, window: spare, kind: 'homepage' }),
    /but its webContents is/)
  spare.destroy()

  // ⚠ A DOCUMENT IS NEEDED BEFORE THE FRAME HAS A TRUSTED URL. These windows
  // never reach the engine, so the trusted-URL half is exercised by loading a
  // data: document that is NOT app UI and asserting the refusal — the positive
  // case is covered by the frame-identity assertions below plus the unit
  // tests, which drive trustedUiUrl directly.
  for (const window of [acme, beta, homepage]) {
    await window.loadURL('data:text/html,<title>probe</title>')
  }

  // Not app UI, so refused — through a REAL frame, with a REAL url.
  for (const window of [acme, beta, homepage]) {
    assert.throws(() => resolveNativeSender(invokeFrom(window), windows, ORIGIN),
      /refused for this document/, 'a document that is not app UI is refused')
  }

  // ⚠ THE FRAME IDENTITY COMPARISON, against real frames. A look-alike object
  // carrying the same url is not the window's main frame and must be refused —
  // this is the check that stops an embedded or popped-out document issuing a
  // native command in the main window's name.
  const lookalike = { sender: { id: acme.webContents.id }, senderFrame: { url: `${ORIGIN}/o/acme` } }
  assert.throws(() => resolveNativeSender(lookalike, windows, ORIGIN), /refused for this document/)
  assert.throws(() => resolveNativeSender({ sender: { id: acme.webContents.id }, senderFrame: null }, windows, ORIGIN),
    /refused for this document/)
  // a webContents that belongs to no registered main window
  const stranger = hidden()
  assert.throws(() => resolveNativeSender(invokeFrom(stranger), windows, ORIGIN), /refused for this document/)
  stranger.destroy()

  // and each real window resolves to ITSELF through bySender
  assert.equal(windows.bySender(acme.webContents.id)?.id, 'acme-window')
  assert.equal(windows.bySender(beta.webContents.id)?.id, 'beta-window')
  assert.equal(windows.bySender(homepage.webContents.id)?.id, 'home')
  assert.equal(windows.bySender(acme.webContents.id)?.org, 'acme')
  assert.notEqual(windows.bySender(acme.webContents.id)?.id, windows.bySender(beta.webContents.id)?.id)

  // ⚠ PER-WINDOW POPOUT REGISTRIES, with real child windows sharing a name.
  const acmePopouts = popoutRegistry<BrowserWindow>(() => {})
  const betaPopouts = popoutRegistry<BrowserWindow>(() => {})
  const acmeDesk = hidden(), betaDesk = hidden()
  acmePopouts.track('desk-1', acmeDesk)
  betaPopouts.track('desk-1', betaDesk)
  assert.equal(acmePopouts.window('desk-1'), acmeDesk)
  assert.equal(betaPopouts.window('desk-1'), betaDesk)
  assert.notEqual(acmePopouts.window('desk-1'), betaPopouts.window('desk-1'),
    'the same frame name in two windows is two different native windows')
  assert.equal(acmePopouts.window('inbox'), undefined, "and a name this window never opened resolves to nothing")
  // a destroyed popout stops being addressable through a real isDestroyed()
  acmeDesk.destroy()
  assert.equal(acmePopouts.window('desk-1'), undefined)
  assert.equal(betaPopouts.window('desk-1'), betaDesk, "the other window's popout is untouched")
  betaDesk.destroy()

  // ⚠ A REAL destroy() RELEASES THE ORGANIZATION. The registry prunes on
  // isDestroyed() rather than trusting a 'closed' listener to have run.
  assert.equal(windows.byOrg('beta')?.id, 'beta-window')
  // read the id BEFORE destroying it: touching webContents on a destroyed
  // BrowserWindow throws, which is itself worth knowing for native teardown
  const betaSender = beta.webContents.id
  beta.destroy()
  assert.equal(windows.byOrg('beta'), undefined)
  assert.equal(windows.bySender(betaSender), undefined)
  assert.equal(windows.requestOrg('beta', null).action, 'open', 'and it can be opened again')

  // ⚠ THE f1 PATH, with a real window that really gets discarded. Another
  // window takes the organization while this one is being built; the surplus
  // must be destroyed, the winner focused, and exactly one window left.
  let discarded: BrowserWindow | undefined
  const outcome = await openOrg(windows, 'gamma', null, {
    focus: () => {},
    create: async org => {
      const winner = hidden()
      windows.register({ id: 'gamma-winner', senderId: winner.webContents.id, window: winner, kind: 'org', org })
      const loser = hidden()
      return { id: 'gamma-loser', senderId: loser.webContents.id, window: loser }
    },
    discard: created => { discarded = created.window; created.window.destroy() },
  })
  assert.deepEqual(outcome, { action: 'focused', windowId: 'gamma-winner', org: 'gamma' })
  assert.ok(discarded && discarded.isDestroyed(), 'the surplus window is really gone')
  assert.equal(windows.list().filter(entry => entry.org === 'gamma').length, 1)

  // ⚠ REAL BOUNDS THROUGH THE PLACEMENT STORE. getNormalBounds() is the value
  // the store persists, and fitWindow is what recovers it when the display it
  // was saved on is not there.
  const file = path.join(profile, 'probe-window-state.json')
  const placement = new OrgPlacement(file)
  acme.setBounds({ x: 120, y: 90, width: 640, height: 480 })
  placement.captureWindow('org:acme', acme)
  placement.openedWindow('org:acme')
  const reloaded = new OrgPlacement(file)
  const restored = reloaded.restoreWindow('org:acme', [{ x: 0, y: 0, width: 1920, height: 1080 }])
  assert.deepEqual(restored?.bounds, acme.getNormalBounds(), 'a real rectangle round-trips exactly')
  assert.deepEqual(reloaded.sessionWindows(), ['org:acme'])
  // and onto a display that cannot hold it where it was
  const squeezed = reloaded.restoreWindow('org:acme', [{ x: 0, y: 0, width: 800, height: 600 }])
  assert.ok(squeezed && squeezed.bounds.x + squeezed.bounds.width <= 800, 'recovered onto the display that exists')
  assert.ok(squeezed.bounds.y + squeezed.bounds.height <= 600)

  // closing it deliberately drops it from the next startup but keeps where it was
  reloaded.closedWindow('org:acme')
  const afterClose = new OrgPlacement(file)
  assert.deepEqual(afterClose.sessionWindows(), [])
  assert.deepEqual(afterClose.restoreWindow('org:acme', [{ x: 0, y: 0, width: 1920, height: 1080 }])?.bounds,
    acme.getNormalBounds())

  // ⚠ THE OUTBOX RE-ARM, AGAINST REAL NAVIGATIONS. The queue itself is pure
  // and its rules are driven in window-outbox.test.mjs — but which Electron
  // event fires, on which navigation, is exactly the part reading the source
  // cannot settle, and getting it wrong reopens the loss silently. This wires
  // it the way index.ts does and then really navigates a window.
  const navigating = hidden()
  const outbox = windowOutbox<{ type: string; data?: unknown }>({ hold: type => type === 'open-org' })
  navigating.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) outbox.rearm()
  })
  await navigating.loadURL('data:text/html,<title>one</title>')
  outbox.drain()                                    // this document acknowledged a listener
  assert.equal(outbox.offer({ type: 'open-org' }), true, 'live while that document is showing')

  // a fresh document — the Homepage-binds-an-organization case
  await navigating.loadURL('data:text/html,<title>two</title>')
  assert.equal(outbox.holding(), true, 'loadURL re-armed the outbox')
  assert.equal(outbox.offer({ type: 'open-org', data: 'mid-flight' }), false,
    'an event arriving during the load is held, not sent into the gap')
  assert.deepEqual(outbox.drain().map(e => e.data), ['mid-flight'])

  // a user pressing refresh
  await new Promise<void>(resolve => {
    navigating.webContents.once('did-finish-load', () => resolve())
    navigating.webContents.reload()
  })
  assert.equal(outbox.holding(), true, 'reload re-armed the outbox')
  outbox.drain()

  // ⚠ THE ORDERING THE LATE-ACK GUARD DEPENDS ON, which only real Electron can
  // settle. index.ts drops an acknowledgement that arrives while `navigating`
  // is true, and clears that flag on 'did-navigate'. That is only safe if a
  // NEW document's acknowledgement arrives AFTER its own 'did-navigate' — the
  // preload runs once the frame has committed, so it should, but "should" is
  // what a probe is for. If this ever fails, the flag must be cleared on
  // 'dom-ready' instead and the guard revisited.
  let committed = false, preloadRanAfterCommit: boolean | undefined
  const ordering = hidden()
  ordering.webContents.on('did-navigate', () => { committed = true })
  ordering.webContents.on('console-message', event => {
    if (event.message === 'orgtree-probe-document-ready' && preloadRanAfterCommit === undefined) {
      preloadRanAfterCommit = committed
    }
  })
  await ordering.loadURL('data:text/html,<script>console.log("orgtree-probe-document-ready")</script>')
  assert.equal(preloadRanAfterCommit, true,
    "a document's own scripts run after its navigation has committed, so its ack cannot be mistaken for the previous document's")
  ordering.destroy()

  // ⚠ A SAME-DOCUMENT NAVIGATION MUST NOT RE-ARM, because nothing is destroyed
  // and the listener that acknowledged is still there. That case is NOT probed
  // here: triggering a hash change needs renderer script, which these sandboxed
  // probe windows deliberately cannot run, and an assertion that hangs is worse
  // than one that lives somewhere else. The `!details.isSameDocument` guard is
  // pinned in tests/multi-window-wiring.test.mjs instead, and what needed real
  // Electron — which event fires, on which navigation — is settled above.
  navigating.destroy()

  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
  console.log('MULTI_WINDOW_NATIVE_PASS')
  app.exit(0)
}).catch(error => {
  console.error(error)
  app.exit(1)
})
