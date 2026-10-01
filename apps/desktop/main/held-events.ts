/** THE THREE CHANNELS THAT DECIDE WHETHER A HELD EVENT IS EVER RECEIVED.
 *
 *  Held events — `open-org`, `notification-click`, `window-identity`,
 *  `restore-skipped` — are the ones a renderer cannot rediscover, so native
 *  keeps them until the document currently showing says it is listening.
 *  Three channels carry that conversation, and they are registered together
 *  here rather than inline in index.ts for ONE reason:
 *
 *  ⚠ THEY WERE REACHABLE BY NO TEST. Registered as closures inside
 *  `app.whenReady()`, the only way in was to boot the whole main process,
 *  which needs the engine. So the acknowledgement handler read the document
 *  token off `event.args[0]` — a property an `IpcMainEvent` does not have —
 *  and stayed dead through a full review, because every test that claimed to
 *  cover it was exercising a COPY of its shape. A copy cannot catch a mistake
 *  that lives in the original.
 *
 *  Extracting them does not make anything look better tested; it makes the
 *  shipping code callable, so the composition fixture registers THESE
 *  handlers against a real window, the real preload and a real renderer
 *  instead of writing a fourth imitation of them.
 *
 *  ⚠ THE HOST SUPPLIES PLUMBING, NEVER JUDGEMENT. `resolveNativeSender` is
 *  imported and called HERE, not handed in, so no caller — fixture included —
 *  can substitute a resolver that always accepts and still claim to have
 *  exercised this path. The origin, registry and records come in as LIVE
 *  accessors for the same reason: what is under test is this file's decisions,
 *  and a host that could make them would be testing itself.
 */
import { randomUUID } from 'node:crypto'
import { resolveNativeSender } from './org-windows'
import type { MainWindowLike, NativeSenderWindow, OrgWindowRegistry } from './org-windows'

/** The minimum an IPC layer must offer. `ipcMain` satisfies it; so does a
 *  fixture's real `ipcMain`, which is the point — this is not an abstraction
 *  over Electron, it is the two registration verbs actually used. */
export interface HeldEventIpc {
  on(channel: string, listener: (...args: any[]) => void): unknown
  handle(channel: string, listener: (...args: any[]) => unknown): void
}

/** What this module needs from the process around it — and nothing that
 *  decides whether a caller is trusted. */
export interface HeldEventHost<W extends MainWindowLike & NativeSenderWindow, R, E> {
  /** ⚠ READ PER CALL, NEVER CAPTURED. The engine's origin CHANGES after a
   *  boot-engine recovery, and a frozen string would keep validating against
   *  the dead one — silently refusing every real document, or worse, still
   *  accepting a stale one. It is a getter for that reason alone. */
  origin(): string
  /** The live registry. Sender resolution and identity both come from it. */
  registry: OrgWindowRegistry<W, E>
  /** The per-window record, or undefined if this window has none. */
  record(id: string): R | undefined
  /** The document token currently minted for that record. */
  token(record: R): string
  /** Replace it. Called only where a document announces itself. */
  setToken(record: R, token: string): void
  /** Everything held for that window, taken and cleared. */
  drain(record: R): E[]
  /** Deliver one event to that window's renderer. Must no-op on a destroyed
   *  window, exactly as `sendTo` does. */
  send(record: R, event: E): void
}

/** ⚠ IS THE DOCUMENT THAT SENT THIS THE ONE CURRENTLY SHOWING?
 *
 *  ONE RULE, AND BOTH WAYS OF ENDING THE HOLDING CALL IT. That property is
 *  the fix for a real defect: the acknowledgement was guarded and the take was
 *  not, so a document on its way out could carry the queue away. Deliberately
 *  NOT on the host interface — a host that supplied this comparison would hand
 *  back the very thing that stopped the defect recurring, and the fixture
 *  would be testing its own idea of currency rather than this one.
 *
 *  A token is minted per document and quoted back by it; an empty current
 *  token means no document has announced itself since the last commit, so
 *  nothing can speak for this window yet. Fails closed. */
const currentDocument = <W extends MainWindowLike & NativeSenderWindow, R, E>(
  host: HeldEventHost<W, R, E>, record: R, token: unknown,
): boolean => typeof token === 'string' && !!token && token === host.token(record)

/** Sender resolution, once, for all three channels - and NOTHING MORE.
 *
 *  ⚠ IT RETURNS A POSSIBLY-MISSING RECORD RATHER THAN THROWING ON ONE, because
 *  the three channels did three different things about that and all three are
 *  preserved:
 *
 *    · `events-listening` did nothing at all;
 *    · `window-identity-sync` STILL ANSWERED, with a real identity and a
 *      freshly minted token it simply did not store;
 *    · `take-pending-events` went through index.ts's `handle`, which threw
 *      and rejected the invoke.
 *
 *  A shared helper that threw would have collapsed the second into the third -
 *  a window that resolves but has no record would have started receiving
 *  `{ identity: null, token: '' }` instead of its identity. That is a
 *  behaviour change, and a move is not where behaviour changes belong.
 *
 *  Resolution itself still throws for an UNTRUSTED sender, which is the check
 *  that matters and is identical in all three. */
const resolveRecord = <W extends MainWindowLike & NativeSenderWindow, R, E>(
  host: HeldEventHost<W, R, E>, event: unknown,
): { id: string; record: R | undefined } => {
  const entry = resolveNativeSender(
    event as Parameters<typeof resolveNativeSender>[0], host.registry, host.origin())
  return { id: entry.id, record: host.record(entry.id) }
}

/** Register all three. Called once by index.ts, and by the composition
 *  fixture against a real window — the same function, which is the whole
 *  reason it exists. */
export function registerHeldEventChannels<W extends MainWindowLike & NativeSenderWindow, R, E>(
  ipc: HeldEventIpc, host: HeldEventHost<W, R, E>,
): void {
  /** A listener exists: stop holding and SEND what was waiting. */
  const deliverHeld = (record: R) => {
    for (const event of host.drain(record)) host.send(record, event)
  }

  /** ⚠ THE RENDERER HAS A LISTENER NOW. This is the signal the outbox was
   *  missing: native cannot see an `ipcRenderer.on` registration, so without
   *  it the only options were to guess how long mounting takes or to hold
   *  events for ever. Sent by the preload's `onEvent`, so EVERY renderer that
   *  uses the bridge reports it — including the v2 one, which never calls
   *  `takePendingWindowEvents`.
   *
   *  ⚠ THE TOKEN IS THE SECOND CALLBACK ARGUMENT, and that is not a style
   *  choice. `ipcMain.on` delivers what the renderer sent as the listener's
   *  trailing arguments — `(event, ...args)` — and an `IpcMainEvent` has NO
   *  `args` property at all, neither in the typings nor at runtime. Reading
   *  one off the event yields `undefined`, which this handler's own guard then
   *  correctly rejects, so the acknowledgement silently stops acknowledging
   *  and every held event waits for a take that a renderer using only
   *  `onEvent` never makes. Measured against real Electron 44 in
   *  tests/multi-window-native.probe.ts. */
  ipc.on('desktop:events-listening', (event: unknown, token: unknown) => {
    try {
      const { record } = resolveRecord(host, event)
      // ⚠ ONLY THE DOCUMENT CURRENTLY SHOWING MAY END THE HOLDING. A message
      // from one on its way out would unhold the queue on the strength of a
      // listener that no longer exists.
      if (record && currentDocument(host, record, token)) deliverHeld(record)
    } catch { /* an untrusted sender is refused exactly as everywhere else */ }
  })

  /** This window's own identity, resolved SYNCHRONOUSLY because the shell
   *  derives its whole view from it and a promise makes the window paint the
   *  wrong one for a frame; the preload asks before it exposes the bridge. */
  ipc.on('desktop:window-identity-sync', (event: { returnValue?: unknown }) => {
    try {
      const { id, record } = resolveRecord(host, event)
      // ⚠ THE DOCUMENT ANNOUNCES ITSELF HERE, once, and this is where its
      // token is minted. Every later message it sends quotes it back, which is
      // what lets a message from a document that has since been replaced be
      // recognised for what it is rather than guessed at from timing.
      const token = randomUUID()
      // A resolved window with no record still gets its identity and a token,
      // exactly as before; there is simply nowhere to store the token.
      if (record) host.setToken(record, token)
      event.returnValue = { identity: host.registry.identity(id) ?? null, token }
    } catch { event.returnValue = { identity: null, token: '' } }
  })

  /** ⚠ WHAT ARRIVED BEFORE THE RENDERER COULD LISTEN. A notification click or
   *  an organization to open can reach a window while its React tree is still
   *  mounting, and `onEvent` only starts listening when the renderer calls it
   *  - so those events used to fall into the gap. They are held instead, and
   *  this is how the renderer collects them. Calling it also stops the
   *  holding: from here on the window gets its events live.
   *
   *  ⚠ THE SAME QUESTION AS THE ACKNOWLEDGEMENT ABOVE, ASKED IN THE SAME
   *  PLACE. Both entry points end the holding, so both must establish that the
   *  document asking is the one currently showing - and this one does more
   *  damage when it is wrong, because it carries the queue away as well as
   *  unholding it. Refused for a departing document: the events stay held and
   *  its successor's acknowledgement becomes the delivery. */
  ipc.handle('desktop:take-pending-events', (event: unknown, token: unknown) => {
    const { record } = resolveRecord(host, event)
    // The same refusal index.ts's `handle` raised for a missing record: this
    // channel REJECTS the invoke where the two above stay silent.
    if (!record) throw new Error('Native operation refused for this document')
    return currentDocument(host, record, token) ? host.drain(record) : []
  })
}
