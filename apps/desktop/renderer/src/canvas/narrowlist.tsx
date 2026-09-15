// THE TWO-PANE `.mailer` LAYOUT WHEN THERE IS NO ROOM FOR TWO PANES.
//
// Mail and presentations both draw a persistent left list beside a reading
// pane. That reads well in a wide modal and falls apart in a narrow one: the
// list squeezes to its 140px floor and the pane beside it keeps whatever is
// left, which at a 320px-wide pinned window is neither a list nor a document.
//
// Below a threshold measured on the MODAL'S OWN BOX — not the viewport, since
// these surfaces pin, resize and pop out into their own windows — the list
// stops being a column and becomes an overlay panel opened from a control, the
// same move the canvas makes with its top-left org drawer.
//
// ⚠ THE LIST IS NEVER UNMOUNTED. Collapsing swaps the wrapper between
// `display: contents` (invisible to layout — the list stays the flex item it
// always was, and every existing `.mailer-list` rule still lands on it) and an
// absolutely positioned panel. Nothing about the list's React tree changes, so
// its scroll position, its selection, its filter text and how far it has paged
// all survive the round trip — which is the whole point, because a list that
// forgot where you were is worse than a cramped one.
import {
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
  useCallback, useEffect, useId, useRef, useState,
} from 'react'
import { MenuIcon } from '../icons'
import { useEsc } from './shared'

/** The usable `.mailer` width, in CSS px, at or below which the left list
 *  stops being a persistent column. Above it nothing changes at all.
 *
 *  Chosen against the layout it governs rather than a device: `.mailer-list`
 *  takes 36% (floor 140px), so this is the width at which the reading pane
 *  drops to roughly 350px — the point where a mail body or a presentation
 *  stops laying out as prose and starts wrapping every few words. */
export const NARROW_MAILER_WIDTH = 560

/** Watches one element's own width. Returns null until it has been measured,
 *  so nothing flashes the wrong layout on the first paint. */
function useNarrow(threshold: number, enabled: boolean) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!enabled || !el || typeof ResizeObserver === 'undefined') { setNarrow(false); return }
    const measure = () => {
      const w = el.getBoundingClientRect().width
      // a zero box is an unrendered one (a hidden tab, a closing window), not
      // a narrow one — collapsing there would only be undone on the next paint
      setNarrow(w > 0 && w <= threshold)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, threshold, enabled])
  return { setEl, narrow }
}

export interface CollapsibleMailerProps {
  /** opt IN. The same list/reader components render on agent desks, which are
   *  not modals and keep their own layout; only the modal call sites collapse. */
  collapsible?: boolean
  /** what the panel and its control are called, for the a11y tree and the
   *  control's tooltip — e.g. "message list", "document list" */
  listLabel: string
  /** the `.mailer-list` element, exactly as the call site already built it */
  list: ReactNode
  /** the `.mailer-read` pane */
  children: ReactNode
  /** extra classes for the `.mailer` root */
  className?: string
  tabIndex?: number
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void
  /** the call site's own ref on the `.mailer` root, kept working */
  rootRef?: RefObject<HTMLDivElement | null>
  threshold?: number
}

export function CollapsibleMailer({
  collapsible = false, listLabel, list, children, className = '', tabIndex,
  onKeyDown, rootRef, threshold = NARROW_MAILER_WIDTH,
}: CollapsibleMailerProps) {
  const { setEl, narrow } = useNarrow(threshold, collapsible)
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    setEl(el)
    if (rootRef) rootRef.current = el
  }, [setEl, rootRef])

  // widening puts the list back in the layout, so an overlay left open from
  // the narrow state has nothing to describe any more
  useEffect(() => { if (!narrow) setOpen(false) }, [narrow])

  // MOUNTED BUT NOT REACHABLE. The hidden list keeps its DOM (that is what
  // preserves its scroll and its paging), so without this it would still be in
  // the tab order and still be read out — a screen reader would walk a list
  // nobody can see. `inert` is set imperatively because React 18 has no
  // boolean prop for it.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    if (narrow && !open) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [narrow, open])

  // opening moves focus into the panel; closing hands it back to the control
  // that opened it, so a keyboard never lands on nothing
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) wrapRef.current?.focus()
    else if (!open && wasOpen.current && narrow) toggleRef.current?.focus()
    wasOpen.current = open
  }, [open, narrow])

  // Escape closes the overlay and NOT the modal behind it. `useEsc` keeps a
  // stack and only its top entry fires, and this one is pushed after the
  // frame's — so one press closes the panel, the next closes the modal.
  useEsc(useCallback(() => setOpen(false), []), narrow && open)

  const label = (open ? 'Hide the ' : 'Show the ') + listLabel

  return (
    <div className={'mailer' + (className ? ' ' + className : '')
      + (narrow ? ' narrow-list' : '') + (narrow && open ? ' narrow-list-open' : '')}
      tabIndex={tabIndex} onKeyDown={onKeyDown} ref={setRoot}>
      {narrow && (
        <div className="mailer-listrail">
          <button type="button" ref={toggleRef}
            className={'iconbtn mailer-listtoggle' + (open ? ' on' : '')}
            aria-expanded={open} aria-controls={panelId}
            aria-label={label} title={label}
            onClick={() => setOpen((o) => !o)}>
            <MenuIcon fontSize="inherit" />
          </button>
        </div>
      )}
      {/* the veil is the drawer's, scoped to this modal rather than the screen:
          a click anywhere off the panel closes it, which is how the canvas
          drawer has always behaved */}
      {narrow && open && (
        <div className="mailer-listveil" aria-hidden="true" onClick={() => setOpen(false)} />
      )}
      {/* PICKING A ROW CLOSES THE PANEL, the way picking an org closes the
          canvas drawer. On a narrow modal the overlay is sitting on top of the
          reading pane, so leaving it open would hide the very thing the click
          just asked to see. Only a ROW does it — the filter box, the scroller
          and the paging controls are things you use with the list still up. */}
      <div ref={wrapRef} id={panelId} className="mailer-listwrap"
        onClick={narrow && open
          ? (e) => { if ((e.target as Element).closest?.('.mailrow')) setOpen(false) }
          : undefined}
        role={narrow ? 'dialog' : undefined}
        aria-label={narrow ? listLabel : undefined}
        tabIndex={narrow ? -1 : undefined}>
        {list}
      </div>
      {children}
    </div>
  )
}
