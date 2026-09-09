import { SetRow, SetToggle } from './settingskit'
import { MovableSurface, PopoutButton, useOverlayRoot, useCurrentOrg, useSurface, useSurfaceDocument } from '../popout'
import { detachedKind } from '../windowlife'
// canvas/modalpin.tsx — PINNING A MODAL TO THE WINDOW (user spec 2026-09-06):
// "most openable modals in the app should be able to be pinned to the window
// and dragged around, like pinned agent windows. this goes for inboxes,
// usage, presentations, the docket, etc."
//
// ⚠ THE WHOLE DESIGN IS ONE RULE: THE DOM SHAPE NEVER CHANGES. Every modal in
// this app is the same two boxes — a full-screen `.overlay` and a `.settings`
// panel centred in it. Pinning does NOT rebuild that; it re-dresses it. The
// same two elements, in the same positions, with the same children in the same
// order, take different classes and an inline rect. React therefore never
// unmounts the panel's subtree, and the surface's scroll position, its open
// row, its half-typed reply and its in-flight fetches all survive a pin, an
// unpin, a drag and a resize without any of the modals knowing this file
// exists. A wrapper that nested the children one level deeper when pinned
// would remount them and lose all of that — it would look identical in a
// screenshot and be wrong.
//
// TWO SPACES, AGAIN (see pins.tsx's header for the agent-window pair). Agent
// windows live in VIEWPORT px, as children of `.viewport`, because they detach
// from a canvas that pans and zooms under them. A pinned modal lives in WINDOW
// px: `.overlay` is `position: fixed; inset: 0`, so an absolutely positioned
// child of it is already in window coordinates and nothing has to convert.
// That is also literally what the user asked for — "pinned to the window".
//
// STACKING. Centred modals are z-index 20. A pinned modal must stay usable
// while another surface opens over it (Astra 2026-09-06), so pinned windows
// take a band ABOVE them, 21–29, hard-clamped exactly like the agent band. The
// disk browser (55), the folder picker (60), the lightbox (95) and toasts
// (100) stay on top of everything, unchanged.
//
// What persists (localStorage `orgtree-modal-pins`): a map of kind → {rect,z}.
// A kind IS the pin — present means pinned, absent means centred — so the
// pinned state survives closing and reopening the surface, the way an agent's
// pinned window survives a reload. Geometry is NOT per-org: `usage` and
// `settings` are the same window whatever org is loaded, and the per-org
// surfaces (docket, gallery, inboxes) are one-at-a-time by construction.
//
// NOT DONE HERE, deliberately: edge/peer snapping (pinSnap.tsx is written
// against a set of sibling agent rects and a viewport, and a modal window has
// no peers to align to), and the minimise ghost (a modal has no card to fly
// home to — unpinning re-centres it in place instead).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode,
  PointerEvent as ReactPointerEvent } from 'react'
import PushPinIcon from '@mui/icons-material/PushPin'
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined'
import { CloseIcon } from '../icons'
import { isMobile } from '../mobile'
import { clampRect, PIN_MIN_H, PIN_MIN_W } from './pins'
import type { PinRect } from './pins'
import type { WindowRestore } from '../windowlayout'
import { useEsc } from './shared'
import { useContextMenu } from './contextmenu'
import type { MenuEntry } from './contextmenu'

/** one pinned modal window. Same shape as an agent pin minus the snap, which
 *  needs peers this window does not have. */
export interface ModalPin {
  /** window px */
  rect: PinRect
  /** stacking ordinal, renormalized to 0..n-1 on every raise */
  z: number
}

/** the band, above the centred overlays (20) and below the disk browser (55) */
export const MODAL_Z_BASE = 21
export const MODAL_Z_TOP = 29
export const modalZIndex = (z: number): number =>
  Math.min(MODAL_Z_TOP, MODAL_Z_BASE + Math.max(0, z))

/** one step above the whole pinned band, for a dialog raised FROM a pinned
 *  window (see ModalOverPins). Still below the disk browser's own centred
 *  layer (55), the folder picker (60), the lightbox (95) and toasts (100). */
export const MODAL_OVER_PINS_Z = 31

export const MODAL_PINS_KEY = 'orgtree-modal-pins'
export const MODAL_OPEN_KEY = 'orgtree-modal-open'
export interface ModalOpenState { kind: string; org: string | null; restore?: WindowRestore }

export const MODAL_OVERLAP_KEY = 'orgtree-modal-overlap-fade'
export interface ModalOverlapSetting { enabled: boolean; opacity: number }
const DEFAULT_OVERLAP: ModalOverlapSetting = { enabled: true, opacity: 0.7 }
let overlapCache: ModalOverlapSetting | null = null
const overlapSubs = new Set<() => void>()
const readOverlap = (): ModalOverlapSetting => {
  if (overlapCache) return overlapCache
  try {
    const parsed = JSON.parse(localStorage.getItem(MODAL_OVERLAP_KEY) || 'null') as Partial<ModalOverlapSetting> | null
    if (parsed && typeof parsed.enabled === 'boolean' && typeof parsed.opacity === 'number' && Number.isFinite(parsed.opacity)) {
      overlapCache = { enabled: parsed.enabled, opacity: Math.min(0.9, Math.max(0.2, parsed.opacity)) }
      return overlapCache
    }
  } catch { /* private mode or malformed preference */ }
  overlapCache = DEFAULT_OVERLAP
  return overlapCache
}
const writeOverlap = (next: ModalOverlapSetting): void => {
  overlapCache = next
  try { localStorage.setItem(MODAL_OVERLAP_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  for (const fn of [...overlapSubs]) fn()
}
const subscribeOverlap = (fn: () => void): (() => void) => {
  overlapSubs.add(fn)
  const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === MODAL_OVERLAP_KEY) { overlapCache = null; fn() } }
  window.addEventListener('storage', onStorage)
  return () => { overlapSubs.delete(fn); window.removeEventListener('storage', onStorage) }
}
export const useModalOverlap = (): ModalOverlapSetting =>
  useSyncExternalStore(subscribeOverlap, readOverlap, () => DEFAULT_OVERLAP)
export const setModalOverlap = (setting: ModalOverlapSetting): void =>
  writeOverlap({ enabled: setting.enabled, opacity: Number.isFinite(setting.opacity) ? Math.min(0.9, Math.max(0.2, setting.opacity)) : DEFAULT_OVERLAP.opacity })

/** Browser-local controls for the overlap treatment of pinned modal windows. */
export function ModalOverlapSettings() {
  const setting = useModalOverlap()
  return <>
    <SetToggle label="fade pinned modals over the focused desk" checked={setting.enabled}
      onChange={enabled => setModalOverlap({ ...setting, enabled })} />
    <SetRow label="overlap opacity">
      <input aria-label="Overlap opacity" type="range" min="0.2" max="0.9" step="0.05" value={setting.opacity}
        disabled={!setting.enabled}
        onChange={e => setModalOverlap({ ...setting, opacity: Number(e.target.value) })} />
      <span className="set-value">{Math.round(setting.opacity * 100)}%</span>
    </SetRow>
  </>
}

/** where a window goes when the panel behind it could not be measured — jsdom
 *  reports every box as 0×0, and so does a panel pinned before first paint.
 *  Clamped like any other rect, so a small window still gets a legal box. */
export const MODAL_FALLBACK_RECT: PinRect = { x: 60, y: 60, w: 660, h: 520 }

/** pinning is a desktop interaction: the mobile UI presents these surfaces as
 *  full-screen sheets and has no room for a floating window (D-125 keeps the
 *  two layouts bit-identical apart from the `html.mobile` class). A stored pin
 *  is not deleted, just not honoured there. */
export const modalPinsAvailable = (): boolean => !isMobile

// ------------------------------------------------------------------ store
// Same contract as pins.tsx: one module-level cache, localStorage-backed,
// exposed through useSyncExternalStore, snapshots replaced (never mutated) so
// a wake that changes nothing is a render React bails out of.
type PinMap = Record<string, ModalPin>
const EMPTY: PinMap = {}
let cache: PinMap | null = null
const subs = new Set<() => void>()
const notify = () => { for (const fn of [...subs]) fn() }

const isRect = (r: unknown): r is PinRect => {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return ['x', 'y', 'w', 'h'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]))
}

/** the pinned modals this browser holds, read once then cached. A hand-edited
 *  or foreign value reads as no pins — never as a throw. */
export const readModalPins = (): PinMap => {
  if (cache) return cache
  let out: PinMap = EMPTY
  try {
    const raw = localStorage.getItem(MODAL_PINS_KEY)
    if (raw) {
      const obj = JSON.parse(raw) as unknown
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const next: PinMap = {}
        for (const [kind, v] of Object.entries(obj as Record<string, unknown>)) {
          const o = v as Record<string, unknown> | null
          if (o && isRect(o.rect) && typeof o.z === 'number' && Number.isFinite(o.z)) {
            next[kind] = { rect: { ...(o.rect as PinRect) }, z: o.z }
          }
        }
        out = next
      }
    }
  } catch { /* private mode, or garbage — same answer */ }
  cache = out
  return out
}

// z ordinals renormalized to 0..n-1 by current order, `top` last
const renorm = (pins: PinMap, top?: string): PinMap => {
  const order = Object.entries(pins).sort((a, b) => a[1].z - b[1].z)
  if (top) {
    const i = order.findIndex(([k]) => k === top)
    if (i >= 0) order.push(...order.splice(i, 1))
  }
  const out: PinMap = {}
  order.forEach(([k, v], i) => { out[k] = { ...v, z: i } })
  return out
}

const write = (next: PinMap): void => {
  cache = next
  try {
    if (Object.keys(next).length) localStorage.setItem(MODAL_PINS_KEY, JSON.stringify(next))
    else localStorage.removeItem(MODAL_PINS_KEY)
  } catch { /* private mode */ }
  notify()
}

/** drop the cached copy so the next read comes from storage again — for a
 *  `storage` event from another tab, and for tests that clear localStorage */
export const forgetModalPins = (): void => { cache = null; notify() }

const validRestore = (v: unknown): v is WindowRestore => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.entries(v).every(([key, value]) => key === 'generation'
    ? Number.isSafeInteger(value) && Number(value) >= 0
    : ['agent', 'document', 'watchdog'].includes(key) && typeof value === 'string' && value.length > 0 && value.length <= 512)
}
const validOpen = (v: unknown): v is ModalOpenState => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Partial<ModalOpenState>
  return typeof o.kind === 'string' && o.kind.length > 0 && o.kind.length <= 512
    && (o.org === null || typeof o.org === 'string')
    && (o.restore === undefined || validRestore(o.restore))
}
let openCache: ModalOpenState[] | null = null
const openSuppressed = new Set<string>()
const openKey = (kind: string, org: string | null) => `${org ?? ''}\u0000${kind}`
export const readModalOpen = (org?: string | null): ModalOpenState[] => {
  if (!openCache) {
    try {
      const parsed = JSON.parse(localStorage.getItem(MODAL_OPEN_KEY) || '[]') as unknown
      openCache = Array.isArray(parsed) ? parsed.filter(validOpen).map((o) => ({
        kind: o.kind, org: o.org, ...(o.restore ? { restore: { ...o.restore } } : {}),
      })) : []
    } catch { openCache = [] }
  }
  return openCache.filter((o) => org === undefined || o.org === null || o.org === org)
}
const writeOpen = (next: ModalOpenState[]): void => {
  openCache = next
  try {
    if (next.length) localStorage.setItem(MODAL_OPEN_KEY, JSON.stringify(next))
    else localStorage.removeItem(MODAL_OPEN_KEY)
  } catch { /* private mode */ }
}
export const rememberModalOpen = (kind: string, org: string | null, restore?: WindowRestore): void => {
  openSuppressed.delete(openKey(kind, org))
  const all = readModalOpen()
  const next = all.filter((o) => openKey(o.kind, o.org) !== openKey(kind, org))
  next.push({ kind, org, ...(restore ? { restore: { ...restore } } : {}) })
  writeOpen(next)
}
export const forgetModalOpen = (kind: string, org: string | null): void => {
  openSuppressed.add(openKey(kind, org))
  const all = readModalOpen()
  const next = all.filter((o) => openKey(o.kind, o.org) !== openKey(kind, org))
  if (next.length !== all.length) writeOpen(next)
}
export const forgetModalOpenCache = (): void => { openCache = null; openSuppressed.clear() }
/** Keep the durable open marker aligned with an owning component's state.
 * The first render is intentionally not treated as a close: restoration sets
 * state in an effect after the component mounts. */
export const usePersistedModalOpen = (kind: string, org: string | null, open: boolean, restore?: WindowRestore): void => {
  const seen = useRef<string | null>(null)
  const restoreKey = restore ? JSON.stringify(restore) : ''
  useEffect(() => {
    const key = openKey(kind, org)
    if (seen.current !== key) {
      // Organization switches can leave the previous owner's state true for
      // one render. Do not write, suppress, or refresh the destination until
      // its own restoration effect has supplied the authoritative state.
      seen.current = key
      return
    }
    if (!isModalPinned(kind)) {
      return
    }
    if (openSuppressed.has(key)) {
      // A real opener may reopen a still-pinned surface after closing it.
      // Unpin remains suppressed because the pin guard above wins.
      if (open) {
        openSuppressed.delete(key)
        rememberModalOpen(kind, org, restore)
      }
      seen.current = key
      return
    }
    if (open) rememberModalOpen(kind, org, restore)
    else forgetModalOpen(kind, org)
  }, [kind, org, open, restoreKey])
}

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn)
  const onStorage = (e: StorageEvent) => {
    if (e.key == null || e.key === MODAL_PINS_KEY) { cache = null; fn() }
  }
  window.addEventListener('storage', onStorage)
  return () => { subs.delete(fn); window.removeEventListener('storage', onStorage) }
}

/** the pin for `kind`, or null when this surface is a centred modal */
export const useModalPin = (kind: string): ModalPin | null => {
  const pins = useSyncExternalStore(subscribe, readModalPins)
  return modalPinsAvailable() ? pins[kind] ?? null : null
}

export const isModalPinned = (kind: string): boolean =>
  modalPinsAvailable() && Boolean(readModalPins()[kind])

/** run `close` ONLY while this surface is a centred modal.
 *
 *  ⚠ A PINNED WINDOW MUST NOT GET OUT OF ITS OWN WAY. Every panel in this app
 *  closes itself on the way to a reference it cannot show — the docket closes
 *  before focusing an agent, the inbox closes before opening a work item —
 *  because a centred panel COVERS the thing it just opened, and leaving it up
 *  looks like a click that did nothing. A pinned window covers nothing: it is
 *  a small box the user placed, and dismissing it there would throw that
 *  placement away with no undo. Same navigation, one condition. */
export const closeIfCentred = (kind: string, close: () => void): void => {
  if (!isModalPinned(kind) && !detachedKind(kind)) close()
}

export const pinModal = (kind: string, rect: PinRect): void => {
  const pins = readModalPins()
  if (pins[kind]) return
  write(renorm({ ...pins, [kind]: { rect: clampRect(rect, winSize()), z: Object.keys(pins).length } }, kind))
}
export const unpinModal = (kind: string): void => {
  const pins = readModalPins()
  if (!pins[kind]) return
  const next = { ...pins }
  delete next[kind]
  write(renorm(next))
}
/** bring `kind` to the front of the band */
export const raiseModal = (kind: string): void => {
  const pins = readModalPins()
  const me = pins[kind]
  if (!me) return
  const top = Object.values(pins).reduce((m, p) => (p.z > m.z ? p : m), me)
  if (top.z === me.z) return
  write(renorm(pins, kind))
}
/** geometry commits ONCE per gesture, at pointer-up, like an agent window */
export const commitModalRect = (kind: string, rect: PinRect): void => {
  const pins = readModalPins()
  if (!pins[kind]) return
  write({ ...pins, [kind]: { ...pins[kind]!, rect: clampRect(rect, winSize()) } })
}

/** the window box a pinned modal is clamped to. `.overlay` is `fixed; inset:0`,
 *  so this is exactly the box its absolutely positioned panel sits in. */
export const winSize = (): { w: number; h: number } | null => {
  const w = typeof window === 'undefined' ? 0 : window.innerWidth
  const h = typeof window === 'undefined' ? 0 : window.innerHeight
  return w > 0 && h > 0 ? { w, h } : null
}

/** the panel's rect on screen right now, in window px — where a fresh pin is
 *  placed, so the window appears exactly where the user was already looking
 *  (the same idea as placing an agent pin over the desk it detached from). */
export const measureRect = (el: HTMLElement | null): PinRect => {
  const r = el?.getBoundingClientRect()
  if (!r || r.width <= 0 || r.height <= 0) return MODAL_FALLBACK_RECT
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

// ------------------------------------------------- a dialog OVER the windows
/**
 * A modal opened from INSIDE a pinned window — compose from the org inbox, a
 * confirmation from the lineage panel. Two things must be true of it, and
 * neither is true of a plain nested overlay:
 *
 * 1. IT MUST NOT BE TRAPPED IN ITS HOST'S STACKING CONTEXT. A DOM descendant
 *    of a pinned panel paints inside that panel's z band whatever its own
 *    z-index says, so its backdrop covers its own host — MEASURED in Edge:
 *    with the org inbox pinned, `elementFromPoint` over the inbox's own title
 *    bar returns the compose backdrop, and the window's drag handle and close
 *    button are unreachable. The same shape from the other side, measured by
 *    codex-delivery on the lineage panel's confirmation: a second pinned
 *    window above the host paints over the dialog. A portal to document.body
 *    takes the dialog out of the band entirely and fixes both.
 *
 * 2. THE PARENT MUST BE CONSTANT. document.body in BOTH modes, never "inline
 *    when centred, portaled when pinned" — moving a subtree between parents
 *    remounts it, and that would throw away a half-typed compose draft on
 *    every pin toggle (Astra 2026-09-06: no lost draft on pin/unpin).
 *
 * Centred, the dialog sits at MODAL_OVER_PINS_Z, ABOVE the whole pinned band:
 * a dialog raised from a pinned window that rendered BEHIND that window would
 * be the same defect with its sign flipped. Pinned, the frame's own inline
 * z-index wins over that rule and the dialog joins the band like any other
 * window.
 *
 * The wrapper swallows pointerdown for the same reason `MaybePortal` does: a
 * React portal still bubbles events through the REACT tree, so without this a
 * press inside the dialog would also reach the host panel's handler and raise
 * the HOST above the dialog it just opened.
 */
export function ModalOverPins({ children }: { children: ReactNode }) {
  const overlayRoot = useOverlayRoot()
  if (typeof document === 'undefined') return <>{children}</>
  return createPortal(
    <div className="modalpin-over" onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    overlayRoot)
}

// --------------------------------------------------------------- component
type GestureShape =
  | { kind: 'move'; sx: number; sy: number; o: PinRect }
  | { kind: 'size'; sx: number; sy: number; o: PinRect; edge: string }
type Gesture = GestureShape & { pointerId: number; moved: boolean; capture: HTMLElement }

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

export interface PinFrameProps {
  restore?: import('../windowlayout').WindowRestore
  pinnable?: boolean
  /** Keep an unpinned surface in its original layout instead of an overlay. */
  inline?: boolean
  dialogLabel?: string
  /** the window's identity in storage — stable, and unique per surface */
  kind: string
  /** what the pinned title bar calls this window */
  title: ReactNode
  /** the panel's own classes, exactly the ones it had before it was wrapped */
  panel: string
  /** extra classes for the OVERLAY, for the one surface that had them: the
   *  disk browser's `.disk-overlay` carries its centred layer (z-index 55).
   *  Pinning overrides that with the band's inline z-index, so the class can
   *  stay exactly as it was and the centred layer is untouched. */
  overlayClass?: string
  /** dismiss the surface (the same `close` the panel already had) */
  close: () => void
  children: ReactNode
  /** what Escape does while the surface is CENTRED; defaults to `close`.
   *  A PINNED window ignores Escape, like an agent window: it is not a modal
   *  interruption any more, and Escape there cancels a drag instead. */
  onEsc?: () => void
  /** a click on the backdrop closes the surface (default true, the rule every
   *  overlay already had). Never fires while pinned — there is no backdrop. */
  backdropClose?: boolean
  /** the panel's own click handler, for the two readers that open a lightbox
   *  from a click that must not also reach the backdrop. The frame keeps the
   *  stopPropagation every panel already had; this runs before it. */
  onPanelClick?: (e: ReactMouseEvent<HTMLDivElement>) => void
}

/**
 * The overlay + panel pair every modal in this app is built from, with the
 * pinning interaction folded in. Callers pass what used to be the two divs'
 * class names and handlers, and their children unchanged.
 */
export function PinFrame(props: PinFrameProps) {
  const org = useCurrentOrg()
  const scope = ['usage', 'defaults', 'app-settings', 'advanced-org'].includes(props.kind) ? null : org
  return <MovableSurface key={scope} org={scope} kind={props.kind} title={props.title} restore={props.restore}><PinFrameInner {...props} orgScope={scope} /></MovableSurface>
}

function PinFrameInner({ kind, title, panel, overlayClass, close, children,
  onEsc, backdropClose = true, onPanelClick, pinnable = true, inline = false, dialogLabel, restore, orgScope }: PinFrameProps & { orgScope: string | null }) {
  const pin = useModalPin(kind)
  const surface = useSurface()
  const ownerDocument = useSurfaceDocument()
  const ownerWindow = ownerDocument.defaultView ?? window
  const detached = !!surface?.detached
  const pinned = pin !== null && !detached
  const inPlace = inline && !pinned && !detached
  const overlapSetting = useModalOverlap()
  const [overlapsDesk, setOverlapsDesk] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // Escape is the CENTRED surface's exit only (see onEsc). The hook is always
  // called — hooks are not conditional — and is handed a no-op when pinned.
  const esc = onEsc ?? close
  useEsc(useCallback(() => esc(), [esc]), !pinned && !detached)

  // the in-flight gesture's rect lives in component state (one render per
  // pointer move); the store is written ONCE, at pointer-up
  const [live, setLive] = useState<PinRect | null>(null)
  const gesture = useRef<Gesture | null>(null)
  // a window resize can strand a pinned window with no gesture to follow it,
  // so clamping happens at render time against the CURRENT window — and this
  // tick is what makes a resize a render
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    ownerWindow.addEventListener('resize', bump)
    return () => ownerWindow.removeEventListener('resize', bump)
  }, [ownerWindow])

  const cancel = () => {
    const g = gesture.current
    gesture.current = null
    if (g) { try { g.capture.releasePointerCapture(g.pointerId) } catch { /* gone */ } }
    setLive(null)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && gesture.current) {
        // a cancelled drag must not also close the surface behind it
        e.preventDefault(); e.stopPropagation(); cancel()
      }
    }
    ownerWindow.addEventListener('keydown', onKey, true)
    return () => ownerWindow.removeEventListener('keydown', onKey, true)
  }, [ownerWindow])

  const rect = pin && !detached ? clampRect(live ?? pin.rect, winSize()) : null

  useEffect(() => {
    if (!pinned || detached || !overlapSetting.enabled) { setOverlapsDesk(false); return }
    const check = () => {
      const desk = ownerDocument.querySelector<HTMLElement>('.sq.desk')
      const modal = panelRef.current
      if (!desk || !modal) { setOverlapsDesk(false); return }
      const a = desk.getBoundingClientRect(), b = modal.getBoundingClientRect()
      setOverlapsDesk(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)
    }
    check()
    const timer = ownerWindow.setInterval(check, 120)
    ownerWindow.addEventListener('resize', check)
    return () => { ownerWindow.clearInterval(timer); ownerWindow.removeEventListener('resize', check) }
  }, [detached, ownerDocument, ownerWindow, pinned, overlapSetting.enabled])

  const begin = (e: ReactPointerEvent<HTMLElement>, g: GestureShape) => {
    if (e.button !== 0 || gesture.current || !rect) return
    e.stopPropagation()          // never let this reach the canvas
    e.preventDefault()           // no text-selection drag from the chrome
    gesture.current = { ...g, pointerId: e.pointerId, moved: false, capture: e.currentTarget }
    e.currentTarget.setPointerCapture(e.pointerId)
    raiseModal(kind)
  }
  const gestureRect = (g: Gesture, e: ReactPointerEvent<HTMLElement>): PinRect => {
    // window px: a drag is 1:1 with the pointer, with no zoom to divide out —
    // nothing about this rect is in world space.
    //
    // ⚠ NOT CLAMPED HERE. There is ONE clamp boundary — the render, which has
    // to clamp anyway (a browser resize moves no pointer and still must not
    // strand a window) and the commit, which is the same call. A third clamp
    // in here would be a guard nothing could ever be seen failing: with the
    // other two in place it changes no pixel and no stored byte, and
    // `modalpin_probe.py`'s `no-render-time-clamp` mutant is what proves the
    // remaining one is load-bearing. Keeping the raw offset also means a drag
    // that overshoots an edge and comes back lands where the pointer says,
    // rather than from wherever it was pinned to the edge.
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy
    if (g.kind === 'move') return { ...g.o, x: g.o.x + dx, y: g.o.y + dy }
    let { x, y, w, h } = g.o
    if (g.edge.includes('e')) w = g.o.w + dx
    if (g.edge.includes('s')) h = g.o.h + dy
    if (g.edge.includes('w')) { w = g.o.w - dx; x = g.o.x + dx }
    if (g.edge.includes('n')) { h = g.o.h - dy; y = g.o.y + dy }
    // the floor pins the OPPOSITE edge: shrinking past the minimum from the
    // west/north must not walk the window across the screen
    if (w < PIN_MIN_W) { if (g.edge.includes('w')) x = g.o.x + g.o.w - PIN_MIN_W; w = PIN_MIN_W }
    if (h < PIN_MIN_H) { if (g.edge.includes('n')) y = g.o.y + g.o.h - PIN_MIN_H; h = PIN_MIN_H }
    return { x, y, w, h }
  }
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || e.pointerId !== g.pointerId) return
    g.moved ||= Math.hypot(e.clientX - g.sx, e.clientY - g.sy) >= 3
    if (!g.moved) return
    setLive(gestureRect(g, e))
  }
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || e.pointerId !== g.pointerId) return
    const moved = g.moved || Math.hypot(e.clientX - g.sx, e.clientY - g.sy) >= 3
    gesture.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    setLive(null)
    // a title-bar click that did not move raises and nothing else — it never
    // repositions and never dismisses
    if (moved) commitModalRect(kind, gestureRect(g, e))
  }

  const toggle = () => {
    if (pinned) {
      unpinModal(kind)
      forgetModalOpen(kind, orgScope)
    } else {
      pinModal(kind, measureRect(panelRef.current))
      rememberModalOpen(kind, orgScope, restore)
    }
  }
  const closeSurface = () => { forgetModalOpen(kind, orgScope); close() }
  // THE BAR'S CONTEXT MENU (contextmenu.tsx, 2026-09-07): the three controls
  // the bar already carries — pin/unpin, the pop-out (surface.open/redock,
  // exactly what PopoutButton calls), close — by name. State-dependent
  // labels say the effect (Unpin, Return to main window).
  const menu = useContextMenu()
  const barMenu = (): MenuEntry[] => {
    const entries: MenuEntry[] = []
    if (surface && !isMobile) {
      entries.push(surface.detached
        ? { label: 'Return to main window', onSelect: () => surface.redock() }
        : { label: 'Open in new window', onSelect: () => surface.open() })
    }
    if (pinnable) {
      entries.push({ label: pinned ? 'Unpin' : 'Pin to window', disabled: detached,
        title: pinned ? 'put this back in the middle of the screen'
          : 'pin this to the window, so it stays put and can be dragged around',
        onSelect: toggle })
    }
    entries.push('sep', { label: 'Close', onSelect: closeSurface })
    return entries
  }

  const style: CSSProperties | undefined = rect
    ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
    : undefined
  return (
    <div className={(inPlace ? 'surface-inline' : 'overlay') + (overlayClass ? ' ' + overlayClass : '')
      + (pinned ? ' overlay-pinned' : '') + (detached ? ' overlay-detached' : '')}
      style={pin && !detached ? { zIndex: modalZIndex(pin.z) } : undefined}
      onClick={inPlace || pinned || detached || !backdropClose ? undefined
        : (e) => { e.stopPropagation(); closeSurface() }}
      onPointerDown={(e) => e.stopPropagation()}>
      {/* ⚠ SAME ELEMENT, SAME CHILDREN, IN BOTH MODES — see the header. Only
          the class list and the inline rect change, so React keeps the whole
          subtree mounted across a pin, an unpin, a drag and a resize. */}
      <div ref={panelRef} role={dialogLabel ? (inPlace ? "region" : "dialog") : undefined} aria-label={dialogLabel} className={panel + (pinned ? ' modalpin-win' : '')}
        style={{ ...style, ...(pinned && overlapSetting.enabled && overlapsDesk
          ? { opacity: overlapSetting.opacity } : {}) }}
        onClick={(e) => { onPanelClick?.(e); e.stopPropagation() }}
        onPointerDown={pinned ? () => raiseModal(kind) : undefined}>
        <div className={'modalpin-bar' + (pinned ? ' on' : '')}
          title={pinned
            ? 'drag to move this window; drag an edge to resize. Escape cancels a drag.'
            : undefined}
          onPointerDown={pinned && rect
            ? (e) => begin(e, { kind: 'move', sx: e.clientX, sy: e.clientY, o: rect })
            : undefined}
          onPointerMove={pinned ? move : undefined}
          onPointerUp={pinned ? end : undefined}
          onPointerCancel={pinned ? cancel : undefined}
          onLostPointerCapture={pinned ? cancel : undefined}
          onContextMenu={(e) => menu.open(e, barMenu)}>
          {menu.node}
          {pinned && <>
            <PushPinIcon fontSize="inherit" className="modalpin-glyph" />
            {/* ⚠ THIS IS THE SURFACE'S HEADING WHILE PINNED, not decoration.
                The panel's own <h3> is hidden by CSS in this mode (one title,
                not two — Astra 2026-09-06), so if this span carried no
                semantics the window would have no heading at all for a screen
                reader. `aria-level` 3 is the level the hidden h3 had. */}
            <span className="modalpin-name" role="heading" aria-level={3}>
              {title}</span>
          </>}
          <span className="spacer" />
          <PopoutButton />
          {pinnable && <button type="button" className="modalpin-btn" disabled={detached}
            title={pinned
              ? 'unpin — put this back in the middle of the screen'
              : 'pin this to the window, so it stays put and can be dragged around'}
            aria-label={pinned ? 'unpin this window' : 'pin this to the window'}
            aria-pressed={pinned}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); toggle() }}>
            {pinned ? <PushPinIcon fontSize="inherit" />
              : <PushPinOutlinedIcon fontSize="inherit" />}
          </button>}
          {pinned && (
            <button type="button" className="modalpin-btn modalpin-x" title="close"
              aria-label="close this window"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); closeSurface() }}>
              <CloseIcon fontSize="inherit" />
            </button>
          )}
        </div>
        {children}
      </div>
      {/* Outside the scrolling panel: all handles stay at the visible frame
          even when the content scrolls. The content keeps its mounted place. */}
      {pinned && <div className="modalpin-resize-frame" style={style}>
        {EDGES.map((edge) => (
          <div key={edge} className={'modalpin-rs ' + edge}
            onPointerDown={rect
              ? (e) => begin(e, { kind: 'size', sx: e.clientX, sy: e.clientY, o: rect, edge })
              : undefined}
            onPointerMove={move} onPointerUp={end}
            onPointerCancel={cancel} onLostPointerCapture={cancel} />
        ))}
      </div>}
    </div>
  )
}
