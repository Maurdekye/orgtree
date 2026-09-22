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
import { app, BrowserWindow, ipcMain } from 'electron'
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

  // ⚠ READINESS AGAINST REAL NAVIGATION OUTCOMES. The queue itself is pure and
  // its rules are driven in window-outbox.test.mjs — but WHICH Electron event
  // fires, on which outcome, is exactly what reading the source cannot settle,
  // and getting it wrong wedges the queue either open or shut. This wires it
  // the way index.ts does: re-arm on COMMIT, and accept a readiness message
  // only from the document currently showing.
  const navigating = hidden()
  const outbox = windowOutbox<{ type: string; data?: unknown }>({ hold: type => type === 'open-org' })
  let documentToken = ''
  // index.ts mints the token when a document announces itself; here the
  // announcement is stood in for, because a probe window has no preload.
  const announce = () => { documentToken = `doc-${Math.abs(navigating.webContents.getURL().length)}-${++announced}` ; return documentToken }
  let announced = 0
  const acknowledge = (token: string) => { if (token === documentToken) outbox.drain() }
  navigating.webContents.on('did-navigate', () => { documentToken = ''; outbox.rearm() })

  await navigating.loadURL('data:text/html,<title>one</title>')
  acknowledge(announce())                            // this document says it is listening
  assert.equal(outbox.offer({ type: 'open-org' }), true, 'live while that document is showing')

  // A FRESH DOCUMENT — the case where a window navigates while an event for it
  // is in flight.
  const staleToken = documentToken
  await navigating.loadURL('data:text/html,<title>two</title>')
  assert.equal(outbox.holding(), true, 'commit re-armed the outbox')
  assert.equal(outbox.offer({ type: 'open-org', data: 'mid-flight' }), false,
    'an event arriving during the load is held, not sent into the gap')
  // ⚠ AND THE OUTGOING DOCUMENT CANNOT SPEAK FOR ITS SUCCESSOR. Its readiness
  // message may still be in flight; accepting it would unhold the queue on the
  // strength of a listener that no longer exists, and carry the queue away.
  acknowledge(staleToken)
  assert.equal(outbox.holding(), true, "the old document's late readiness is refused")
  assert.equal(outbox.pending(), 1, 'and it takes nothing with it')
  acknowledge(announce())
  assert.deepEqual(outbox.drain().map(e => e.data), [], 'the new document drained it exactly once')

  // A USER PRESSING REFRESH.
  outbox.offer({ type: 'open-org', data: 'x' })
  await new Promise<void>(resolve => {
    navigating.webContents.once('did-finish-load', () => resolve())
    navigating.webContents.reload()
  })
  assert.equal(outbox.holding(), true, 'reload re-armed the outbox')
  acknowledge(announce())
  assert.equal(outbox.holding(), false)

  // ⚠ A NAVIGATION THAT FAILS DOES NOT COMMIT, so it does not re-arm here —
  // and that is a statement about THIS listener, not about the window being
  // fine. It is not fine: Chromium replaces the document with an error page,
  // which carries no preload and no bridge and can never say it is listening.
  //
  // An earlier version of this block asserted the same fact under the comment
  // "events still reach the document that is actually showing". The fact was
  // measured correctly and the explanation was false, and held events were
  // being fired into the error page for as long as it was up. The failure case
  // is handled by `documentLost` on the load recovery instead, which clears
  // the dead document's token and re-arms together; it is driven in
  // tests/window-load-recovery.test.mjs, including the aborted, subframe and
  // obsolete-failure cases that must NOT be treated as a lost document.
  const before = documentToken
  await navigating.loadURL('http://127.0.0.1:9/never-serves-anything').catch(() => {})
  assert.equal(documentToken, before, 'a failed navigation announced no new document')
  assert.equal(outbox.holding(), false,
    'the commit listener did not re-arm, because a failure never commits')
  // ⚠ DELIBERATELY NOT ASSERTED HERE: that events still reach anybody. They
  // do not — what is showing is an error page. Saying so was the defect.
  navigating.destroy()

  // ⚠ A SAME-DOCUMENT NAVIGATION MUST NOT RE-ARM, because nothing is destroyed
  // and the listener that acknowledged is still there. That case is NOT probed
  // here: triggering a hash change needs renderer script, which these sandboxed
  // probe windows deliberately cannot run, and an assertion that hangs is worse
  // than one that lives somewhere else. The `!details.isSameDocument` guard is
  // pinned in tests/multi-window-wiring.test.mjs instead, and what needed real
  // Electron — which event fires, on which navigation — is settled above.
  navigating.destroy()

  // ⚠⚠ THE IPC ARGUMENT ABI, MEASURED - AND READ THE LIMITS BEFORE CITING IT.
  //
  // WHY IT EXISTS. The production handler read the document token off
  // `event.args[0]`. An `IpcMainEvent` has no `args` property in Electron's
  // typings or at runtime, so the f5/f6 guard was handed `undefined`,
  // correctly judged every document stale, and the acknowledgement quietly
  // stopped acknowledging - leaving held events to wait for a
  // `takePendingWindowEvents` that a renderer using only `onEvent`, the v2 one
  // included, never makes. Nothing caught it because the probe above MODELS
  // the acknowledgement, and a model cannot catch a mistake that lives in the
  // modelling.
  //
  // ⚠ WHAT THIS SECTION ACTUALLY ESTABLISHES, which is narrower than it first
  // appears (multi-window-design, source inspection at e05f164):
  //
  //   ✓ Electron's callback-argument ABI, from a REAL renderer through a real
  //     `ipcRenderer.send`: `'args' in event` is false, and what the renderer
  //     sent arrives as the listener's SECOND parameter. That is the fact the
  //     production fix turns on, and it is measured rather than assumed.
  //   ✓ that the guard's arithmetic is right when fed that argument: a stale
  //     token drains nothing and leaves the queue holding, and the current one
  //     drains exactly once - each checked AS ITS MESSAGE IS HANDLED.
  //
  //   ✗ NOT the production `desktop:events-listening` handler. The channels
  //     here are `probe:` ones and the guard is a COPY of index.ts's shape.
  //   ✗ NOT the production preload, and NOT `resolveNativeSender`.
  //   ✗ NOT delivery to a renderer. The drained events land in a main-process
  //     array; nothing is sent to a window and no renderer receives anything.
  //
  // The end-to-end receipt - production host, production preload, a real
  // consumer, and the ACK-ONLY path with no take - belongs to the shell
  // composition fixture, where there is a renderer that actually consumes.
  // Deliberately NOT closed by copying more of index.ts into this file:
  // another copied handler would widen the same overstatement rather than
  // retire it.
  const ackPreload = path.join(profile, 'ack-preload.js')
  fs.writeFileSync(ackPreload, [
    "const { ipcRenderer } = require('electron')",
    // the real preload's shape: announce synchronously, keep the token private
    "const announced = ipcRenderer.sendSync('probe:identity-sync')",
    // a stale token first, so the refusal is observed before the delivery
    "ipcRenderer.send('probe:events-listening', 'A-TOKEN-FROM-NOWHERE')",
    "ipcRenderer.send('probe:events-listening', announced.token)",
  ].join('\n'))

  let minted = ''
  ipcMain.on('probe:identity-sync', event => {
    minted = `document-${event.sender.id}`
    event.returnValue = { identity: null, token: minted }
  })
  const real = windowOutbox<{ type: string; data?: unknown }>({ hold: type => type === 'open-org' })
  real.offer({ type: 'open-org', data: 'waiting-for-a-real-renderer' })
  const drained: unknown[] = []
  const observed: { hasArgs: boolean; eventArgs: unknown; second: unknown; drainedAfter: number; holdingAfter: boolean }[] = []
  // EXACTLY index.ts's shape, including the argument position under test.
  ipcMain.on('probe:events-listening', (event, token: unknown) => {
    if (typeof token === 'string' && !!token && token === minted) drained.push(...real.drain())
    // ⚠ RECORDED PER MESSAGE, NOT ONLY AT THE END. Checking the final contents
    // of `drained` cannot tell "the stale token was refused and the valid one
    // drained" from "the stale token drained and the valid one found an empty
    // queue" - both leave exactly one event in it. The state AS EACH MESSAGE
    // IS HANDLED is what distinguishes them.
    observed.push({
      hasArgs: 'args' in (event as unknown as object),
      eventArgs: (event as unknown as { args?: unknown }).args,
      second: token,
      drainedAfter: drained.length,
      holdingAfter: real.holding(),
    })
  })

  const bothArrived = new Promise<void>(resolve => {
    const tick = setInterval(() => { if (observed.length >= 2) { clearInterval(tick); resolve() } }, 10)
  })
  const acking = new BrowserWindow({ show: false, width: 400, height: 300,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: ackPreload } })
  await acking.loadURL('data:text/html,<title>ack</title>')
  await bothArrived

  // ⚠ THE NEGATIVE CONTROL, and the whole reason this section exists: there is
  // no `args` on the event, so any handler reading one is reading `undefined`.
  assert.equal(observed.length, 2, 'both sends arrived, in order')
  for (const row of observed) {
    assert.equal(row.hasArgs, false, 'an IpcMainEvent carries no `args` property')
    assert.equal(row.eventArgs, undefined, 'and reading one yields undefined, which no token can equal')
  }
  // and the value the renderer sent is the SECOND callback argument
  assert.equal(observed[0].second, 'A-TOKEN-FROM-NOWHERE')
  assert.equal(observed[1].second, minted)
  assert.ok(minted.startsWith('document-'), 'the synchronous announcement really answered')

  // ⚠ THE ORDER, PROVEN PER MESSAGE RATHER THAN INFERRED FROM THE END STATE.
  assert.equal(observed[0].drainedAfter, 0, 'the stale token drained nothing')
  assert.equal(observed[0].holdingAfter, true, 'and left the queue holding')
  assert.equal(observed[1].drainedAfter, 1, 'the current one drained, and drained exactly once')
  assert.equal(observed[1].holdingAfter, false, 'and only then did the holding end')
  assert.deepEqual(drained.map(e => (e as { data?: unknown }).data), ['waiting-for-a-real-renderer'])
  assert.equal(real.pending(), 0)
  acking.destroy()

  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy()
  console.log('MULTI_WINDOW_NATIVE_PASS')
  app.exit(0)
}).catch(error => {
  console.error(error)
  app.exit(1)
})
