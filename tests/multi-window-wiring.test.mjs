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
  assert.match(main, /otherMainsVisible: \[\.\.\.records\.values\(\)\]\.some\(other => other !== record && !other\.window\.isDestroyed\(\) && other\.window\.isVisible\(\)\)/)
  assert.match(main, /otherViews: BrowserWindow\.getAllWindows\(\)\.filter\(w => w !== window && w\.isVisible\(\)\)\.length/)
  const rule = read('apps/desktop/main/window-close.ts')
  // the existing last-window rule is reached unchanged
  assert.match(rule, /const action = closeAction\(input\.exitOnClose, input\.quitting, input\.otherViews\)/)
  assert.match(rule, /if \(!input\.otherMainsVisible\) \{/, 'the tray rule belongs to the LAST window only')
  // and it closes its OWN popouts, nobody else's
  assert.match(main, /for \(const child of record\.owned\) if \(!child\.isDestroyed\(\)\) child\.close\(\)/)
  assert.match(main, /record\.tearingDown = true/, 'so their state events say the parent took them')
})

test('NEGATIVE CONTROL: exactly one close listener, and the teardown is unreachable from a refusal', () => {
  const main = read('apps/desktop/main/index.ts')
  // ⚠ Electron runs EVERY 'close' listener even when one calls preventDefault,
  // so a second one doing the teardown runs on the paths the first has just
  // refused. Two listeners cannot be made safe by ordering them: the danger is
  // that one runs AT ALL after the other refused. The rule and its teardown
  // therefore live in one function (window-close.ts), where the teardown is
  // reachable through exactly one branch — and the behaviour of every branch,
  // refused and accepted, is driven directly in tests/window-close.test.mjs.
  const factory = main.slice(main.indexOf('const buildMainWindow ='), main.indexOf('const routeFor ='))
  assert.equal(factory.split("window.on('close'").length - 1, 1,
    'exactly one close listener, so none of them can run past a preventDefault')
  assert.match(factory, /performClose\(\{/, 'and it delegates the rule rather than inlining it')
  // the teardown is a single callback, so a future fix cannot move part of it
  assert.match(factory, /teardown: \(\) => \{/)
  assert.equal(factory.split('record.tearingDown = true').length - 1, 1,
    'set in one place only, so a refused close cannot leave the flag lying')
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
  assert.match(main, /creation: quitting \? 'close' : windows\.beginClose\(id\)/)
  const closeRule = read('apps/desktop/main/window-close.ts')
  assert.match(closeRule, /if \(input\.creation === 'awaiting'\) \{ host\.preventDefault\(\); return 'refuse' \}/)
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

test('startup reopens every saved window and checks none of them first', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /preferences\.get\(\)\.startupMode === 'homepage' \? \[\] : \(placement\?\.sessionWindows\(\) \?\? \[\]\)/)
  // ⚠ User ruling 2026-09-21: an organization that cannot be opened is restored
  // in the ordinary unavailable state rather than skipped, because nothing can
  // tell it from a deleted one - a per-org GET maps every failure to 404,
  // authorization included. So the catalog must not be consulted here at all:
  // the round-trip existed solely to answer a question this must not ask.
  const startup = main.slice(main.indexOf('const openStartupWindows ='), main.indexOf('const first = await openStartupWindows()'))
  assert.doesNotMatch(startup, /orgActivity/, 'startup asks the catalog nothing')
  assert.match(startup, /const plan = planRestore\(saved\.map\(key => \{ const org = orgOfKey\(key\); return org === undefined \? \{\} : \{ org \} \}\)\)/)
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
  // ⚠ the identity is answered SYNCHRONOUSLY, before the bridge exists - and
  // it lives in held-events.ts now, with the two channels that depend on the
  // token it mints
  assert.match(read('apps/desktop/main/held-events.ts'),
    /ipc\.on\('desktop:window-identity-sync', \(event: \{ returnValue\?: unknown \}\) => \{/,
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

test('events that cannot be asked for again are held until there is somewhere to send them', () => {
  const main = read('apps/desktop/main/index.ts')
  const preload = read('apps/desktop/preload/index.ts')
  // ⚠ ONLY the events a renderer has no way to rediscover. Window state,
  // popout state and main-window-shown are all re-readable through the bridge,
  // so holding them could only hand over a stale duplicate.
  assert.match(main, /const HELD_EVENT_TYPES = new Set<DesktopEvent\['type'\]>\(\['open-org', 'notification-click', 'window-identity', 'restore-skipped'\]\)/)
  for (const readable of ['window-state', 'popout-state', 'main-window-shown', 'engine-status', 'preferences']) {
    assert.doesNotMatch(main, new RegExp(`HELD_EVENT_TYPES[\s\S]{0,200}'${readable}'`), readable)
  }

  // ⚠ NO TIMER, ANYWHERE. Sending held events once a grace expires marks them
  // delivered whether or not anybody is listening — the original loss with a
  // delay in front of it. A longer grace is a later guess, not a better one.
  // The queue's own size bound is what stops a window whose renderer never
  // arrives accumulating for ever, and it drops the oldest rather than
  // pretending the newest was seen. Driven directly in window-outbox.test.mjs.
  assert.doesNotMatch(main, /HELD_EVENT_GRACE|flushTimer/,
    'no timer may discharge held events')
  assert.match(main, /outbox: windowOutbox<DesktopEvent>\(\{ hold: type => HELD_EVENT_TYPES\.has\(type as DesktopEvent\['type'\]\) \}\)/)
  assert.match(main, /if \(record\.outbox\.offer\(event\)\) record\.window\.webContents\.send\('desktop:event', event\)/)

  // holding ends on evidence of a consumer, and on nothing else: a listener
  // attaching, or the renderer asking for what was held
  assert.match(preload, /ipcRenderer\.send\('desktop:events-listening', documentToken\)/)
  const attach = preload.indexOf("ipcRenderer.on('desktop:event', handler)")
  assert.ok(attach > 0 && attach < preload.indexOf("ipcRenderer.send('desktop:events-listening'"),
    'the listener is attached BEFORE native is told it exists')
  // ⚠ THE THREE HELD-EVENT CHANNELS LIVE IN THEIR OWN MODULE NOW, and that
  // is the point rather than an inconvenience: as closures inside
  // app.whenReady() they were reachable by no test at all, which is how a dead
  // acknowledgement survived a full review. index.ts calls the same function
  // the composition fixture does.
  const held = read('apps/desktop/main/held-events.ts')
  assert.match(main, /registerHeldEventChannels\(ipcMain, \{/, 'index.ts registers them through that module')
  assert.doesNotMatch(main, /ipcMain\.on\('desktop:events-listening'/, 'and no longer inline')
  // ⚠ AND THE ORIGIN IS READ PER CALL, NOT CAPTURED. The engine's origin
  // changes after a boot-engine recovery; a frozen string would keep
  // validating against the dead one. A getter is the whole guard.
  assert.match(main, /origin: \(\) => engine\.origin/, 'the host passes a getter, never a captured string')
  assert.match(held, /origin\(\): string/)
  assert.doesNotMatch(held, /origin: string/, 'no frozen origin may enter this module')
  const listening = held.slice(held.indexOf("ipc.on('desktop:events-listening'"), held.indexOf("ipc.on('desktop:window-identity-sync'"))
  // ⚠ SENDER-RESOLVED LIKE EVERY OTHER NATIVE ENTRY POINT - through ONE
  // helper that all three channels share, which calls the REAL
  // resolveNativeSender. What differs between them is only what they do with
  // a refusal: the two `on` channels have no caller to reject so they
  // swallow, the `handle` channel rejects the invoke. That difference is
  // preserved behaviour, not an accident of the move.
  assert.match(listening, /resolveRecord\(host, event\)/)
  // resolved against the LIVE registry, with the origin read per call
  assert.match(held, /const entry = resolveNativeSender\($/m)
  assert.match(held, /host\.registry, host\.origin\(\)\)$/m)
  assert.match(held, /import \{ resolveNativeSender \} from '\.\/org-windows'/,
    'resolveNativeSender is IMPORTED and called here, not handed in')
  // ⚠ AND THE HOST CANNOT SUPPLY JUDGEMENT. A host that could hand in a
  // resolver, or the currency comparison, would let a fixture exercise its own
  // permissiveness and call it coverage - which is the exact failure that let
  // a dead acknowledgement pass a full review.
  const host = held.slice(held.indexOf('export interface HeldEventHost'), held.indexOf('⚠ IS THE DOCUMENT THAT SENT THIS'))
  assert.doesNotMatch(host, /resolve|currentDocument|trusted/i, 'nothing deciding trust crosses the host boundary')
  assert.doesNotMatch(held, /export const currentDocument|export function currentDocument/,
    'one currency rule, not re-exported for anyone to re-implement')
  assert.equal(held.split('currentDocument(').length - 1, 2,
    'asked by exactly the two paths that end the holding')
  // ⚠ AND A LATE ACK FROM THE OUTGOING DOCUMENT IS DROPPED, not deferred.
  // The old document may have sent its ack a moment before it was navigated
  // away from, and that message can still be in flight. Accepting it would
  // unhold the queue on the strength of a listener that no longer exists -
  // the same loss, one message later. Deferring it to the new document
  // would assert the successor is listening, which is what nothing has
  // established yet.
  assert.match(listening, /if \(record && currentDocument\(host, record, token\)\)/,
    'the acknowledgement is accepted only from the document currently showing')

  // ⚠ AND THE TOKEN IS READ FROM THE PLACE ELECTRON ACTUALLY PUTS IT. This
  // handler once read `event.args[0]`; `ipcMain.on` delivers a renderer's
  // arguments as the listener's TRAILING PARAMETERS, and an IpcMainEvent has
  // no `args` property at all — so the guard above was handed `undefined`,
  // correctly judged every document stale, and the acknowledgement silently
  // stopped acknowledging. Held events then waited for a take that a renderer
  // using only `onEvent` never makes.
  //
  // ⚠ THE ABI IS MEASURED against real Electron in
  // tests/multi-window-native.probe.ts, from a real preload through a real
  // send. THE PRODUCTION HANDLER IS NOT: that probe uses `probe:` channels and
  // a copy of the guard, and its drained events land in a main-process array,
  // so it proves the argument position and the guard's arithmetic and nothing
  // about this handler, the preload or delivery to a renderer. The line below
  // is a SOURCE pin tying this handler to the measured ABI - not a claim that
  // it was executed. End-to-end receipt belongs to the shell composition
  // fixture, including the ack-only path with no take.
  assert.match(listening, /ipc\.on\('desktop:events-listening', \(event: unknown, token: unknown\) =>/,
    'the token is the second callback argument, which is where it arrives')
  assert.doesNotMatch(listening, /\.args/, 'and never read off the event, where it does not exist')
  for (const file of [main, held]) {
    assert.doesNotMatch(file, /as unknown as \{ args\?: unknown\[\] \}/,
      'no handler anywhere invents an `args` property on an IPC event')
  }
  // ⚠ AND THE TAKE IS THE ONE THAT REJECTS. The two `on` channels have no
  // caller to reject and stay silent; this one rejected before the move,
  // through index.ts's `handle`, and must still. A shared helper that threw
  // for a missing record would have changed identity-sync too - it answered
  // with a real identity and an unstored token, and still does.
  assert.match(held, /if \(!record\) throw new Error\('Native operation refused for this document'\)/)
  assert.match(held, /if \(record\) host\.setToken\(record, token\)/,
    'identity-sync stores the token only when there is a record, and answers either way')

  // ⚠ AND THE EVIDENCE IS PER-DOCUMENT. A listener belongs to a document, so a
  // navigation destroys the very thing that proved somebody was there — while
  // the outbox lives on the window and outlives every document it shows.
  //
  // ⚠ COMMIT, NOT NAVIGATION START. `did-navigate` fires when a main-frame
  // navigation is DONE and never for an in-page one, so it marks the instant
  // the old document is gone and the new one is showing with no listener yet.
  // A navigation that FAILS never commits and so never fires it, which is
  // exactly right: the old document is still there and already acknowledged.
  // Re-arming at navigation START would hold on a promise the navigation might
  // not keep, and then need every failure mode enumerated to let go again —
  // which is how a latch wedges shut for the window's life.
  assert.match(main, /window\.webContents\.on\('did-navigate', \(\) => \{/)
  const commit = main.slice(main.indexOf("window.webContents.on('did-navigate'"))
  assert.match(commit.slice(0, 400), /record\.documentToken = ''/)
  assert.match(commit.slice(0, 400), /record\.outbox\.rearm\(\)/)
  // ⚠ HOLDING STARTS AT COMMIT, NOT AT NAVIGATION START - and THAT is the
  // property, not the absence of a listener. f5 was a latch set at navigation
  // start that a non-committing navigation never released. A listener that
  // only SNAPSHOTS cannot do that, so the assertion is about what the listener
  // touches: no queue state may be changed there. (An earlier version forbade
  // the string itself, which blocked both the explanation of why a bind needs
  // none of this and the identity snapshot the failure guard depends on.)
  const startNav = main.includes("window.webContents.on('did-start-navigation'")
    ? main.slice(main.indexOf("window.webContents.on('did-start-navigation'"), main.indexOf("window.webContents.on('did-navigate'"))
    : ''
  assert.doesNotMatch(startNav, /rearm|drain|offer/,
    'holding starts at commit, not at navigation start')

  // ⚠ AND A BIND DOES NOT NAVIGATE AT ALL, which is why it needs no held-event
  // handling. Native tells the renderer what the window now is; the renderer
  // moves itself with history.pushState - a SAME-DOCUMENT navigation that
  // fires did-navigate-in-page and never did-navigate, leaving the document,
  // the token and the listener all alive. A composition probe went looking for
  // a gap between an old document and a new one on this path; there is no new
  // one. Measured against real Electron.
  const adopt = main.slice(main.indexOf('adoptIdentity = (record: MainWindowRecord)'), main.indexOf('const openWindow = async'))
  assert.doesNotMatch(adopt, /loadURL/, 'binding a window does not load a document')
  assert.match(adopt, /sendTo\(record\.id, \{ type: 'window-identity', data: identity \}\)/,
    'it tells the renderer what the window now is, and the renderer routes itself')
  assert.doesNotMatch(main, /record\.navigating/, 'and there is no latch to wedge')

  // ⚠ BOTH WAYS OF ENDING THE HOLDING ASK THE SAME QUESTION, IN ONE PLACE.
  // They are the same question — "is the document asking me the one currently
  // showing?" — and when only one of them asked it, the other could unhold the
  // queue from a document on its way out AND carry the queue away with it.
  assert.match(held, /const currentDocument = <W extends MainWindowLike & NativeSenderWindow, R, E>\(/)
  // exactly two CALLS - the acknowledgement and the take - so neither entry
  // point can be guarded while the other is not. (The definition itself is
  // `currentDocument = <` and so is not one of them.)
  assert.equal(held.split('currentDocument(host,').length - 1, 2,
    'asked by exactly the two paths that end the holding')
  // index.ts keeps no second COPY of the rule - it may name it in a comment,
  // but it must neither define it nor call it, because one rule with two
  // callers is what stopped the guarded-ack / unguarded-take defect recurring
  assert.doesNotMatch(main, /const currentDocument\s*=/, 'index.ts does not redefine the rule')
  assert.doesNotMatch(main, /currentDocument\(/, 'and never calls it behind the module back')
  const take = held.slice(held.indexOf("ipc.handle('desktop:take-pending-events'"))
  assert.match(take, /currentDocument\(host, record, token\) \? host\.drain\(record\) : \[\]/)

  // the token is minted where a document announces itself, and quoted back
  assert.match(held, /const token = randomUUID\(\)/)
  assert.match(main, /setToken: \(record, token\) => \{ record\.documentToken = token \}/,
    'the host stores it; the module decides when')
  assert.match(preload, /ipcRenderer\.send\('desktop:events-listening', documentToken\)/)
  assert.match(preload, /ipcRenderer\.invoke\('desktop:take-pending-events', documentToken\)/)
  // ⚠ and it never reaches page script: it is the preload's private evidence
  const bridge = preload.slice(preload.indexOf('const bridge: DesktopBridge = {'), preload.indexOf('contextBridge.exposeInMainWorld'))
  assert.doesNotMatch(bridge, /documentToken,/, 'the token is not exposed on the bridge object')
})

// ------------------------------------------------------- real Electron

test('real Electron probe: sender resolution, per-window popouts, discard and placement', async () => {
  // The unit tests drive the registry through narrow interfaces, which proves
  // the rules and says nothing about Electron. This runs the same rules
  // against REAL BrowserWindows: real webContents ids, real mainFrame identity
  // comparisons, a real destroy() releasing an organization, a real surplus
  // window being discarded, and real getNormalBounds() through the placement
  // store. Nothing here starts an engine, loads app UI, shows a window or
  // touches user data.
  const { spawnSync } = await import('node:child_process')
  const { createRequire } = await import('node:module')
  const os = await import('node:os')
  const { build } = await import('esbuild')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-multiwindow-probe-'))
  const script = path.join(dir, 'probe.cjs')
  await build({
    entryPoints: [path.join(root, 'tests/multi-window-native.probe.ts')],
    outfile: script, bundle: true, format: 'cjs', platform: 'node', external: ['electron'],
  })
  const electron = createRequire(import.meta.url)('electron')
  const env = { ...process.env, ORGTREE_ELECTRON_TEST_ROOT: path.join(dir, 'profile') }
  delete env.ELECTRON_RUN_AS_NODE
  const res = spawnSync(electron, [script], { encoding: 'utf8', timeout: 60000, windowsHide: true, env })
  assert.equal(res.status, 0, `native probe failed: ${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /MULTI_WINDOW_NATIVE_PASS/)
})

// ------------------------------------------------ app-wide snapshot reads

test('every app-wide broadcast has a snapshot getter, and maintenance reports no report honestly', () => {
  const main = read('apps/desktop/main/index.ts')
  const preload = read('apps/desktop/preload/index.ts')
  const contracts = read('packages/contracts/index.ts')

  // ⚠ A BROADCAST IS GONE BY THE TIME A LATE WINDOW ASKS. Multi-window makes
  // that ordinary rather than exceptional: a window opened now has missed
  // every app-wide event so far, so each of them needs a way to be READ. Four
  // had one; `maintenance` did not, which left the one state a renderer could
  // only learn by having already been listening.
  const getters = {
    'engine-status': "handleApp('desktop:status'",
    preferences: "handleApp('desktop:preferences'",
    update: "handleApp('desktop:update-status'",
    'open-orgs': "handleApp('desktop:open-orgs'",
    maintenance: "handleApp('desktop:maintenance-status'",
  }
  for (const [event, getter] of Object.entries(getters)) {
    assert.ok(main.includes(getter), `the app-wide '${event}' event has a snapshot getter`)
  }

  // the getter answers from what was BROADCAST, so the two cannot disagree
  const report = main.slice(main.indexOf('report: state => {'), main.indexOf("broadcastAll({ type: 'maintenance'"))
  assert.match(report, /lastMaintenance = \{ state \}/, 'the reported payload is remembered as it is sent')
  assert.match(main, /handleApp\('desktop:maintenance-status', \(\) => lastMaintenance \?\? null\)/)

  // ⚠ AND NO REPORT IS REPORTED AS NO REPORT. Seeding the value with 'idle' -
  // or any other plausible resting state - answers with something the engine
  // never sent, and a renderer cannot tell that apart from a real report.
  const at = main.indexOf('let lastMaintenance')
  const declaration = main.slice(at, main.indexOf('\n', at))
  assert.match(declaration, /let lastMaintenance: \{ state: string \} \| undefined/)
  assert.doesNotMatch(declaration, /=/, 'it starts unset, standing for nothing having been reported')

  // it is app-wide, like the event: every window may read it, none may write
  assert.ok(!main.includes("handleOwner('desktop:maintenance-status'"))
  assert.match(preload, /getMaintenanceStatus: \(\) => ipcRenderer\.invoke\('desktop:maintenance-status'\)/)
  // optional on the bridge, because a v2 renderer has no such member
  assert.match(contracts, /getMaintenanceStatus\?\(\): Promise<\{ state: string \} \| null>/)
})

test('real Electron probe: a renderer cannot see its own window, so native measures it', async () => {
  // ⚠ THE ONE FINDING IN THIS FILE THAT NOBODY WOULD BELIEVE FROM SOURCE.
  // `screenX`/`screenY`/`outerWidth`/`outerHeight` are frozen at creation in
  // every renderer, so the popout geometry the renderer used to save was its
  // OPENER's rectangle. The probe proves it against the product's own
  // `configureWindow` and about:blank popout path — and, crucially, shows
  // `innerWidth`/`innerHeight` tracking the same resize exactly, which is what
  // separates a real finding from a fixture that never laid the window out.
  const { spawnSync } = await import('node:child_process')
  const { createRequire } = await import('node:module')
  const os = await import('node:os')
  const { build } = await import('esbuild')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-popout-bounds-'))
  const script = path.join(dir, 'probe.cjs')
  await build({
    entryPoints: [path.join(root, 'tests/popout-bounds.probe.ts')],
    outfile: script, bundle: true, format: 'cjs', platform: 'node', external: ['electron'],
  })
  const electron = createRequire(import.meta.url)('electron')
  const env = { ...process.env, ORGTREE_ELECTRON_TEST_ROOT: path.join(dir, 'profile') }
  delete env.ELECTRON_RUN_AS_NODE
  const res = spawnSync(electron, [script], { encoding: 'utf8', timeout: 90000, windowsHide: true, env })
  assert.equal(res.status, 0, `popout bounds probe failed: ${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /POPOUT_BOUNDS_PASS/)
})

test('a failed load discards the document it actually killed, and never a live one', () => {
  const main = read('apps/desktop/main/index.ts')
  const recovery = read('apps/desktop/main/window-load-recovery.ts')

  // ⚠ A TERMINAL LOAD FAILURE NEVER COMMITS. Chromium replaces the document
  // with an error page and fires did-fail-load, not did-navigate — so the
  // commit handler does not run, and without this the outbox stayed live and
  // held events were sent into a page with no preload, no bridge and no
  // listener. Delivered by our reckoning, received by nobody.
  assert.match(main, /documentLost: \(\) => \{/)
  // the token is cleared AND the queue re-armed, together: re-arming alone
  // leaves the dead document's token valid, so an acknowledgement already in
  // flight from it could still discharge the queue into the error page
  const lost = main.slice(main.indexOf('documentLost: () => {'), main.indexOf('setTimer: (fn, ms)'))
  assert.match(lost, /record\.documentToken = ''/)
  assert.match(lost, /record\.outbox\.rearm\(\)/)

  // ⚠ GATED ON DOCUMENT IDENTITY, NOT ON THE URL. The recovery retries the
  // SAME url, so a stale failure and a live one are indistinguishable by URL
  // at exactly the moment it matters. `pendingFrom` is the token of the
  // document the navigation was leaving; if the current token has moved on, a
  // document has since announced itself and this failure is stale. Discarding
  // a LIVE document's token would re-arm behind a listener that already
  // registered and never registers again — a hold nothing can release.
  assert.match(lost, /if \(record\.documentToken !== pendingFrom\) return/)
  assert.match(main, /pendingFrom = record\.documentToken/)
  assert.doesNotMatch(recovery, /validatedURL === currentUrl\(\)/,
    'URL equality is not document identity and must not stand in for it')

  // the snapshot listener holds nothing and releases nothing, so it cannot wedge
  const snapshot = main.slice(main.indexOf("window.webContents.on('did-start-navigation'"), main.indexOf("window.webContents.on('did-navigate'"))
  assert.doesNotMatch(snapshot, /rearm|drain|outbox/, 'the snapshot touches no queue state')

  // and the classification is the one the retry already uses
  assert.match(recovery, /if \(isTerminalLoadFailure\(failure\)\) hooks\.documentLost\?\.\(\)/)
})
