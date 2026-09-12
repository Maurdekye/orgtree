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
//     the node portals into the surface document's BODY, and every listener
//     is bound to the menu element's own document/window, never the module
//     globals. The body and not the surface's overlay container on purpose:
//     a desk on the canvas lives under two transforms (`.space`'s camera and
//     `.desk-inner`'s counter-scale), and `position: fixed` inside a
//     transformed ancestor is positioned in THAT box, in authored px — a menu
//     for a row in the desk's inbox tab would land scaled and elsewhere. A
//     document's body is never transformed, and `useSurfaceDocument()` is the
//     popped-out window's document when the surface is detached.
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
  x: number
  y: number
  entries: MenuEntry[]
  /** where focus was when the menu opened — restored on close */
  restore: Element | null
  /** raised without a usable pointer (keyboard): focus lands on the first
   *  item so the arrow keys have somewhere to start from */
  keyboard: boolean
}

export interface ContextMenuHandle {
  /** the object's `onContextMenu`. `entries` may be a thunk so a list that
   *  renders many rows builds only the pressed row's items. */
  open: (e: ReactMouseEvent, entries: MenuEntry[] | (() => MenuEntry[]), anchor?: Element) => void
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
  const overlayRoot = useSurfaceDocument().body
  const anchorRef = useRef<Element | null>(null)
  const close = useCallback(() => setState(null), [])
  const reanchor = useCallback((el: Element | null) => { if (el) anchorRef.current = el }, [])
  const open = useCallback((e: ReactMouseEvent, entries: MenuEntry[] | (() => MenuEntry[]), anchor?: Element) => {
    if (e.defaultPrevented) return           // an inner object already took it
    const el = anchor ?? e.currentTarget as HTMLElement
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
      x: inside ? e.clientX : r.left,
      y: inside ? e.clientY : r.bottom,
      entries: list,
      restore: el.ownerDocument.activeElement,
      keyboard: !inside,
    })
  }, [feedback])
  const node = state
    ? createPortal(<ContextMenu state={state} anchorRef={anchorRef} close={close} />, overlayRoot)
    : null
  return { open, close, reanchor, isOpen: state !== null, node }
}

const stop = (e: SyntheticEvent) => e.stopPropagation()

function ContextMenu({ state, anchorRef, close }:
{ state: MenuState; anchorRef: { current: Element | null }; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // the anchor is read through the ref its OWNER holds, so the listener effect
  // below stays keyed on `close` alone (re-registering four document listeners
  // on every anchor change would be a second behaviour, not a fix) — and so
  // that `reanchor` can move it without re-rendering this component at all
  // Escape joins the owning document's stack (shared.ts): pushed last, so it
  // is the top entry and the surface beneath keeps its own Escape for later
  useEsc(close, true)
  const [pos, setPos] = useState({ x: state.x, y: state.y })

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
    const first = el.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    if (state.keyboard && first) first.focus()
    else el.focus({ preventScroll: true })
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

  const items = () => Array.from(
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation()   // the host's own key handling (mail alt+↑/↓, card) stays out
    const list = items()
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
      {state.entries.map((entry, i) => entry === 'sep'
        ? <div key={'sep' + i} className="ctxmenu-sep" role="separator" />
        : <button key={i} type="button" role="menuitem" tabIndex={-1}
            className={'ctxmenu-item' + (entry.danger ? ' danger' : '')}
            disabled={entry.disabled} title={entry.title}
            onClick={(e) => {
              e.stopPropagation()
              // close FIRST: the action may open a dialog that takes focus,
              // and the restore-focus effect must see that, not the menu
              close()
              entry.onSelect()
            }}>
            {entry.label}
          </button>)}
    </div>
  )
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
