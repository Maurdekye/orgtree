import { beginWindowExit, endWindowExit } from './windowlayout'
import type { WindowRestore } from './windowlayout'
// One opener owns all movable surfaces and the restart decision. No React/API
// imports: api.ts can consult this without creating an application cycle.
export interface WindowSurface {
  id: string
  kind: string
  org: string | null
  editable: boolean
  window: Window
  redock: () => void
  /** Take this surface out of its native window WITHOUT recording it as
   *  closed, and return the function that puts it back exactly where it was.
   *
   *  For TEMPORARY BORROWING — a detached desk pulled into a modal for that
   *  modal's life and then given back. `redock` is the wrong call for it: it
   *  clears the saved row, which both loses the arrangement on reopen and
   *  makes the return land at a freshly computed position instead of the one
   *  it left. See `borrow` in popout.tsx.
   *
   *  Optional because only a surface that owns a native window has one; the
   *  caller must hold the returned function and call it when it releases the
   *  surface. */
  borrow?: () => () => void
  flush?: () => void
  /** WHAT THIS SURFACE IS SHOWING, READ LIVE.
   *
   *  ⚠ A GETTER, NOT A VALUE. A surface registers ONCE, when it pops out, and
   *  a popped-out reader is then re-pointed at other content without ever
   *  re-registering — the canvas has exactly ONE document reader, so opening a
   *  second presentation swaps the document inside the window it is already
   *  in. A snapshot taken at open time would keep naming the first document
   *  for the rest of the window's life, which is worse than no answer: the
   *  lookup below would surface the wrong window and refuse to open the right
   *  one. */
  identity?: () => WindowRestore | undefined
  /** Restore this surface's own native window if minimized, raise it and focus
   *  it. Present only on the surface that OWNS a window; a surface merely
   *  hosted inside someone else's window resolves through `revealSurface`. */
  reveal?: () => void
}
const surfaces = new Map<string, WindowSurface>()
const listeners = new Set<() => void>()
let revision = 0
const changed = () => { revision++; for (const fn of [...listeners]) fn() }
export const subscribeWindows = (fn: () => void) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export const windowRevision = () => revision
export const openSurfaces = () => [...surfaces.values()]
export function registerWindow(surface: WindowSurface) {
  surfaces.set(surface.id, surface); changed()
  return () => { if (surfaces.get(surface.id) === surface) { surfaces.delete(surface.id); changed() } }
}
export const detachedKind = (kind: string) => openSurfaces().some((s) => s.kind === kind)

/** Bring the window this surface lives in to the front, restoring it first if
 *  it is minimized.
 *
 *  TWO KINDS OF SURFACE LIVE IN A POPPED-OUT WINDOW and only one of them owns
 *  it. The surface that called `window.open` carries `reveal` and knows the
 *  frame name the native side addresses windows by. A surface merely HOSTED in
 *  that window — a reader opened by a click inside a popped-out docket, which
 *  is placed in the initiating document without detaching — has no name of its
 *  own, so it is resolved to whichever registered surface owns the same
 *  `Window`. Failing both, the browser's own focus is still better than
 *  nothing (and is all a plain browser ever had). */
export function revealSurface(surface: WindowSurface): boolean {
  const owner = surface.reveal ? surface : openSurfaces().find((s) => s.reveal && s.window === surface.window)
  if (owner?.reveal) { owner.reveal(); return true }
  try { surface.window.focus(); return true } catch { return false }
}

/** Is this surface's window still there?
 *
 *  A surface unregisters on redock and on unmount, and Electron does fire
 *  `pagehide`, so a registration outliving its window is not a case anyone has
 *  reproduced. It is guarded anyway because of HOW it would fail: the lookup
 *  would match, the click would be treated as handled, and the reader would
 *  never open — a document silently unopenable, with nothing on screen to say
 *  why. A plain object window (a test's, or a surface hosted somewhere with no
 *  `closed` property) reads as live, which is the same answer as before. */
const windowLives = (surface: WindowSurface): boolean => {
  try { return !surface.window.closed } catch { return false }
}

/** The popped-out window already showing this exact presentation, if there is
 *  one. Identity is the document's own id WITHIN its organization: two orgs
 *  are separate namespaces, so a window belonging to another org is never an
 *  answer here even if the ids happened to collide. */
export const detachedDocument = (org: string | null, document: string): WindowSurface | undefined =>
  document ? openSurfaces().find((s) => s.org === org && s.identity?.()?.document === document && windowLives(s)) : undefined

/** Surface the existing window for this presentation. `true` means the click
 *  was fully handled — the caller must NOT then open a reader of its own,
 *  which is what would put a second window on screen for one document.
 *
 *  ⚠ IT REPORTS WHAT ACTUALLY HAPPENED, not merely that a match was found. A
 *  match we could not raise is not a handled click: answering `true` there
 *  would swallow the press and leave the user with nothing at all, which is
 *  the same dead click this whole change exists to remove. Falling through to
 *  opening a reader is the right failure. */
export function revealDetachedDocument(org: string | null, document: string): boolean {
  const surface = detachedDocument(org, document)
  return surface ? revealSurface(surface) : false
}
export const flushWindowDrafts = () => { for (const s of openSurfaces()) s.flush?.() }
export const returnWindows = (org?: string) => {
  for (const s of openSurfaces()) if (org === undefined || s.org === org) s.redock()
}

let restart: { instance: string; deferred: boolean } | null = null
let reloadStarted = false
export const pendingRestart = () => restart
export function keepWorking() {
  if (restart) { restart = { ...restart, deferred: true }; changed() }
}
export function reloadWindows() {
  if (reloadStarted) return
  beginWindowExit()
  flushWindowDrafts()
  reloadStarted = true
  window.location.reload()
}
export function backendRestart(instance: string) {
  if (reloadStarted) return
  // Once offered, this is a USER decision even after the last child returns.
  if (restart || openSurfaces().some((s) => s.editable)) {
    if (!restart || restart.instance !== instance) {
      restart = { instance, deferred: restart?.deferred ?? false }; changed()
    }
    return
  }
  reloadWindows()
}

let actionDocument: Document | null = null
export function noteActionDocument(doc: Document) { actionDocument = doc }
export function initiatingDocument(): Document {
  try { if (actionDocument?.defaultView && !actionDocument.defaultView.closed) return actionDocument }
  catch { /* navigated away */ }
  return document
}
export function resetActionDocument() { actionDocument = document }

if (typeof window !== 'undefined') {
  window.addEventListener('orgtree:before-exit', () => {
    beginWindowExit(); flushWindowDrafts(); reloadStarted = true
  })
  // The native side abandons a shutdown it cannot complete safely. Without
  // this the exit latch stayed set and this window stopped saving its layout
  // for the rest of the session.
  window.addEventListener('orgtree:exit-cancelled', () => {
    endWindowExit(); reloadStarted = false
  })
  window.addEventListener('beforeunload', (e) => {
    if (reloadStarted || !openSurfaces().some((s) => s.editable)) return
    flushWindowDrafts()
    e.preventDefault(); e.returnValue = ''
  })
  window.addEventListener('pagehide', () => {
    beginWindowExit()
    flushWindowDrafts()
    for (const s of openSurfaces()) { try { s.window.close() } catch { /* already gone */ } }
  })
  document.addEventListener('pointerdown', () => noteActionDocument(document), true)
  document.addEventListener('keydown', () => noteActionDocument(document), true)
}
