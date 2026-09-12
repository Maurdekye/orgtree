import { useSurfaceDocument } from '../popout'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RefWorld, ResolvedRef } from './reflinks'
import { RefMdBody } from './refmd'
import { foldAt, NO_FOLD } from './foldlines'

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
  useLayoutEffect(() => {
    const body = content.current?.firstElementChild as HTMLElement | null
    if (!body) return
    const measure = () => setMeasure(foldAt(body, MAIL_FOLD_LINES))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(body)
    const ownerWindow = ownerDocument.defaultView
    ownerWindow?.addEventListener('resize', measure)
    return () => { observer?.disconnect(); ownerWindow?.removeEventListener('resize', measure) }
  }, [html?.__html, children, ownerDocument])
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
