// canvas/contextmenu.tsx — THE APPLICATION CONTEXT MENU (user request
// 2026-09-07: application objects showed the browser's default menu rather
// than their own actions; proposal in coordinator-astra/context-menu-proposal.md).
//
// ONE MECHANISM, MANY OBJECTS. A component (or a list that renders its rows
// inline) holds one menu state through `useContextMenu()` and opens it from
// an `onContextMenu` handler with the entries for the object under the
// pointer. The entries are built from the object's EXISTING handlers — the
// same callbacks the card buttons, row clicks and title-bar controls already
// call — so a menu item can never do something the visible control cannot,
// and a destructive item runs the very same confirm the button runs.
//
// THE RULES THE PROPOSAL SETS, and where each lives:
//   * right-click never activates the object — `contextmenu` is not `click`,
//     the gestures that start on pointerdown already ignore `button !== 0`
//     (OrgCanvas pan/drag, pins, modalpin), and `open` calls nothing but
//     `setState`;
//   * the browser menu is KEPT where it is the right one — an editable field,
//     a live text selection, an ordinary link inside the object: see
//     `nativeMenuPreferred`, which `open` consults first and, when it says so,
//     returns without `preventDefault`;
//   * keyboard activation (Shift+F10, the ContextMenu key) is the browser's
//     own `contextmenu` dispatch on the focused element — there is no key
//     handling here. The anchor is the pointer when it lies inside the
//     object's box, else the object's box (a keyboard-raised event carries no
//     useful pointer);
//   * the menu stays inside the viewport (measured, then clamped), closes on
//     Escape (through the per-document `useEsc` stack, so the modal beneath
//     does not also close), on a press outside (NOT prevented — the outside
//     press still does what it does), on wheel/scroll/resize/blur, and on
//     selecting an item;
//   * a menu raised inside a popped-out surface renders IN THAT WINDOW:
//     the node portals into the ORIGINATING document's BODY, and every
//     listener is bound to the menu element's own document/window, never the
//     module globals. The body and not the surface's overlay container on
//     purpose: a desk on the canvas lives under two transforms (`.space`'s
//     camera and `.desk-inner`'s counter-scale), and `position: fixed` inside
//     a transformed ancestor is positioned in THAT box, in authored px — a
//     menu for a row in the desk's inbox tab would land scaled and elsewhere.
//     A document's body is never transformed.
//
// ⚠ THE ORIGIN IS THE ELEMENT THAT WAS PRESSED, NOT THE REACT TREE (ticket
// position-context-menus-in-the-originating-popout, user report: a popped-out
// modal moved away from the main window drew its menu on the main canvas,
// far from the pointer).
//
// Orgtree is ONE renderer with MANY documents: a popout is a frameless native
// window whose about:blank document is adopted by the main window, so its
// React handlers run in the main window's realm (see popoutRegistry in
// main/windows.ts). There is no native Menu.popup and no second webContents to
// ask — "which window did this come from" is answered here, by the DOM.
//
// `useSurfaceDocument()` answers it from REACT CONTEXT, at the component that
// happens to hold the menu state — and that component is frequently OUTSIDE
// the `MovableSurface` whose window the user is actually clicking in
// (DocGalleryModal calls `useContextMenu` and then renders the `PinFrame` that
// creates the surface). The menu then portaled into the MAIN document while
// `clientX/clientY` were measured in the POPOUT's viewport: a menu on the main
// canvas at an offset nobody pointed at. OrgCanvas's `AgentListMenuHost` had to
// dodge that trap by hand for one list — but ⚠ DODGING IT IS NOT ALL THAT HOST
// DOES, so do not read this as licence to delete it now that the routing is
// fixed: it also holds the retire-confirm state and its portal, and it must
// stay inside `<DeskHosts>` because `useDeskActionsNow` reads that provider and
// would get null from OrgCanvas's body. See its own comment.
//
// So `open` records `anchor.ownerDocument` — the document the press really
// happened in — and everything downstream follows it: the portal target, the
// viewport clamp, the focus restore, the Escape stack and the dismissal
// listeners. A main-window press resolves to `document` exactly as before, two
// popouts each resolve to their own window, and an origin whose window has
// gone opens nothing anywhere (see `liveBody`).
//
// NOTHING CONVERTS COORDINATES, ON PURPOSE. `clientX/clientY` are CSS pixels in
// the originating window's own viewport, and the menu is placed with CSS
// `left`/`top` in that same document — so a scaled display or a second monitor
// at another DPI cancels out, because the number never leaves the window it was
// measured in. Screen-space arithmetic here is what WOULD break mixed DPI.
//
// ⚠ A REACT PORTAL STILL BUBBLES THROUGH THE REACT TREE. The menu is a React
// descendant of the object that opened it, so a press on a menu item would
// reach the card's onPointerDown (a drag), the row's onClick (a select), the
// pin bar's gesture. The menu root therefore stops every pointer/mouse/key
// event's React propagation — the same reason ModalOverPins swallows
// pointerdown.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, HTMLAttributes, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent,
  ReactNode, SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { useSurfaceDocument } from '../popout'
import { useEsc } from './shared'
import type { ToastFn } from '../types'

export interface MenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Submenu parents can be expanded even when selecting the parent is unavailable. */
  children?: MenuEntry[]
  actionDisabled?: boolean
  description?: string
  /** a destructive action — drawn in the caution colour; callers place it
   *  after a separator at the end of the list */
  danger?: boolean
  title?: string
}
export type MenuEntry = MenuItem | 'sep'

// Explicit object identities, never inferred from textContent: a card also
// contains status/model text, and a ticket row displays its slug, not title.
const COPY_OBJECT = '[data-copy-agent-name], [data-copy-ticket-title]'
const CopyFeedback = createContext<ToastFn | undefined>(undefined)
// the anchor is stored as the LIVE REF, not the element that was current when
// the menu opened: a host whose object is re-rendered under the menu re-anchors
// it (see `reanchor`), and a stale entry here would answer for the wrong node
const menuAnchors = new WeakMap<Element, { current: Element | null }>()

/** Portals sit outside their surface's DOM. Outside-click guards must still
 * treat a press in that surface's own menu as an inside press. */
export function contextMenuBelongsTo(target: EventTarget | null, surface: Element): boolean {
  const menu = (target as Element | null)?.closest?.('.ctxmenu')
  const anchor = menu && menuAnchors.get(menu)?.current
  return !!anchor && surface.contains(anchor)
}

function copyObjectAt(target: EventTarget | null, within?: Element): Element | null {
  const object = (target as Element | null)?.closest?.(COPY_OBJECT)
  return object && (!within || within.contains(object)) ? object : null
}

function objectCopyEntry(object: Element, toast?: ToastFn): MenuItem {
  const agent = object.getAttribute('data-copy-agent-name')
  const label = agent !== null ? 'Copy agent name' : 'Copy ticket title'
  const text = agent ?? object.getAttribute('data-copy-ticket-title')!
  return { label, onSelect: () => {
    void copyToClipboard(object, text).then(ok => toast?.([
      ok ? (agent !== null ? 'copied agent name' : 'copied ticket title')
        : 'could not copy — clipboard unavailable',
    ]))
  } }
}

/** One fallback per surface for object names without another menu. Existing
 * menus take the event first and receive the same copy entry in `open`.
 * Replaces the surface's div, preserving its layout and event boundaries. */
export function ObjectMenuBoundary({ children, toast, onContextMenu, ...props }:
  HTMLAttributes<HTMLDivElement> & { toast?: ToastFn }) {
  const inheritedFeedback = useContext(CopyFeedback)
  const feedback = toast ?? inheritedFeedback
  const menu = useContextMenu(feedback)
  return <CopyFeedback.Provider value={feedback}>
    <div {...props} onContextMenu={e => {
      const object = copyObjectAt(e.target)
      if (object) menu.open(e, [], object)
      onContextMenu?.(e)
    }}>{children}</div>
    {menu.node}
  </CopyFeedback.Provider>
}

/** gap kept between the menu and the viewport edge, px */
const EDGE_GAP = 4

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

/** Where the browser's own menu is the right one (proposal: "keep the browser
 *  menu for editable fields, selected text, ordinary links"). The object's
 *  handler consults this FIRST and, when it answers true, leaves the event
 *  alone entirely — no preventDefault, no menu of ours.
 *
 *  `currentTarget` is the object; `target` is what was actually pressed.
 *   - an editable control anywhere under the press keeps its menu
 *     (spell-check, paste, undo live there);
 *   - a NON-COLLAPSED selection that touches the object keeps the menu
 *     (copy/search-for live there). A collapsed caret is not a selection;
 *   - a link INSIDE the object keeps its menu (open in new tab, copy link
 *     address). The object being a link itself — an HTML mockup card is one —
 *     does not count: that link IS the object and gets the object's menu. */
export function nativeMenuPreferred(e: { target: EventTarget | null; currentTarget: EventTarget | null }): boolean {
  const target = e.target as Element | null
  const object = e.currentTarget as Element | null
  if (!target || !object || typeof target.closest !== 'function') return false
  if (target.closest(EDITABLE)) return true
  const link = target.closest('a[href]')
  if (link && link !== object) return true
  const win = object.ownerDocument?.defaultView
  const sel = win?.getSelection?.()
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i)
      // a selection that intersects the object — one elsewhere on the page
      // is not a reason to withhold this object's menu
      if (typeof r.intersectsNode === 'function' ? r.intersectsNode(object)
        : object.contains(r.commonAncestorContainer)) return true
    }
  }
  return false
}

interface MenuState {
  opening: number
  x: number
  y: number
  entries: MenuEntry[]
  /** where focus was when the menu opened — restored on close */
  restore: Element | null
  /** raised without a usable pointer (keyboard): focus lands on the first
   *  item so the arrow keys have somewhere to start from */
  keyboard: boolean
  /** THE ORIGIN: the document the right-click actually happened in — the main
   *  window's, or a particular popout's. `x`/`y` are client coordinates in
   *  THIS document's window and are only meaningful here. */
  doc: Document
}

/** The body to draw a menu for `doc` into, or null when that window is gone.
 *
 *  A popout can close between the press and the render — the user hits its ✕,
 *  or the surface redocks — and a menu is not worth resurrecting in some other
 *  window: it would be the very "menu on the main canvas" this ticket removes,
 *  and its entries act on a surface that has moved. So the origin dying closes
 *  the menu and opens nothing anywhere. */
function liveBody(doc: Document | null | undefined): HTMLElement | null {
  const view = doc?.defaultView
  return view && !view.closed && doc!.body ? doc!.body : null
}

export interface ContextMenuHandle {
  append: (entry: MenuEntry, opening: number) => void
  /** the object's `onContextMenu`. `entries` may be a thunk so a list that
   *  renders many rows builds only the pressed row's items. */
  open: (e: ReactMouseEvent, entries: MenuEntry[] | (() => MenuEntry[]), anchor?: Element) => number | undefined
  close: () => void
  /** Point the open menu at the element that carries its object NOW.
   *
   *  A host whose list re-projects itself under an open menu — a live
   *  transcript is the case this exists for — replaces the very node the menu
   *  was opened from. The old one is then detached, which the scroll rule
   *  below reads as an unanswerable case and closes on, so the menu died on
   *  the next scroll anywhere on screen. The host knows which element carries
   *  its object now; this is how it says so.
   *
   *  Deliberately a REF WRITE and not state: re-rendering the menu would re-run
   *  its position/focus layout effect, moving focus off whatever item the
   *  operator had reached. Nothing about the menu's appearance depends on the
   *  anchor — only the "did this scroll move me" question does.
   *
   *  `null` is IGNORED rather than clearing the anchor: a host that has
   *  momentarily lost sight of its object has said nothing about where the
   *  menu is, and an unanchored menu dismisses itself on the next scroll
   *  anywhere on screen. Where the object is really gone, the last anchor is
   *  detached, which is the unanswerable case the scroll rule already
   *  closes on. */
  reanchor: (el: Element | null) => void
  isOpen: boolean
  /** render this once, anywhere in the component's tree */
  node: ReactNode
}

export function useContextMenu(toast?: ToastFn): ContextMenuHandle {
  const [state, setState] = useState<MenuState | null>(null)
  const inheritedFeedback = useContext(CopyFeedback)
  const feedback = toast ?? inheritedFeedback
  // the LAST RESORT only: an anchor always has an ownerDocument, so this is
  // reached for nothing real. It is kept so a future caller that hands `open`
  // a synthetic anchor still lands in its own surface rather than at `document`
  const surfaceDocument = useSurfaceDocument()
  const anchorRef = useRef<Element | null>(null)
  const opening = useRef(0)
  const close = useCallback(() => setState(null), [])
  const append = useCallback((entry: MenuEntry, id: number) => setState(s => s && opening.current === id ? { ...s,
    entries: [...s.entries.filter(e => e === 'sep' || entry === 'sep' || e.label !== entry.label), entry] } : s), [])
  const reanchor = useCallback((el: Element | null) => { if (el) anchorRef.current = el }, [])
  const open = useCallback((e: ReactMouseEvent, entries: MenuEntry[] | (() => MenuEntry[]), anchor?: Element) => {
    if (e.defaultPrevented) return           // an inner object already took it
    const el = anchor ?? e.currentTarget as HTMLElement
    // WHICH WINDOW — asked of the element under the pointer, before anything
    // else reads a coordinate. A press whose window has already gone opens
    // nothing and is not prevented: there is no viewport left to place a menu
    // in, and placing it in another window is the bug, not the fallback.
    const doc = el.ownerDocument ?? surfaceDocument
    if (!liveBody(doc)) return
    if (nativeMenuPreferred({ target: e.target, currentTarget: el })) return
    const entriesList = (typeof entries === 'function' ? entries() : entries)
    const object = copyObjectAt(e.target, el)
    const list: MenuEntry[] = object
      ? [objectCopyEntry(object, feedback), ...(entriesList.length ? ['sep' as const, ...entriesList] : [])]
      : entriesList
    // nothing to offer is not a menu: the browser's own stands
    if (!list.some((x) => x !== 'sep')) return
    e.preventDefault()
    e.stopPropagation()
    const r = el.getBoundingClientRect()
    const measured = r.width > 0 || r.height > 0
    const inside = measured && e.clientX >= r.left && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom
    anchorRef.current = el
    setState({
      opening: ++opening.current,
      x: inside ? e.clientX : r.left,
      y: inside ? e.clientY : r.bottom,
      entries: list,
      restore: doc.activeElement,
      keyboard: !inside,
      doc,
    })
    return opening.current
  }, [feedback, surfaceDocument])

  // THE ORIGIN CLOSING WHILE THE MENU IS UP. `pagehide` is what MovableSurface
  // itself listens for to redock a surface whose window went away, so it is
  // the same signal, taken from the menu's side: the menu goes with the window
  // it belongs to rather than being left pointing into a torn-down document.
  const originWindow = state?.doc.defaultView ?? null
  useEffect(() => {
    if (!originWindow) return
    const gone = () => close()
    originWindow.addEventListener('pagehide', gone)
    originWindow.addEventListener('unload', gone)
    return () => {
      originWindow.removeEventListener('pagehide', gone)
      originWindow.removeEventListener('unload', gone)
    }
  }, [originWindow, close])

  // read at RENDER, not only at open: a window closed without firing anything
  // we heard still has no body to draw into, and must not take the main one
  const target = state && liveBody(state.doc)
  const node = target
    ? createPortal(<ContextMenu state={state} anchorRef={anchorRef} close={close} />, target)
    : null
  return { open, close, append, reanchor, isOpen: !!target, node }
}

const stop = (e: SyntheticEvent) => e.stopPropagation()

function ContextMenu({ state, anchorRef, close }:
{ state: MenuState; anchorRef: { current: Element | null }; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // the anchor is read through the ref its OWNER holds, so the listener effect
  // below stays keyed on `close` alone (re-registering four document listeners
  // on every anchor change would be a second behaviour, not a fix) — and so
  // that `reanchor` can move it without re-rendering this component at all
  // Escape joins the ORIGIN document's stack (shared.ts): pushed last, so it
  // is the top entry and the surface beneath keeps its own Escape for later.
  // Named explicitly rather than left to `useSurfaceDocument()`, for the same
  // reason the portal is: this component's React position is the menu owner's,
  // which need not be the window the menu is in — and an Escape stack in the
  // wrong document is one the surface under this menu never shares, so Escape
  // would close that surface straight through an open menu.
  useEsc(close, true, state.doc)
  const [pos, setPos] = useState({ x: state.x, y: state.y })
  const focusedOpening = useRef<number | undefined>(undefined)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const win = el.ownerDocument.defaultView ?? window
    const w = el.offsetWidth, h = el.offsetHeight
    const vw = win.innerWidth, vh = win.innerHeight
    // clamp into the viewport; when both dimensions are unmeasured (jsdom)
    // the anchor stands
    const x = Math.max(EDGE_GAP, Math.min(state.x, vw - w - EDGE_GAP))
    const y = Math.max(EDGE_GAP, Math.min(state.y, vh - h - EDGE_GAP))
    setPos({ x, y })
    // focus: the first enabled item for a keyboard open, else the menu
    // itself (a mouse open highlights nothing, as native menus do; the arrow
    // keys still walk from here)
    if (focusedOpening.current !== state.opening) {
      focusedOpening.current = state.opening
      const first = el.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      if (state.keyboard && first) first.focus()
      else el.focus({ preventScroll: true })
    }
  }, [state])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const doc = el.ownerDocument
    const win = doc.defaultView ?? window
    const outside = (e: Event) => {
      const t = e.target as Node | null
      if (t && el.contains(t)) return
      close()
    }
    const away = () => close()
    // ⚠ SCROLL IS NOT LIKE THE OTHERS. It does not bubble, so this listener
    // sees an element's scroll only because it is registered in CAPTURE mode
    // — which means it sees EVERY pane on screen. A chat the reader is at the
    // bottom of autoscrolls on each arriving event (`pin()` in desk.tsx), and
    // that closed this menu from across the screen (user report 2026-09-11).
    // The point of closing on scroll is that a menu is anchored to viewport
    // coordinates, so ask exactly that: did this scroll move OUR anchor? A
    // pane that does not contain it cannot have. Anything else still closes,
    // and so does an unanswerable case — no anchor, a detached one, a
    // non-element target, another document — which is the old behaviour.
    const scrolled = (e: Event) => {
      const t = e.target as Node | null
      if (t && el.contains(t)) return                  // the menu's own scroll
      const at = anchorRef.current
      const target = t as Element | null
      if (at?.isConnected && target && typeof target.contains === 'function'
        && !target.contains(at)) return
      close()
    }
    // capture: the press closes the menu BEFORE whatever it lands on runs,
    // and is never prevented — clicking a card while a menu is open still
    // clicks the card; a second right-click elsewhere replaces the menu
    doc.addEventListener('pointerdown', outside, true)
    doc.addEventListener('contextmenu', outside, true)
    // the wheel stays unconditional: it is a DELIBERATE gesture, and over the
    // canvas it zooms, which moves every anchor there is
    doc.addEventListener('wheel', outside, true)
    doc.addEventListener('scroll', scrolled, true)
    win.addEventListener('resize', away)
    win.addEventListener('blur', away)
    return () => {
      doc.removeEventListener('pointerdown', outside, true)
      doc.removeEventListener('contextmenu', outside, true)
      doc.removeEventListener('wheel', outside, true)
      doc.removeEventListener('scroll', scrolled, true)
      win.removeEventListener('resize', away)
      win.removeEventListener('blur', away)
    }
  }, [close])

  // focus goes back where it came from, but only if the menu still holds it
  // — an item that opened a dialog has moved focus on purpose
  const restore = state.restore
  useEffect(() => () => {
    const active = restore?.ownerDocument.activeElement
    const inMenu = !active || active === restore?.ownerDocument.body
      || active.closest?.('.ctxmenu')
    if (inMenu && restore?.isConnected && typeof (restore as HTMLElement).focus === 'function') {
      (restore as HTMLElement).focus({ preventScroll: true })
    }
  }, [restore])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation()   // the host's own key handling (mail alt+↑/↓, card) stays out
    const level = (e.target as Element).closest('[role="menu"]') ?? ref.current
    const list = Array.from(level?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
      .filter(b => b.closest('[role="menu"]') === level)
    if (!list.length) return
    const idx = list.findIndex((b) => b === e.currentTarget.ownerDocument.activeElement)
    let next: number | null = null
    if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % list.length
    else if (e.key === 'ArrowUp') next = idx < 0 ? list.length - 1 : (idx - 1 + list.length) % list.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    else if (e.key === 'Tab') { e.preventDefault(); close(); return }
    if (next !== null) { e.preventDefault(); list[next]!.focus() }
  }

  const style: CSSProperties = { left: pos.x, top: pos.y }
  return (
    <div ref={el => { ref.current = el; if (el) menuAnchors.set(el, anchorRef) }}
      className="ctxmenu" role="menu" tabIndex={-1} style={style}
      onKeyDown={onKeyDown}
      onPointerDown={stop} onPointerUp={stop} onPointerMove={stop}
      onMouseDown={stop} onMouseUp={stop} onClick={stop} onDoubleClick={stop}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}>
      <MenuEntries entries={state.entries} close={close} within={state.doc} />
    </div>
  )
}

function MenuEntries({ entries, close, within }: { entries: MenuEntry[]; close: () => void; within: Document }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  return <>{entries.map((entry, i) => entry === 'sep'
    ? <div key={'sep' + i} className="ctxmenu-sep" role="separator" />
    : <NestedMenuItem key={i} entry={entry} close={close} within={within} expanded={expanded === i}
        expand={() => setExpanded(i)} collapse={() => setExpanded(null)} />)}</>
}

function NestedMenuItem({ entry, close, expanded, expand, collapse, within }: {
  entry: MenuItem; close: () => void; expanded: boolean; expand: () => void; collapse: () => void
  within: Document
}) {
  const button = useRef<HTMLButtonElement>(null)
  const submenu = useRef<HTMLDivElement>(null)
  const keyboardOpen = useRef(false)
  useEsc(() => { collapse(); button.current?.focus() }, expanded && !!entry.children, within)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  useLayoutEffect(() => {
    if (!expanded || !entry.children || !button.current || !submenu.current) return
    const anchor = button.current.getBoundingClientRect()
    const box = submenu.current.getBoundingClientRect()
    const win = button.current.ownerDocument.defaultView!
    setPos({ x: Math.max(EDGE_GAP, anchor.right + box.width <= win.innerWidth - EDGE_GAP
      ? anchor.right : anchor.left - box.width),
      y: Math.max(EDGE_GAP, Math.min(anchor.top, win.innerHeight - box.height - EDGE_GAP)) })
    if (keyboardOpen.current) {
      submenu.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
      keyboardOpen.current = false
    }
  }, [expanded, entry.children])
  return <div className="ctxmenu-branch" onMouseEnter={expand} onMouseLeave={collapse}>
    <button ref={button} type="button" role="menuitem" tabIndex={-1}
      className={'ctxmenu-item' + (entry.danger ? ' danger' : '')}
      disabled={entry.disabled} aria-disabled={entry.actionDisabled || entry.disabled || undefined}
      aria-haspopup={entry.children ? 'menu' : undefined}
      aria-expanded={entry.children ? expanded : undefined} title={entry.title}
      onFocus={() => { if (!expanded) collapse() }}
      onKeyDown={e => {
        if (e.key === 'ArrowRight' && entry.children) {
          e.preventDefault(); e.stopPropagation(); keyboardOpen.current = true
          if (expanded) { submenu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus(); keyboardOpen.current = false }
          else expand()
        }
      }}
      onClick={e => { e.stopPropagation(); if (entry.actionDisabled) return; close(); entry.onSelect() }}>
      {entry.label}{entry.children && <span aria-hidden="true"> ▸</span>}
    </button>
    {expanded && entry.children && <div ref={submenu} className="ctxmenu ctxmenu-submenu" role="menu"
      aria-label={entry.label} style={{ left: pos.x, top: pos.y }}
      onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); collapse(); button.current?.focus()
      } }}>
      {entry.description && <div className="ctxmenu-description" role="note">{entry.description}</div>}
      <MenuEntries entries={entry.children} close={close} within={within} />
    </div>}
  </div>
}

/** write to the clipboard of the WINDOW the element lives in (a popped-out
 *  surface's rows belong to another document; the module-level `navigator`
 *  is the opener's — the house pattern of shared.ts's copyCodeFromEvent).
 *  Resolves true only when the write actually resolved: an absent, blocked
 *  or denied clipboard says nothing rather than reporting a copy that did
 *  not happen. */
export async function copyToClipboard(el: Element | null, text: string): Promise<boolean> {
  try {
    const clip = (el?.ownerDocument ?? document).defaultView?.navigator?.clipboard
    if (!clip?.writeText) return false
    await clip.writeText(text)
    return true
  } catch {
    return false
  }
}
