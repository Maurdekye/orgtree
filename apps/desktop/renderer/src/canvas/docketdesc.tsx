// canvas/docketdesc.tsx — A TICKET'S DESCRIPTION, WHOLE (user requirement
// 2026-09-12).
//
// The description is the item's authoritative standalone specification: the
// first paragraph states the problem and the short solution, and everything
// after it carries the rest of the spec. Two consequences follow, and this
// file is both of them:
//
//  1. IT IS MARKDOWN, in full. A spec written as headings, lists, tables and
//     code fences was previously drawn as one pre-wrapped block of plain
//     text, so the structure the author wrote was on screen only as
//     punctuation. It goes through the app's ONE markdown pipeline (`md()` —
//     marked + DOMPurify) like every other authored body, not a second one.
//  2. IT IS FOLDED, NEVER CUT. Nothing truncates a description anywhere in
//     the product, so a long one has to be readable in a pane that is not
//     tall. Past ten RENDERED lines it is clipped to ten with an expand
//     control; at ten or fewer there is no control at all, because chrome on
//     a three-line description is noise. The whole text is in the DOM either
//     way — the fold is `maxHeight`, so find-in-page, screen readers and
//     "copy contents" all still see the entire description.
//
// ⚠ BARE ITEM NAMES STAY CLICKABLE. Rendering as markdown moves the prose out
// of React and into sanitized HTML, where `RefProse`'s React chips cannot
// reach. `RefMdBody`'s `mentions` option does the same job on the DOM the
// sanitizer produced, so `some-other-ticket` written in a description is the
// control it always was.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSurfaceDocument } from '../popout'
import { md } from './shared'
import { RefMdBody } from './refmd'
import { foldAt, NO_FOLD } from './foldlines'
import type { RefWorld, ResolvedRef } from './reflinks'
import type { MentionIndex } from './workrefs'

/** THE DEFAULT COLLAPSE POINT, in rendered lines (user requirement
 *  2026-09-12: "collapse long descriptions after 10 rendered lines by
 *  default"). Rendered, not authored: a paragraph that wraps four times is
 *  four of these, and a blank line between paragraphs is none of them. */
export const DESC_FOLD_LINES = 10

export function DocketDescription({ text, slug, world, onOpen, index, onPick }: {
  text: string
  /** the item this description belongs to. Only used to decide when a fold
   *  reopens: switching items starts collapsed again, while an update to the
   *  item you are already reading leaves your expansion alone. */
  slug?: string
  world: RefWorld
  onOpen?: (r: ResolvedRef) => void
  index?: MentionIndex
  onPick?: (name: string) => void
}) {
  const ownerDocument = useSurfaceDocument()
  const content = useRef<HTMLDivElement>(null)
  const id = useId()
  const [{ limit, lines }, setMeasure] = useState(NO_FOLD)
  const [expanded, setExpanded] = useState(false)
  const html = useMemo(() => md(text), [text])
  const mentions = useMemo(
    () => (index && index.size ? { index, onPick } : null), [index, onPick])
  useEffect(() => { setExpanded(false) }, [slug])
  useLayoutEffect(() => {
    const body = content.current?.firstElementChild as HTMLElement | null
    if (!body) return
    // ⚠ MEASURED FROM THE RENDERED BODY, NOT THE SOURCE. Counting `\n` in the
    // markdown would answer a different question — a wrapped line is a line
    // to the reader, and one written line can be several of them.
    const measure = () => setMeasure(foldAt(body, DESC_FOLD_LINES))
    measure()
    // the docket pane is resizable and lives on a zoomable canvas, so the
    // answer changes without the text changing
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(body)
    const ownerWindow = ownerDocument.defaultView
    ownerWindow?.addEventListener('resize', measure)
    return () => { observer?.disconnect(); ownerWindow?.removeEventListener('resize', measure) }
  }, [html.__html, ownerDocument])
  const long = limit !== null
  const folded = long && !expanded
  return (
    <div className={'docket-desc-fold' + (folded ? ' folded' : '')}>
      <div id={id} ref={content} className="docket-desc-clip"
        style={folded ? { maxHeight: limit } : undefined}
        onFocusCapture={(e) => {
          // Keyboard focus can reach a reference chip below the clip. Reveal
          // it rather than letting the caret land somewhere invisible; focus
          // on an already-visible chip changes nothing.
          if (folded && (e.currentTarget.scrollTop > 0
            || e.target.getBoundingClientRect().bottom
              > e.currentTarget.getBoundingClientRect().bottom + 1)) setExpanded(true)
        }}>
        <RefMdBody className="docket-desc-body md" html={html}
          world={world} onOpen={onOpen} mentions={mentions} />
      </div>
      {long && (
        <button type="button" className="docket-desc-toggle"
          aria-expanded={expanded} aria-controls={id}
          aria-label={expanded
            ? 'Collapse the description to ten lines'
            : `Expand the description — ${lines} lines in full`}
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v) }}>
          {expanded ? 'show less' : `show all ${lines} lines`}
        </button>
      )}
    </div>
  )
}
