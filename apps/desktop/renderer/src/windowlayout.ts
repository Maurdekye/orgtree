import { desktop } from './desktop'
import { useEffect, useState } from 'react'
import { baseKind, instanceKind, instanceTarget, isInstanceKind, migratedKind } from './modalkinds'

export const WINDOW_LAYOUT_KEY = 'orgtree-desktop-windows-v1'
export interface WindowRect { x: number; y: number; width: number; height: number }
export interface WindowRestore { agent?: string; generation?: number; document?: string; selection?: string; watchdog?: string; team?: boolean }
/** `exact`: `rect` is the native window's own content box (main's popout-state
 *  bounds), which a restore places exactly; without it, `rect` is the
 *  renderer's screenX/outerWidth view, which includes Windows' invisible frame. */
export interface SavedWindow { restore?: WindowRestore; key: string; kind: string; org: string | null; open: boolean; rect: WindowRect; exact?: boolean }
let exiting = false
export const windowExitStarted = () => exiting
export const beginWindowExit = () => { exiting = true }
/** An exit can be ABANDONED - an update that refuses to replace files over an
 *  engine it cannot confirm has stopped puts the app back. Without this the
 *  flag stayed latched and the window silently stopped saving its layout. */
export const endWindowExit = () => { exiting = false }
/** Bridges that have said restoring is on. The main process only ever turns it
 *  on (main/index.ts: off for a --background start until the main window is
 *  first shown), so a surface mounted after one heard it starts with it instead
 *  of waiting for its own answer: a panel going back to its own window
 *  (MovableSurface `windowed`) opens before its first paint, not after it has
 *  shown docked for an IPC round trip. */
const restoreHeard = new WeakSet<object>()
export function useRestoreWindows() {
  const bridge = desktop()
  const [allowed, setAllowed] = useState<boolean>(() => !!bridge && (!bridge.getWindowState || restoreHeard.has(bridge)))
  useEffect(() => {
    if (!bridge?.getWindowState) return
    let alive = true
    const heard = (on: boolean) => { if (on) restoreHeard.add(bridge); if (alive) setAllowed(on) }
    void bridge.getWindowState().then(state => heard(state.restoreWindows)).catch(() => {})
    const unsubscribe = bridge.onEvent(event => {
      if ((event.type as string) === 'main-window-shown') heard((event.data as { restoreWindows?: boolean })?.restoreWindows === true)
    })
    return () => { alive = false; unsubscribe() }
  }, [bridge])
  return allowed
}
export const windowLayoutKey = (kind: string, org: string | null) => JSON.stringify([org, kind])
const validRestore = (v: unknown): v is WindowRestore => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.entries(v).every(([key, value]) => key === 'generation'
    ? Number.isSafeInteger(value) && Number(value) >= 0
    // a gallery's TEAM scope (point 25): only ever `true`, absent otherwise
    : key === 'selection' ? typeof value === 'string' && value.length <= 512
    : key === 'team' ? value === true
    : ['agent', 'document', 'watchdog'].includes(key) && typeof value === 'string' && value.length > 0 && value.length <= 512)
}
export function restoredAgent(row: SavedWindow | undefined,
  nodes: Map<string, { generation?: number; kind?: string; state?: string }>): string | null {
  const target = row?.restore
  if (!target?.agent) return null
  const node = nodes.get(target.agent)
  // Early 4.4 alphas saved project desks without a generation. Recover only
  // those records against a live project; never relax agent identity checks
  // or an explicit generation mismatch. The next capture writes its identity.
  if (target.generation === undefined && row && baseKind(row.kind) === 'project-desk')
    return node?.kind === 'project' && node.state === 'live' ? target.agent : null
  if (!Number.isSafeInteger(target.generation)) return null
  return node?.generation === target.generation ? target.agent : null
}
/** An agent gallery window back from storage: its agent, while that agent is
 *  still the same generation, and its scope, team or ordinary (review of
 *  a590555: a restored Team presentations window had become own-only). A
 *  pinned window's record wins over the saved layout's. */
export function restoredAgentGallery(pinned: WindowRestore | undefined, row: SavedWindow | undefined,
  nodes: Map<string, { generation?: number }>): { id: string; team: boolean } | null {
  for (const r of [pinned, row?.restore]) {
    if (!r?.agent || !Number.isSafeInteger(r.generation)) continue
    if (nodes.get(r.agent)?.generation === r.generation) return { id: r.agent, team: r.team === true }
  }
  return null
}
const valid = (v: unknown): v is SavedWindow => {
  if (!v || typeof v !== 'object') return false
  const r = v as SavedWindow
  return typeof r.key === 'string' && r.key.length < 1024 && typeof r.kind === 'string'
    && (r.org === null || typeof r.org === 'string') && typeof r.open === 'boolean'
    && (r.restore === undefined || validRestore(r.restore))
    && (r.exact === undefined || typeof r.exact === 'boolean')
    && !!r.rect && [r.rect.x, r.rect.y, r.rect.width, r.rect.height].every(Number.isFinite)
    && r.rect.width >= 200 && r.rect.height >= 150 && r.rect.width <= 20000 && r.rect.height <= 20000
}
/** Open windows are never history. Closed placements keep the newest 20 per
 * kind/org (DECISIONS 92), ordered by the store's last-write order. Apply after
 * legacy names migrate, so aliases share one retention group and identity. */
function retainWindows(rows: SavedWindow[]): SavedWindow[] {
  const identities = new Map<string, SavedWindow>()
  for (const row of rows) {
    const previous = identities.get(row.key)
    // Migration can merge a legacy key and its per-target successor. A closed
    // alias must not replace an active window; otherwise prefer the latest.
    if (!previous?.open || row.open) identities.set(row.key, row)
  }
  const closed = new Map<string, number>()
  return rows.filter(row => identities.get(row.key) === row).reverse().filter(row => {
    if (row.open) return true
    const group = JSON.stringify([row.org, baseKind(row.kind)])
    const count = (closed.get(group) ?? 0) + 1
    closed.set(group, count)
    return count <= 20
  }).reverse()
}
export function savedWindows(): SavedWindow[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(WINDOW_LAYOUT_KEY) ?? '[]')
    const kept = Array.isArray(rows) ? rows.filter(valid) : []
    // ONE-OFF (docket several-instances-of-the-same-modal-team-slots-i,
    // approved migration): a per-target surface's single window row becomes
    // the row of the target its restore names, so each target keeps its own
    // window. Written back once; a row with no target to give it stays as it
    // was, and nothing restores it.
    let converted = false
    const out = kept.map((r) => {
      const kind = migratedKind(r.kind, r.restore)
      if (kind === r.kind) return r
      converted = true
      return { ...r, kind, key: windowLayoutKey(kind, r.org),
        ...(r.kind === 'team-docket' ? { restore: { ...r.restore, team: true } } : {}) }
    })
    const retained = retainWindows(out)
    if (converted || retained.length !== kept.length)
      localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify(retained))
    return retained
  } catch { return [] }
}
/** A rename carries each per-target window row of `from` to `to`. */
export function renameWindowRows(org: string, from: string, to: string): void {
  if (!from || !to || from === to) return
  const rows = savedWindows()
  let moved = false
  const next = rows.map((r) => {
    if (r.org !== org || !isInstanceKind(r.kind) || baseKind(r.kind) === 'watchdog' || instanceTarget(r.kind) !== from) return r
    moved = true
    const kind = instanceKind(baseKind(r.kind), to)
    return { ...r, kind, key: windowLayoutKey(kind, org), ...(r.restore ? { restore: { ...r.restore, agent: to } } : {}) }
  })
  if (!moved) return
  try { localStorage.setItem(WINDOW_LAYOUT_KEY, JSON.stringify(next)) } catch { /* storage full */ }
  layoutChanged()
}
// ------------------------------------------- the saved layout CHANGES event
//
// `saveWindow` is a plain localStorage write, and until now it notified
// nobody. A reader whose correctness depends on what the saved layout SAYS had
// no way to learn that it had stopped saying it.
//
// ⚠ THE CASE THIS EXISTS FOR IS A FAILURE PATH, WHICH IS WHY NO OTHER SIGNAL
// COVERED IT. The Attention view keeps a panel subtree mounted while the saved
// layout records a window of its kind as open, so a restore has somewhere to
// land. When the restore FAILS — a blocked window — `MovableSurface` catches,
// redocks and calls `closeSavedWindow`; but nothing was ever registered in
// `windowlife`, so there is no unregister and therefore NO EVENT AT ALL. The
// row flips with nothing to wake any reader. v3-attention-opus measured it in
// real Chromium: the panel was still held 1.5 s later with zero interaction
// and went only when something unrelated happened to re-render. An indefinite
// hold, and "the app re-renders soon" is not a lifecycle guarantee.
//
// ⚠ AND IT MAKES NEW WRITERS SAFE BY CONSTRUCTION. Every writer of this store
// publishes for free — `closeSavedWindow`, `captureWindow`, and anything added
// later — so a consumer's correctness stops resting on an audit of who is
// allowed to write the row. An audit is a promise about the code as it stands
// today; an event is a property of the store.
//
// Deliberately the same shape as `windowlife`'s `subscribeWindows` /
// `windowRevision`, so a consumer is the ordinary
// `useSyncExternalStore(subscribeWindowLayout, windowLayoutRevision,
// windowLayoutRevision)` and there is nothing new to learn.
const layoutListeners = new Set<() => void>()
let layoutRevision = 0
const layoutChanged = () => {
  layoutRevision++
  for (const fn of [...layoutListeners]) fn()
}
export const subscribeWindowLayout = (fn: () => void): (() => void) => {
  layoutListeners.add(fn)
  return () => { layoutListeners.delete(fn) }
}
export const windowLayoutRevision = (): number => layoutRevision

export function saveWindow(row: SavedWindow) {
  if (!valid(row)) return
  try {
    const previous = savedWindows()
    if (JSON.stringify(previous.find(r => r.key === row.key)) === JSON.stringify(row)) return
    const rows = previous.filter(r => r.key !== row.key)
    rows.push(row)
    const value = JSON.stringify(retainWindows(rows))
    if (localStorage.getItem(WINDOW_LAYOUT_KEY) !== value) localStorage.setItem(WINDOW_LAYOUT_KEY, value)
  } catch { /* drafts and window operation still work when storage is full */ }
  // ⚠ AFTER THE WRITE, AND AFTER BOTH EARLY RETURNS. Those guards already
  // drop a row byte-identical to the stored one and a serialized array that
  // has not moved, so putting the notification here means an unchanged write
  // wakes nobody — no churn, and no second equality check to keep in step
  // with the first two.
  //
  // It DOES fire when the write THREW, and that is the safe direction rather
  // than the correct-looking one. A failed write leaves the store unchanged,
  // so strictly there is nothing to announce — but a spurious wake costs one
  // idempotent re-read that re-derives the same answer, while a missed wake
  // costs the indefinite hold this whole mechanism exists to prevent. The
  // asymmetry decides it.
  layoutChanged()
}
export const restoredWindows = (org: string | null) =>
  desktop() ? savedWindows().filter(r => r.open && r.org === org) : []
export const restoreWindowKind = (kind: string, org: string | null) =>
  restoredWindows(org).some(r => r.kind === kind)
/** `native` is the window's own content box as main last reported it (see
 *  SavedWindow `exact`). Until a report arrives, the renderer's view is kept. */
export function captureWindow(key: string, kind: string, org: string | null, w: Window, open = true, restore?: WindowRestore, native?: WindowRect | null) {
  if (!desktop()) return
  try {
    saveWindow({ key, kind, org, open, ...(restore ? { restore } : {}), ...(native ? { rect: { ...native }, exact: true } : { rect: {
      x: w.screenX, y: w.screenY, width: w.outerWidth || 900, height: w.outerHeight || 760,
    } }) })
  } catch { /* a closing native window can lose its document first */ }
}
export function closeSavedWindow(key: string) {
  if (exiting) return
  const row = savedWindows().find(r => r.key === key)
  if (row) saveWindow({ ...row, open: false })
}
/** The shape a popped-out window opens at when it has never been opened
 *  before.
 *
 *  900x760 USED TO BE THE ONLY ANSWER - for a tall narrow desk, a wide
 *  docket, a small usage panel, everything. The content then arrived into
 *  proportions it was never laid out for, which is what the user reported on
 *  2026-09-12: the window "feels resized into the wrong proportions".
 *
 *  So the SHAPE comes from the surface being popped out and the SIZE does
 *  not. `source` is that surface's box on screen at the moment of the
 *  pop-out, which is already the app's own answer to "how big is this
 *  surface": a centred modal measures its default laid-out panel, and a
 *  pinned one measures the box the user dragged it to (`measureRect` in
 *  canvas/modalpin.tsx does exactly this when placing a fresh pin). Only its
 *  ASPECT is used - a desk on a canvas card is a 120px square on screen and
 *  a window that size would be useless - and the AREA stays what the single
 *  fixed size always was, so nothing gets bigger or smaller overall.
 *
 *  ⚠ THE ASPECT IS NOT CLAMPED, deliberately. A band of "reasonable" ratios
 *  would be two invented numbers, and the two real constraints are already
 *  here: the window cannot exceed the screen, and it cannot go below the
 *  size `valid()` above will persist. Scaling to fit the screen divides both
 *  sides equally, so fitting never distorts what it was asked to match.
 */
export const POPUP_DEFAULT = { width: 900, height: 760 }
const POPUP_AREA = POPUP_DEFAULT.width * POPUP_DEFAULT.height
/** the floor `valid()` enforces on a saved window: below it the size cannot
 *  even survive a restart, so there is no point opening one */
const POPUP_MIN = { width: 200, height: 150 }

export function popupSize(source?: { w: number; h: number } | null,
  screenBox?: { width: number; height: number } | null): { width: number; height: number } {
  const aspect = source && source.w > 0 && source.h > 0 ? source.w / source.h : NaN
  if (!Number.isFinite(aspect) || aspect <= 0) return { ...POPUP_DEFAULT }
  let width = Math.sqrt(POPUP_AREA * aspect)
  let height = Math.sqrt(POPUP_AREA / aspect)
  const limit = screenBox ?? (typeof screen === 'undefined' ? null
    : { width: screen.availWidth, height: screen.availHeight })
  if (limit && limit.width > 0 && limit.height > 0) {
    const fit = Math.min(1, limit.width / width, limit.height / height)
    width *= fit; height *= fit
  }
  return {
    width: Math.max(POPUP_MIN.width, Math.round(width)),
    height: Math.max(POPUP_MIN.height, Math.round(height)),
  }
}

/** Where a first-time popout opens, in screen coordinates.
 *
 *  THE PIN RULE, APPLIED TO A NATIVE WINDOW. A fresh pin is placed over the
 *  box the surface already occupied - "so the window appears exactly where
 *  the user was already looking" (`measureRect` in canvas/modalpin.tsx) - and
 *  then clamped into the box that has to contain it. Here the surface's box
 *  is in the OWNER WINDOW's client coordinates, the containing box is the
 *  screen, and the two are bridged by the owner window's own origin.
 *
 *  CENTRED ON THE SOURCE, not aligned to its corner: the window is a
 *  different size from the panel (the aspect is kept, the area is not), so
 *  matching top-left corners would drift further the more the shapes differ.
 *  Centres do not drift.
 *
 *  ⚠ THE MULTI-MONITOR GUARD IS THE WHOLE REASON THIS CAN RETURN NULL. A
 *  renderer only ever sees ONE screen through `screen.avail*` - the one the
 *  browser calls primary - so clamping a window that belongs to a main
 *  window on a second monitor would yank it onto the first. When the owner's
 *  own origin is not inside the screen box we are told about, that box is
 *  describing a different monitor and is not ours to clamp against: we
 *  return no position at all and let the platform place the window beside
 *  its parent, exactly as it did before any of this existed.
 */
export function popupPlacement(
  source: { x: number; y: number; w: number; h: number } | null | undefined,
  size: { width: number; height: number },
  owner?: { screenX: number; screenY: number } | null,
  screenBox?: { left: number; top: number; width: number; height: number } | null,
): { left: number; top: number } | null {
  if (!source || !owner) return null
  if (![source.x, source.y, source.w, source.h, owner.screenX, owner.screenY].every(Number.isFinite)) return null
  const centreX = owner.screenX + source.x + source.w / 2
  const centreY = owner.screenY + source.y + source.h / 2
  let left = centreX - size.width / 2
  let top = centreY - size.height / 2
  // `availLeft`/`availTop` are real in Chromium and absent from the DOM lib's
  // `Screen`; on a single-monitor setup they are 0, which is why the fallback
  // is not a guess.
  const avail = typeof screen === 'undefined' ? null
    : screen as Screen & { availLeft?: number; availTop?: number }
  const box = screenBox ?? (avail ? {
    left: avail.availLeft ?? 0, top: avail.availTop ?? 0,
    width: avail.availWidth, height: avail.availHeight,
  } : null)
  if (box && box.width > 0 && box.height > 0) {
    const ownerInside = owner.screenX >= box.left && owner.screenX < box.left + box.width
      && owner.screenY >= box.top && owner.screenY < box.top + box.height
    if (!ownerInside) return null
    left = Math.min(Math.max(left, box.left), box.left + box.width - size.width)
    top = Math.min(Math.max(top, box.top), box.top + box.height - size.height)
  }
  return { left: Math.round(left), top: Math.round(top) }
}

export interface ModalDimensions { width: number; height: number }

/** Authoritative default minimum dimensions for pinned and popped-out modal windows.
 * Matches .modalpin-win CSS (min-width: 320px; min-height: 240px) and PIN_MIN_W / PIN_MIN_H. */
export const DEFAULT_MODAL_MIN: ModalDimensions = { width: 320, height: 240 }

/** Explicit overrides for modal surfaces with specialized minimums.
 * Specifically, the Agents list (.tray-panel) has a reconciled 200x240 minimum. */
export const MODAL_MIN_OVERRIDES: Record<string, ModalDimensions> = {
  'agent-list': { width: 200, height: 240 },
}

/** Backwards-compatibility alias for overrides map */
export const PINNED_MODAL_MINS = MODAL_MIN_OVERRIDES

/** Non-pinnable overlays and special surfaces that intentionally have no pinned/pop-out minimum dimensions. */
const EXCLUDED_MODAL_KINDS = new Set([
  'draft-scope',
  'openrouter-picker',
  'langserver-browser',
  'advanced-org',
])

export function isModalKindExcluded(cleanKind: string): boolean {
  if (EXCLUDED_MODAL_KINDS.has(cleanKind)) return true
  // Desks on canvas have their own desk layout and sizing rules, not modal minimums
  if (cleanKind.startsWith('desk:')) return true
  // Explicitly unconstrained test/custom fixtures
  if (cleanKind.includes('no-min') || cleanKind.includes('nomin') || cleanKind.startsWith('free-')) return true
  return false
}

export function modalMinDimensions(kind?: string | null): ModalDimensions | null {
  if (!kind || typeof kind !== 'string') return null
  let cleanKind = kind
  if (cleanKind.startsWith('[')) {
    try {
      const parsed = JSON.parse(cleanKind) as unknown
      if (Array.isArray(parsed) && typeof parsed[1] === 'string') {
        cleanKind = parsed[1]
      }
    } catch { /* use kind */ }
  }
  // one target's instance has its surface's minimum (`node-inbox:cora` is a
  // node-inbox), and a target's name never reads as a rule about its kind
  if (cleanKind && isInstanceKind(cleanKind)) cleanKind = baseKind(cleanKind)
  if (!cleanKind || isModalKindExcluded(cleanKind)) return null
  if (cleanKind in MODAL_MIN_OVERRIDES) return MODAL_MIN_OVERRIDES[cleanKind]!
  return DEFAULT_MODAL_MIN
}

export function popupFeatures(key: string,
  source?: { x?: number; y?: number; w: number; h: number } | null,
  owner?: { screenX: number; screenY: number } | null,
  minDimensions?: ModalDimensions | null,
  restoring = false, exactSource = false) {
  // Keep fractional CSS coordinates for the native owner to map using its
  // content origin and webContents zoom. screenX/Y can include invisible
  // frame offsets on Windows; they are only a browser fallback here.
  if (exactSource && !restoring && source && owner && source.w > 0 && source.h > 0
    && [source.x, source.y, source.w, source.h, owner.screenX, owner.screenY].every(Number.isFinite)) {
    return `popup,orgtreeExactRect=1,orgtreeClientX=${source.x},orgtreeClientY=${source.y},orgtreeClientWidth=${source.w},orgtreeClientHeight=${source.h},left=${Math.round(owner.screenX + source.x!)},top=${Math.round(owner.screenY + source.y!)},width=${Math.round(source.w)},height=${Math.round(source.h)}`
  }
  const saved = savedWindows().find(r => r.key === key)
  // Saved standalone bounds are used ONLY when restoring an open window across lifecycle transitions,
  // or when explicitly restoring. Closed standalone bounds (saved.open === false) are ignored.
  if (saved?.rect && (restoring || saved.open)) {
    let { x, y, width, height } = saved.rect
    if (minDimensions) {
      width = Math.max(minDimensions.width, width)
      height = Math.max(minDimensions.height, height)
    }
    const minSuffix = minDimensions ? `,minWidth=${minDimensions.width},minHeight=${minDimensions.height}` : ''
    // A native box goes back exactly: main sets the content bounds and measures
    // away the frame allowance (setExactPopoutBounds), and keeps it off the
    // owner's display mapping (nativePopoutRect in main/windows.ts).
    const exact = saved.exact ? 'orgtreeExactRect=1,orgtreeNativeRect=1,' : ''
    return `popup,${exact}left=${Math.round(x)},top=${Math.round(y)},width=${Math.round(width)},height=${Math.round(height)}${minSuffix}`
  }

  // Ordinary pop-out: initialize from modal's current in-app geometry
  let size: { width: number; height: number }
  if (source && source.w > 0 && source.h > 0) {
    let width = Math.round(source.w)
    let height = Math.round(source.h)
    if (minDimensions) {
      width = Math.max(minDimensions.width, width)
      height = Math.max(minDimensions.height, height)
    }
    width = Math.max(POPUP_MIN.width, width)
    height = Math.max(POPUP_MIN.height, height)
    size = { width, height }
  } else {
    size = popupSize(source)
    if (minDimensions) {
      size.width = Math.max(minDimensions.width, size.width)
      size.height = Math.max(minDimensions.height, size.height)
    }
  }

  const at = popupPlacement(source && typeof source.x === 'number' && typeof source.y === 'number' ? source as { x: number; y: number; w: number; h: number } : null, size, owner)
  const minSuffix = minDimensions ? `,minWidth=${minDimensions.width},minHeight=${minDimensions.height}` : ''
  return `popup,${at ? `left=${at.left},top=${at.top},` : ''}width=${size.width},height=${size.height}${minSuffix}`
}
export function savedDeskIdentities(org: string): [string, string, number][] {
  return restoredWindows(org).flatMap(r => {
    if (!r.kind.startsWith('desk:')) return []
    try {
      const value = JSON.parse(r.kind.slice(5))
      return Array.isArray(value) && value.length === 3 && value[0] === org
        && typeof value[1] === 'string' && Number.isSafeInteger(value[2]) && value[2] >= 0
        ? [value as [string, string, number]] : []
    } catch { return [] }
  })
}
