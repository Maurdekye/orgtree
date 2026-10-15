/* EPIC Mode — where on screen something is.

   Effects land on the thing they are about: an agent's card on the canvas,
   else its open desk (in this window, a pinned frame or a popped-out window),
   the user's eye, the org inbox tile or a watchdog's chip. Everything is found
   by SCANNING data attributes the app already renders and comparing values,
   never by building a selector from an id (an agent's name is data, and `CSS`
   is not even defined under jsdom — see attention/dom.ts). Nothing is found
   for an element that is not actually visible: off-screen cards are not
   mounted, piled ones render nothing, and the Attention view hides the whole
   canvas, so in all of those cases the caller gets null and plays the effect
   somewhere sensible instead. */
import type { Rect } from './stage'
import { isInboxEnd, isUserEnd } from './diff'

export interface Spot {
  x: number
  y: number
  rect: Rect | null
  /** the element found, for a glow of its own; null at a fallback spot */
  el: Element | null
  doc: Document
}

function visibleRect(el: Element): Rect | null {
  const view = el.ownerDocument.defaultView
  if (!view) return null
  if (el.closest('.canvas-world-hidden, [hidden]')) return null
  const r = el.getBoundingClientRect()
  if (!(r.width > 0 && r.height > 0)) return null
  if (r.right < 0 || r.bottom < 0 || r.left > view.innerWidth || r.top > view.innerHeight) return null
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

function spotOf(el: Element | null): Spot | null {
  if (!el) return null
  const rect = visibleRect(el)
  if (!rect) return null
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, rect, el, doc: el.ownerDocument }
}

function scan(root: ParentNode, selector: string, attr: string, value: string): Element | null {
  for (const el of root.querySelectorAll(selector)) {
    if (el.getAttribute(attr) === value && visibleRect(el)) return el
  }
  return null
}

/** this org's canvas viewport in a document, or the document itself */
function orgRoot(doc: Document, org: string | null): ParentNode {
  if (org) {
    for (const v of doc.querySelectorAll('[data-pin-org]')) {
      if (v.getAttribute('data-pin-org') === org) return v
    }
  }
  return doc
}

/** Find one endpoint — an agent name, `@user`, `org_inbox` or `dog:<id>` —
 *  in any of the given documents (the main window first, then popouts). */
export function locate(docs: readonly Document[], org: string | null, who: string | undefined): Spot | null {
  if (who === undefined) return null
  for (const doc of docs) {
    const root = orgRoot(doc, org)
    let el: Element | null = null
    if (isUserEnd(who)) {
      el = [...root.querySelectorAll('.sq.user')].find(e => !!visibleRect(e)) ?? null
    } else if (isInboxEnd(who)) {
      el = [...root.querySelectorAll('.sq.orginbox')].find(e => !!visibleRect(e)) ?? null
    } else if (who.startsWith('dog:')) {
      el = scan(root, '[data-object-nav="watchdog"]', 'data-object-id', who.slice(4))
    } else {
      el = scan(root, '[data-first-use-agent]', 'data-first-use-agent', who)
        ?? scan(doc, '[data-first-use-chat]', 'data-first-use-chat', who)
        ?? scan(doc, '.pinwin[data-id]', 'data-id', who)
    }
    const spot = spotOf(el)
    if (spot) return spot
  }
  return null
}

/** A rectangle for any element — controls, toasts, dialogs. */
export function spotOfElement(el: Element | null): Spot | null { return spotOf(el) }
