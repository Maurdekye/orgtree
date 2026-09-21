/** THE HELD-EVENT COMPOSITION FIXTURE: production host, production preload,
 *  a real renderer consumer.
 *
 *  ⚠ WHAT IT ESTABLISHES THAT NOTHING ELSE DOES. Every earlier test of the
 *  held-event path exercised a COPY of the three channels, because until
 *  `main/held-events.ts` was extracted they were closures inside
 *  `app.whenReady()` and no test could reach them. This one imports and
 *  registers the SHIPPING `registerHeldEventChannels`, against the real
 *  `orgWindowRegistry` and the real `windowOutbox`, in a window running the
 *  UNMODIFIED production preload — including its private document token,
 *  which page script cannot see or forge. The renderer is the shipping
 *  `events/heldbus.ts` feeding the shipping `useNativeNotifications`.
 *
 *  The four things it is here to answer, all of which were open:
 *
 *    A  ACK-ONLY, NO TAKE. A renderer that never calls
 *       `takePendingWindowEvents` — the v2 one, and any renderer whose take
 *       loses the race — still RECEIVES a held event, and a real consumer
 *       really acts on it. Native's probe drained into a main-process array;
 *       nothing had ever been received by a renderer.
 *    B  THE TAKE PATH, end to end, through the same production guard.
 *    C  A STALE DOCUMENT'S ACK DOES NOT RELEASE, and the current document's
 *       then does — measured at the CONSUMER, not in a main-process array.
 *    D  THE HOMEPAGE BIND, as the product actually performs it. It does NOT
 *       replace the document: `adoptIdentity` does not navigate, and the
 *       renderer routes with `history.pushState`, which is same-document. So
 *       the outbox never re-arms, the token stays valid, and a reveal across
 *       a bind is received normally. An earlier version of this section bound
 *       with `loadURL` and concluded the opposite — see the note on D.
 *    F  A RELOAD RACING A REVEAL, which is where a document really IS
 *       replaced while listening. That one loses the reveal. It is real,
 *       rarer than a bind, and does NOT justify holding from
 *       `did-start-navigation` — a navigation that never commits would wedge
 *       the queue for the life of the window.
 *
 *  ⚠ NO ENGINE, NO LIVE DATA, NO INSTALLED APP. A throwaway HTTP server on
 *  127.0.0.1 serves the document and one canned notifications body; Electron's
 *  own state is redirected under the out directory. Nothing is installed,
 *  launched, deployed or restarted.
 *
 *  ⚠ WHAT IS THE FIXTURE'S OWN WIRING RATHER THAN PRODUCTION'S, stated so no
 *  one cites this for more than it shows: the window-creation glue — creating
 *  the BrowserWindow, registering it, and re-arming the outbox on
 *  `did-navigate` — lives in index.ts's window builder and is restated here.
 *  The REAL `did-navigate` timing (that commit is where the rearm lands, and
 *  that the provisional-load window is therefore unheld) is measured in
 *  tests/multi-window-native.probe.ts against real Electron. What is NOT
 *  restated, and is the whole point, is the three channels and their guard.
 *
 *  ⚠⚠ AND WHAT THE HOST IS HANDED, WHICH IS WHERE THIS FIXTURE COULD BE
 *  HOLLOW WITHOUT LOOKING IT (v3-native-opus, relaying their reviewer, before
 *  this was written). The seam makes the JUDGEMENT non-substitutable —
 *  `resolveNativeSender` is called inside held-events.ts and `currentDocument`
 *  is private to it — but the host interface necessarily hands over the STATE
 *  that judgement operates on. A registry whose `bySender` answered for
 *  anything would leave the real resolver refusing nothing while still being,
 *  genuinely, the real resolver; `OrgWindowRegistry` is structurally typed, so
 *  a hand-written literal of the right shape compiles. Their reviewer's
 *  sentence is the one to keep:
 *
 *    "This extraction makes the shipping path EXECUTABLE; it does not make
 *     every execution of it MEANINGFUL, and the whole difference is in what
 *     the caller passes."
 *
 *  So, precisely: `windows` is a real `orgWindowRegistry()`, every window is a
 *  real `BrowserWindow` registered in it by its real `webContents.id`, the
 *  outboxes are real `windowOutbox()`s, and `record`/`token`/`setToken` read
 *  and write one per-window field each — the same shapes index.ts passes.
 *
 *  And rather than leave that as a promise, CHECK E MEASURES IT: a document
 *  loaded at a path `isAppPath` does not admit must be REFUSED, so the
 *  resolver in play is demonstrably resolving rather than waved through. A
 *  hollow registry would pass every other check in this file and fail that
 *  one.
 *
 *  ⚠⚠ WHAT "THE CONSUMER RECEIVED IT" MEANS HERE, AND WHAT IT DOES NOT
 *  (multi-window-design, 2026-09-21). `useNativeNotifications` is the shipping
 *  hook and everything inside it is real — the paging read, the preference
 *  gate, the recheck on activation. But the CALLBACK it is given is this
 *  fixture's, not App's. So `PROBE.opened` proves HOOK RECEIPT: the event
 *  reached the real consumer and survived its whole validation path. It does
 *  NOT prove the reveal ACTION — that the real App then shows the targeted
 *  item in the right surface. That remains owed, and must be checked against
 *  what the real App displays rather than inferred from this.
 */
import { app, BrowserWindow, ipcMain } from 'electron'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { registerHeldEventChannels } from '../apps/desktop/main/held-events'
import { orgWindowRegistry } from '../apps/desktop/main/org-windows'
import { windowOutbox } from '../apps/desktop/main/window-outbox'

const OUT = process.env.PROBE_OUT!
const ROOT = process.env.PROBE_ROOT!
const log = (m: unknown) => {
  try { fs.appendFileSync(OUT + '.log', String(m) + '\n') } catch { /* best effort */ }
}

interface Check { id: string; ok: boolean; note: string; detail?: unknown }
const checks: Check[] = []
const check = (id: string, ok: boolean, note: string, detail?: unknown) => {
  checks.push({ id, ok, note, detail })
  log((ok ? 'ok   ' : 'FAIL ') + id + ' — ' + note + (detail === undefined ? '' : ' ' + JSON.stringify(detail)))
}
const write = () => {
  try { fs.writeFileSync(OUT, JSON.stringify({ checks }, null, 2)) } catch { /* best effort */ }
}

type Event = { type: string; data?: unknown }

/** One canned notification. The renderer's REAL `readNotices()` pages this
 *  endpoint, so the consumer's whole recheck-on-activation path runs — which
 *  is what makes "the consumer acted on it" mean something. */
const NOTICE = {
  id: 'ask:cold-start', org: 'studio', source_id: 'cold-start',
  title: 'A question is waiting', body: 'Choose the approach',
  kind: 'question', agent: 'writer',
}

app.disableHardwareAcceleration()
// ⚠ EACH SCENARIO DESTROYS ITS WINDOWS, AND ELECTRON QUITS WHEN THE LAST ONE
// CLOSES. The default `window-all-closed` handler fired between scenarios and
// tore the process down mid-run — every later `loadURL` then failed with a
// bare `ERR_FAILED (-2)`, which reads exactly like a transport problem and
// nothing like "the app you are running has already quit". Held open
// explicitly; the run ends at `app.exit` below and nowhere else.
app.on('window-all-closed', () => { /* the fixture decides when this ends */ })
for (const k of ['userData', 'sessionData', 'cache', 'temp', 'logs', 'crashDumps'] as const) {
  try { app.setPath(k, path.join(ROOT, 'electron-' + k)) } catch { /* fixture profile */ }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  // ------------------------------------------------------------ the server
  // ⚠ HOW THE PROVISIONAL WINDOW IS MADE OBSERVABLE. A same-origin reload of
  // a cached document commits in a few milliseconds, so a polling loop cannot
  // reliably land a send between START and COMMIT — the first attempt found
  // the commit had already happened and measured an ordinary held delivery
  // while reporting it as the gap. Stalling the document response widens the
  // window to something a test can aim at, and changes nothing about what is
  // under test: the outbox still re-arms at COMMIT and the old document is
  // still the one showing.
  let stallNextDocument = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/desktop/notifications') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        notices: [NOTICE], total: 1, truncated: false,
        active: [{ org: NOTICE.org, id: NOTICE.id }],
      }))
      return
    }
    if (url.pathname === '/probe.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(fs.readFileSync(path.join(ROOT, 'probe.js')))
      return
    }
    // ⚠ `/` and `/o/<slug>` are the app paths `isAppPath` admits, and the
    // production sender gate requires one of them. Both serve the same
    // document, so a navigation between them is a real document replacement
    // of the kind a Homepage bind performs.
    if (stallNextDocument) {
      const ms = stallNextDocument
      stallNextDocument = 0
      log('stalling the document response by ' + ms + 'ms')
      await new Promise((r) => setTimeout(r, ms))
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(fs.readFileSync(path.join(ROOT, 'probe.html')))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const origin = `http://127.0.0.1:${port}`
  log('origin ' + origin)

  // --------------------------------------------- the production host, wired
  const windows = orgWindowRegistry<BrowserWindow, Event>()
  interface Record {
    id: string; window: BrowserWindow; token: string
    outbox: ReturnType<typeof windowOutbox<Event>>
    navStarted: number; navCommitted: number
  }
  const records = new Map<string, Record>()
  const HELD = new Set(['open-org', 'notification-click', 'window-identity', 'restore-skipped'])

  // ⚠ `origin()` IS A GETTER because production reads it per call: the
  // engine's origin changes after a boot-engine recovery, and a captured
  // string would pass here and diverge from the product the moment recovery
  // is in play. It is a getter even though this fixture's origin never
  // changes, so the shape under test is the shape that ships.
  const liveOrigin = origin

  // ⚠ HOW THE ACK-ONLY CASE IS ARRANGED, and the first attempt is worth
  // recording because it failed in a way that looked like a result. The
  // renderer tried to `delete bridge.takePendingWindowEvents`; `contextBridge`
  // exposes a FROZEN object, so that threw — before `startHeldEvents()` ran,
  // killing the whole bundle. Nothing was received, every assertion about
  // receipt failed, and none of it had anything to do with the claim.
  //
  // So the take is suppressed HERE instead, by wrapping the ipc object the
  // production registration is given. The `events-listening` handler under
  // test is untouched and unwrapped; only the take's RESULT is withheld, which
  // is the same situation as a renderer that never calls it — the v2 shell,
  // and any renderer whose take loses the race. Wrapping the ipc layer is not
  // a way to influence the guard: `currentDocument` and `resolveNativeSender`
  // are private to held-events.ts and this fixture cannot reach either.
  //
  // ⚠ AND IT IS "ACK DELIVERY WITH THE TAKE UNABLE TO DRAIN", NOT "NO TAKE
  // CALL" (multi-window-design's wording, and the distinction is the whole
  // safeguard). The renderer STILL INVOKES the take — the shipping bus always
  // does — so the counts below are asserted explicitly: if the take were
  // quietly draining, a dead acknowledgement would be masked by it and this
  // case would report success for something that never happened.
  let suppressTake = false
  let takeCalls = 0
  let takeSuppressed = 0
  const ipc = {
    on: (channel: string, listener: (...args: unknown[]) => void) => ipcMain.on(channel, listener),
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      if (channel !== 'desktop:take-pending-events') { ipcMain.handle(channel, listener); return }
      ipcMain.handle(channel, (...args: unknown[]) => {
        takeCalls += 1
        if (suppressTake) { takeSuppressed += 1; log('take INVOKED and withheld by the fixture'); return [] }
        return listener(...args)
      })
    },
  }

  registerHeldEventChannels(ipc, {
    origin: () => liveOrigin,
    registry: windows,
    record: (id) => records.get(id),
    token: (r) => r.token,
    setToken: (r, t) => { r.token = t },
    drain: (r) => r.outbox.drain(),
    send: (r, e) => { if (!r.window.isDestroyed()) r.window.webContents.send('desktop:event', e) },
  })

  /** index.ts's `sendTo`, restated: offer to the outbox, send if it says so. */
  const sendTo = (r: Record, event: Event) => {
    if (r.outbox.offer(event)) r.window.webContents.send('desktop:event', event)
  }

  const makeWindow = (id: string, org?: string) => {
    const window = new BrowserWindow({
      show: false, width: 700, height: 500,
      webPreferences: {
        contextIsolation: true, sandbox: false, nodeIntegration: false,
        preload: path.join(ROOT, 'preload.cjs'),
        // the gate the production preload checks before exposing the bridge
        additionalArguments: ['--orgtree-ui-origin=' + origin],
      },
    })
    const record: Record = {
      id, window, token: '', navStarted: 0, navCommitted: 0,
      outbox: windowOutbox<Event>({ hold: (t) => HELD.has(t) }),
    }
    records.set(id, record)
    windows.register({ id, senderId: window.webContents.id, window, kind: org ? 'org' : 'homepage', org })
    // ⚠ THE DOCUMENT WENT AWAY, SO THE EVIDENCE WENT WITH IT. index.ts does
    // exactly this on commit; the real timing is measured in
    // multi-window-native.probe.ts.
    window.webContents.on('did-start-navigation', (_e, url, _inPage, isMainFrame) => {
      if (isMainFrame) { record.navStarted += 1; log('did-start-navigation ' + id + ' ' + url) }
    })
    window.webContents.on('did-navigate', () => {
      record.token = ''
      record.outbox.rearm()
      record.navCommitted += 1
      log('did-navigate: token cleared, outbox re-armed')
    })
    window.webContents.on('console-message', (_e, lvl, msg) => {
      if (lvl >= 2) log('CONSOLE' + lvl + ': ' + String(msg).slice(0, 400))
    })
    window.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      log(`did-fail-load ${id} code=${code} ${desc} url=${url} main=${isMainFrame}`)
    })
    return record
  }

  /** ⚠ LOAD WITH ONE RETRY, and say so rather than hiding it. The first run
   *  produced a bare `ERR_FAILED (-2)` on the SECOND window's load, which is
   *  a transport failure and not a statement about anything under test —
   *  treating it as a result would have been a false finding. Retried once,
   *  logged either way, and a second failure is fatal. */
  const load = async (r: Record, url: string) => {
    try { await r.window.loadURL(url) } catch (e) {
      log('load failed once, retrying: ' + String(e))
      await wait(300)
      await r.window.loadURL(url)
      log('retry succeeded for ' + url)
    }
  }

  /** Ask the renderer what its REAL consumer has seen. `docId`/`path` say
   *  WHICH document is answering — see the Homepage-bind case. */
  const seen = async (r: Record): Promise<{
    opened: unknown[]; waiting: number; delivered: number; mode: string
    hasTake?: boolean; docId: string; path: string; livePath: string
  } | null> =>
    // ⚠ `livePath` IS READ NOW, not taken from PROBE. `PROBE.path` is stamped
    // when the module evaluates, and `pushState` does not re-run the module —
    // so the stamped value says where the document STARTED, which made the
    // bind check fail while the bind had in fact worked.
    r.window.webContents.executeJavaScript(
      'window.PROBE && JSON.parse(JSON.stringify({ ...window.PROBE, livePath: location.pathname }))')
      .catch((e) => { log('eval failed ' + e); return null })

  /** Poll until the consumer reports it opened something, or we give up. */
  const awaitOpened = async (r: Record, n = 1, ms = 8000) => {
    const until = Date.now() + ms
    let last: Awaited<ReturnType<typeof seen>> = null
    while (Date.now() < until) {
      last = await seen(r)
      if (last && (last.opened?.length ?? 0) >= n) return last
      await wait(100)
    }
    return last
  }

  try {
    // =========================== E  THE RESOLVER IS REALLY RESOLVING
    //
    // ⚠ RUN FIRST, DELIBERATELY. Everything below is worth nothing if the
    // registry this fixture handed the production module answers for
    // anything: the real resolver would then refuse nothing while still being
    // the real resolver. A document at a path `isAppPath` does not admit must
    // be REFUSED, and a hollow registry passes every other check here and
    // fails this one.
    {
      // (i) a document at a path isAppPath does not admit gets no bridge at
      //     all, so it cannot even speak on these channels
      const outsider = makeWindow('outsider')
      await load(outsider, origin + '/not-an-app-path?mode=idle')
      await wait(400)
      const hasBridge = await outsider.window.webContents
        .executeJavaScript('!!window.orgtreeDesktop').catch(() => null)
      check('E0', hasBridge === false,
        'the production preload exposes no bridge on a non-app path',
        { hasBridge })

      // (ii) ⚠ THE SHARPER ONE, and the one a permissive registry fails. Two
      //      REGISTERED windows, each a real BrowserWindow with its own real
      //      webContents id. One is holding an event; the OTHER loads, mints
      //      its own token and acknowledges. A registry whose `bySender`
      //      answered for anything would resolve that acknowledgement to the
      //      holder and release it.
      const holder = makeWindow('holder')
      await load(holder, origin + '/?mode=idle')
      await wait(400)
      holder.outbox.rearm()
      sendTo(holder, { type: 'notification-click', data: NOTICE })
      const other = makeWindow('other')
      await load(other, origin + '/?mode=idle')
      await wait(700)
      check('E1', !!holder.token && !!other.token && holder.token !== other.token,
        'each document minted its OWN token through the production channel',
        { holder: !!holder.token, other: !!other.token, distinct: holder.token !== other.token })
      check('E2', holder.outbox.holding() === true && holder.outbox.pending() === 1,
        "another window's acknowledgement released nothing here — sender resolution "
        + 'really maps a message to the window that sent it',
        { holding: holder.outbox.holding(), pending: holder.outbox.pending() })
      // and the holder's own document then does release it, so E2 is not
      // passing because nothing can ever release
      await holder.window.webContents.executeJavaScript(
        'window.orgtreeDesktop.onEvent(() => {}); true').catch(() => null)
      await wait(500)
      check('E3', holder.outbox.holding() === false,
        'while the holder\'s OWN acknowledgement does — so E2 is a refusal, not a dead channel',
        { holding: holder.outbox.holding() })
      for (const r of [outsider, holder, other]) { r.window.destroy(); records.delete(r.id) }
    }

    // ========== A  ACK DELIVERY, WITH THE TAKE UNABLE TO DRAIN
    //
    // The event is queued BEFORE the window has a document at all. The
    // renderer runs the shipping bus, which ALWAYS invokes the take — so this
    // is not "no take call", and calling it that would be the overstatement
    // multi-window-design warned about. The fixture withholds the take's
    // RESULT instead, which is the situation of any renderer whose take is
    // unavailable or loses the race, the shipped v2 shell included. The counts
    // are asserted so a quietly-draining take cannot mask a dead ack.
    {
      suppressTake = true
      const before = { calls: takeCalls, suppressed: takeSuppressed }
      const r = makeWindow('ack-only')
      sendTo(r, { type: 'notification-click', data: NOTICE })
      check('A0', r.outbox.pending() === 1 && r.outbox.holding(),
        'the click is HELD: no document exists yet, so nothing could have received it',
        { pending: r.outbox.pending() })
      await load(r, origin + '/?mode=ack-only')
      const got = await awaitOpened(r)
      check('A1', got?.hasTake === true,
        'the renderer had takePendingWindowEvents and the shipping bus invoked it — '
        + 'this is the take being unable to DRAIN, not a renderer that never called',
        { hasTake: got?.hasTake })
      check('A2', takeCalls === before.calls + 1 && takeSuppressed === before.suppressed + 1,
        'exactly one take, and it was withheld — so nothing but the acknowledgement '
        + 'could have released the hold',
        { calls: takeCalls - before.calls, suppressed: takeSuppressed - before.suppressed })
      check('A3', (got?.opened?.length ?? 0) === 1,
        'the REAL useNativeNotifications consumer opened the held click',
        { opened: got?.opened })
      check('A4', (got?.opened?.[0] as { source_id?: string } | undefined)?.source_id === 'cold-start',
        'and it is the right one, recovered through the real readNotices path')
      check('A5', r.outbox.holding() === false && r.outbox.pending() === 0,
        'the outbox stopped holding for this document',
        { holding: r.outbox.holding(), pending: r.outbox.pending() })
      r.window.destroy()
      records.delete('ack-only')
      suppressTake = false
    }

    // ============================================================ B  TAKE
    {
      const before = { calls: takeCalls, suppressed: takeSuppressed }
      const r = makeWindow('take')
      sendTo(r, { type: 'notification-click', data: NOTICE })
      await load(r, origin + '/?mode=take')
      const got = await awaitOpened(r)
      check('B1', takeCalls > before.calls && takeSuppressed === before.suppressed,
        'the take really ran this time, through the production handler and NOT withheld',
        { calls: takeCalls - before.calls, suppressed: takeSuppressed - before.suppressed })
      check('B2', (got?.opened?.length ?? 0) === 1,
        'the consumer received it exactly once — both routes drained the same '
        + 'outbox and the drain is idempotent per document',
        { opened: got?.opened })
      r.window.destroy()
      records.delete('take')
    }

    // ============================================== C  A STALE DOCUMENT'S ACK
    //
    // ⚠ THE TOKEN IS THE PRODUCTION PRELOAD'S OWN, and page script cannot see
    // or forge it. So staleness is produced the way production produces it —
    // the record's token is replaced, exactly as a commit does — and then the
    // SAME document acknowledges again by attaching a second `onEvent`. Its
    // preload quotes the token it minted at load, which is now stale. Nothing
    // here supplies the comparison: `currentDocument` is private to
    // held-events.ts and this fixture could not override it if it wanted to.
    {
      const r = makeWindow('stale')
      await load(r, origin + '/?mode=idle')
      await wait(400)
      const mintedFirst = r.token
      // a fresh event, and the document's token replaced under it
      r.outbox.rearm()
      sendTo(r, { type: 'notification-click', data: NOTICE })
      r.token = 'a-token-from-a-later-document'
      check('C0', !!mintedFirst && mintedFirst !== r.token && r.outbox.pending() === 1,
        'the document holds a token that is no longer current, and an event is held',
        { pending: r.outbox.pending() })

      // the stale acknowledgement: a second onEvent from the SAME document
      await r.window.webContents.executeJavaScript(
        'window.__staleAck = !!window.orgtreeDesktop.onEvent(() => {}); true')
      await wait(500)
      check('C1', r.outbox.holding() === true && r.outbox.pending() === 1,
        "the departing document's acknowledgement released NOTHING — the event is still held",
        { holding: r.outbox.holding(), pending: r.outbox.pending() })

      // now make that document current again and acknowledge once more
      r.token = mintedFirst
      await r.window.webContents.executeJavaScript(
        'window.__validAck = !!window.orgtreeDesktop.onEvent((e) => { (window.PROBE.late ||= []).push(e.type) }); true')
      await wait(600)
      const after = await r.window.webContents
        .executeJavaScript('JSON.parse(JSON.stringify(window.PROBE.late || []))').catch(() => [])
      check('C2', r.outbox.holding() === false && r.outbox.pending() === 0,
        'the CURRENT document\'s acknowledgement then released it',
        { holding: r.outbox.holding(), pending: r.outbox.pending() })
      check('C3', Array.isArray(after) && after.includes('notification-click'),
        'and the renderer actually received it — measured at the consumer, not in a main-process array',
        { received: after })
      r.window.destroy()
      records.delete('stale')
    }

    // ============================ D  THE PRODUCT'S BIND IS SAME-DOCUMENT
    //
    // ⚠ AN EARLIER VERSION OF THIS SECTION WAS MEASURING THE WRONG THING,
    // and it is recorded here rather than quietly replaced. It bound by
    // `loadURL('/o/studio')`, found that the new document received nothing,
    // and concluded that the provisional-load gap bites on a Homepage bind.
    // v3-native-opus checked the premise instead of the result: the product
    // does not navigate on a bind at all. `adoptIdentity` in main/index.ts
    // updates placement, sends `window-identity` and publishes open-orgs —
    // it does not touch the document. The routing is the RENDERER's, and it is
    // exactly one line (App.tsx):
    //
    //     if (location.pathname !== want) history.pushState(null, '', want)
    //
    // `pushState` is SAME-DOCUMENT. So this section now performs the call the
    // product performs, and measures what that does.
    {
      const r = makeWindow('bind')
      await load(r, origin + '/?mode=take')
      await wait(600)
      const homepage = await seen(r)
      const commitsBefore = r.navCommitted
      check('D0', r.outbox.holding() === false && !!homepage?.docId,
        'the Homepage document drained, so the window is live-delivering',
        { holding: r.outbox.holding(), docId: homepage?.docId, path: homepage?.path })

      // the identical call App.tsx makes when a bound identity arrives
      await r.window.webContents.executeJavaScript(
        "history.pushState(null, '', '/o/studio'); true")
      await wait(50)
      sendTo(r, { type: 'notification-click', data: NOTICE })
      await wait(2000)
      const bound = await seen(r)

      check('D1', bound?.livePath === '/o/studio',
        'the window is at the organization route',
        { livePath: bound?.livePath, stampedAtLoad: bound?.path })
      check('D2', r.navCommitted === commitsBefore,
        'and NO did-navigate fired — pushState is same-document, so the outbox '
        + 'never re-armed and the document token stayed valid',
        { commits: r.navCommitted - commitsBefore })
      check('D3', !!bound?.docId && bound.docId === homepage?.docId,
        'the SAME document is still showing — nothing was replaced, so there is '
        + 'no provisional window and nothing to hold',
        { before: homepage?.docId, after: bound?.docId })
      check('D4', (bound?.opened?.length ?? 0) === 1,
        'and a reveal sent across the bind is received normally by the consumer '
        + 'that was already listening',
        { opened: bound?.opened })
      r.window.destroy()
      records.delete('bind')
    }

    // ================== F  A RELOAD RACING A REVEAL — WHERE THE GAP IS REAL
    //
    // The bind does not replace the document, but some things do: a user
    // pressing refresh, and the load-recovery path. There the old document
    // genuinely IS still showing and listening during the provisional window,
    // genuinely IS about to be replaced, and the outbox does not re-arm until
    // COMMIT. This measures that case honestly and claims nothing beyond it.
    //
    // ⚠ AND IT IS NOT AN ARGUMENT FOR HOLDING FROM `did-start-navigation`.
    // v3-native-opus's objection stands and is recorded with the finding: a
    // navigation that never COMMITS would leave the queue held for the life of
    // the window, because the old document is still showing, its listener
    // already ran, and `onEvent` does not fire again. That is the f5 wedge in
    // a new place. What this establishes is that the case EXISTS, not what the
    // answer to it should be.
    {
      const r = makeWindow('reload')
      await load(r, origin + '/?mode=take')
      await wait(600)
      const first = await seen(r)
      const startsBefore = r.navStarted
      const commitsBefore = r.navCommitted
      check('F0', r.outbox.holding() === false && !!first?.docId,
        'the document drained and is live-delivering', { docId: first?.docId })

      stallNextDocument = 2000
      r.window.webContents.reload()
      for (let i = 0; i < 400 && r.navStarted === startsBefore; i++) await wait(5)
      const startedBeforeSend = r.navStarted > startsBefore
      const committedBeforeSend = r.navCommitted > commitsBefore
      sendTo(r, { type: 'notification-click', data: NOTICE })
      const heldDuringNav = r.outbox.pending()
      await wait(4000)
      const second = await seen(r)

      check('F1', startedBeforeSend && !committedBeforeSend,
        'the reveal was sent inside the provisional window: after '
        + 'did-start-navigation and before did-navigate',
        { startedBeforeSend, committedBeforeSend })
      check('F2', heldDuringNav === 0,
        'and it was NOT held — the outbox re-arms at COMMIT',
        { heldDuringNav })
      check('F3', !!second?.docId && second.docId !== first?.docId,
        'the document really was replaced, so what follows is about the NEW one',
        { before: first?.docId, after: second?.docId })
      const exercised = startedBeforeSend && !committedBeforeSend
        && !!second?.docId && second.docId !== first?.docId
      const lost = (second?.opened?.length ?? 0) === 0
      check('F4', true,
        !exercised
          ? 'NOT EXERCISED — the send did not land between START and COMMIT, or the '
            + 'document was not replaced, so nothing here is claimed. (The first run '
            + 'of this case DID conclude from exactly that state: the reload had '
            + 'already committed, the event was held normally, and it read as a pass.)'
          : lost
          ? 'MEASURED: the reloaded document received NOTHING. A reveal delivered '
            + 'into a reload is lost, and renderer-side buffering cannot help — the '
            + 'buffer dies with the document that held it. Real, rarer than a bind, '
            + 'and needing a design rather than a one-line hold.'
          : 'MEASURED: the reloaded document DID receive it, so even a reload does '
            + 'not lose a reveal on this path.',
        { reloadedDocumentOpened: second?.opened, lost, exercised })
      r.window.destroy()
      records.delete('reload')
    }

  } catch (e) {
    check('fatal', false, 'the fixture threw', String((e as Error)?.stack ?? e))
  }

  write()
  server.close()
  app.exit(checks.every((c) => c.ok) ? 0 : 1)
})
