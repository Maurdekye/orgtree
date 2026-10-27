import { useCallback, useRef } from 'react'

// Popouts adopt the same React nodes. Their ownerDocument changes, so a live
// element registry sees both main-window and popout cards without IPC copies.
const cards = new Set<HTMLElement>()
export function useQuestionVisibility(org: string, id: string) {
  const previous = useRef<HTMLElement | null>(null)
  return useCallback((element: HTMLElement | null) => {
    if (previous.current) cards.delete(previous.current)
    previous.current = element
    if (element) {
      element.dataset.questionOrg = org
      element.dataset.questionId = id
      cards.add(element)
    }
  }, [org, id])
}

/** TOAST UNLESS FOCUSED (user ruling 2026-09-12). A question card only counts
 *  as having reached the user when it is on screen in the Orgtree window they
 *  are ACTUALLY IN. Merely being visible is not enough: a window left open on
 *  a second monitor, or sitting behind the editor they are working in, shows
 *  the card to nobody, and treating that as delivered silences the alert for
 *  good. `hasFocus()` is per-document, so an adopted popout answers for
 *  itself; an environment that cannot answer at all is read as not focused,
 *  which errs toward notifying. */
export function questionVisible(org: string, id: string): boolean {
  return [...cards].some(element => {
    if (!element.isConnected || element.dataset.questionOrg !== org || element.dataset.questionId !== id) return false
    const doc = element.ownerDocument, view = doc.defaultView
    if (!view || doc.visibilityState !== 'visible' || !element.getClientRects().length) return false
    if (typeof doc.hasFocus !== 'function' || !doc.hasFocus()) return false
    const rect = element.getBoundingClientRect()
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top)
    let right = Math.min(view.innerWidth, rect.right), bottom = Math.min(view.innerHeight, rect.bottom)
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      if (parent !== element) {
        const clip = parent.getBoundingClientRect()
        if (/(hidden|clip|auto|scroll)/.test(style.overflowX || style.overflow)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
        if (/(hidden|clip|auto|scroll)/.test(style.overflowY || style.overflow)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
      }
    }
    return right > left && bottom > top
  })
}

/** Scroll a question's card into view and give it the focus: the asker's open
 *  desk a question's desktop notification brought forward (USER 2026-10-27
 *  m007c48d12f28). The inbox and the Attention queue draw the same card, so
 *  the one inside `within` (the slot holding the desk) comes first, then one on
 *  any desk, a popped-out desk's included. */
export function focusQuestionCard(org: string, id: string, within?: Element | null): boolean {
  const live = [...cards].filter(element => element.isConnected
    && element.dataset.questionOrg === org && element.dataset.questionId === id)
  const card = (within ? live.find(element => within.contains(element)) : undefined)
    ?? live.find(element => element.closest('.desk-control-scope'))
  if (!card) return false
  card.scrollIntoView?.({ block: 'nearest' })
  card.focus({ preventScroll: true })
  return true
}
