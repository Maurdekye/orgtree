// One opener owns all movable surfaces and the restart decision. No React/API
// imports: api.ts can consult this without creating an application cycle.
export interface WindowSurface {
  id: string
  kind: string
  org: string | null
  editable: boolean
  window: Window
  redock: () => void
  flush?: () => void
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
  window.addEventListener('beforeunload', (e) => {
    if (reloadStarted || !openSurfaces().some((s) => s.editable)) return
    flushWindowDrafts()
    e.preventDefault(); e.returnValue = ''
  })
  window.addEventListener('pagehide', () => {
    flushWindowDrafts()
    for (const s of openSurfaces()) { try { s.window.close() } catch { /* already gone */ } }
  })
  document.addEventListener('pointerdown', () => noteActionDocument(document), true)
  document.addEventListener('keydown', () => noteActionDocument(document), true)
}
