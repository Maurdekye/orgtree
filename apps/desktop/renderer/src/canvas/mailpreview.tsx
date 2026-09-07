import { useSurfaceDocument } from '../popout'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { RefWorld, ResolvedRef } from './reflinks'
import { RefMdBody } from './refmd'

/** Text fragments on the same visual row overlap vertically, including
 * inline links/code with different font sizes. Paragraph spacing is not a
 * line. Measure the unclipped body so expanding cannot change this answer. */
function fiveLineHeight(body: HTMLElement): { limit: number | null; lines: number } {
  const box = body.getBoundingClientRect()
  if (!box.width || !body.offsetWidth) return { limit: null, lines: 0 }
  const fragments: DOMRect[] = []
  const walk = body.ownerDocument.createTreeWalker(body, 4)
  const range = body.ownerDocument.createRange()
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (!node.textContent?.trim()) continue
    range.selectNodeContents(node)
    fragments.push(...Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0))
  }
  fragments.sort((a, b) => a.top - b.top || a.left - b.left)
  const rows: { top: number; bottom: number }[] = []
  for (const rect of fragments) {
    const last = rows[rows.length - 1]
    if (last && rect.top < last.bottom - 1 && rect.bottom > last.top + 1) {
      last.top = Math.min(last.top, rect.top)
      last.bottom = Math.max(last.bottom, rect.bottom)
    } else rows.push({ top: rect.top, bottom: rect.bottom })
  }
  if (rows.length <= 5) return { limit: null, lines: rows.length }
  // Range rects include the canvas/desk transform; CSS height does not.
  const scale = box.width / body.offsetWidth
  const fifth = rows[4]!, sixth = rows[5]!
  return { limit: (fifth.bottom + Math.max(0, sixth.top - fifth.bottom) / 2 - box.top) / scale, lines: rows.length }
}

/** Only received-mail transcript bodies use this preview. Headers and
 * attachments stay outside it; the existing markdown/link DOM stays mounted. */
export function ReceivedMailBody({ html, world, onOpen, children }: {
  html?: { __html: string }; children?: ReactNode; world?: RefWorld | null
  onOpen?: (r: ResolvedRef) => void
}) {
  const ownerDocument = useSurfaceDocument()
  const content = useRef<HTMLDivElement>(null)
  const id = useId()
  const [{ limit, lines }, setMeasure] = useState({ limit: null as number | null, lines: 0 })
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const body = content.current?.firstElementChild as HTMLElement | null
    if (!body) return
    const measure = () => setMeasure(fiveLineHeight(body))
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
