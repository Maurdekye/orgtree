import { useSurfaceDocument } from '../popout'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RefWorld, ResolvedRef } from './reflinks'
import { RefMdBody } from './refmd'
import { foldAt, NO_FOLD, sameFold } from './foldlines'

/** Received mail folds at five rendered lines. The measurement itself is
 * shared with the docket description's ten-line fold (`foldlines.ts`) — one
 * definition of "a line", because two would disagree. */
const MAIL_FOLD_LINES = 5

/** Only received-mail transcript bodies use this preview. Headers and
 * attachments stay outside it; the existing markdown/link DOM stays mounted. */
export function ReceivedMailBody({ html, world, onOpen, children }: {
  html?: { __html: string }; children?: ReactNode; world?: RefWorld | null
  onOpen?: (r: ResolvedRef) => void
}) {
  const ownerDocument = useSurfaceDocument()
  const content = useRef<HTMLDivElement>(null)
  const id = useId()
  const [{ limit, lines }, setMeasure] = useState(NO_FOLD)
  const [expanded, setExpanded] = useState(false)
  // ⚠ THE MEASUREMENT IS DRIVEN BY CHANGES TO THE BODY, NEVER BY RE-RENDERS.
  //
  // USER BUG 2026-09-12 ("typed text appears several seconds late; the Desk
  // froze 20-30 s between visible updates while the spinners kept spinning").
  // `children` used to be a dependency of this effect, and `children` is a
  // freshly built React element on every render of the parent — so the effect
  // tore down and re-ran on EVERY render, whether or not this body had
  // changed. `foldAt` is not a cheap thing to re-run: it walks every text node
  // and asks layout for its rects. On one 2.8 MB forwarded mail body that is
  // 45k DOM nodes and 55,440 rect queries, ~315 ms of blocked main thread —
  // per keystroke, because the composer's text state lives in the same
  // component that maps the transcript rows. Eight such rows measured 486 ms a
  // character with 112k rect queries (`desklag_probe.py`). Compositor-driven
  // CSS animations were untouched throughout, which is exactly how the freeze
  // looked from outside.
  //
  // A re-render was only ever a PROXY for "the body may have changed". The two
  // observers below are the real signal: ResizeObserver for a change that
  // moves the body's box, MutationObserver for one that does not (the same
  // text re-flowed into different markup). Both cost nothing while idle.
  //
  // NEITHER CAN FEED ITSELF. The fold applies `maxHeight` to the WRAPPER, and
  // this reads the body inside it — the same invariant that already let the
  // ResizeObserver observe the thing its own callback resizes nothing of.
  useLayoutEffect(() => {
    const body = content.current?.firstElementChild as HTMLElement | null
    if (!body) return
    const measure = () => setMeasure(prev => {
      const next = foldAt(body, MAIL_FOLD_LINES)
      // an unchanged answer must not be a state change: `foldAt` returns a new
      // object every call, so assigning it blindly re-rendered the row for
      // nothing every time anything asked for a measurement
      return sameFold(prev, next) ? prev : next
    })
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(body)
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure)
    mutations?.observe(body, { childList: true, subtree: true, characterData: true })
    const ownerWindow = ownerDocument.defaultView
    ownerWindow?.addEventListener('resize', measure)
    return () => {
      observer?.disconnect(); mutations?.disconnect()
      ownerWindow?.removeEventListener('resize', measure)
    }
  }, [html?.__html, ownerDocument])
  const long = limit !== null
  const folded = long && !expanded
  const toggle = () => setExpanded(value => !value)
  return <div className={'turn-mail-preview' + (long ? ' expandable' : '') + (folded ? ' folded' : '')}
    onClick={e => {
      if (!long || e.defaultPrevented || !ownerDocument.defaultView?.getSelection()?.isCollapsed) return
      if ((e.target as Element).closest('a,button,input,textarea,select,summary,[role="button"],[contenteditable],img,video,audio')) return
      toggle()
    }}>
    <div id={id} ref={content} className="turn-mail-preview-content"
      style={folded ? { maxHeight: limit } : undefined}
      onFocusCapture={e => {
        // Keyboard focus may reach a link below the clipped preview. Reveal
        // that link, while clicks/focus on already-visible links do not fold.
        if (folded && (e.currentTarget.scrollTop > 0
          || e.target.getBoundingClientRect().bottom > e.currentTarget.getBoundingClientRect().bottom + 1)) setExpanded(true)
      }}>
      {children ?? (html && <RefMdBody className="turn-mail-body md" html={html} world={world} onOpen={onOpen} />)}
    </div>
    {long && <button type="button" className="turn-mail-toggle"
      aria-expanded={expanded} aria-controls={id}
      aria-label={expanded ? 'Collapse received mail' : 'Expand received mail'}
      onClick={e => { e.stopPropagation(); toggle() }}>
      {expanded ? 'click to collapse' : "click to expand · " + lines + ' lines'}
    </button>}
  </div>
}
