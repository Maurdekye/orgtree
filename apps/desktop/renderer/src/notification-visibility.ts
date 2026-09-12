import { useCallback, useRef } from 'react'

// Popouts adopt the same React nodes. Their ownerDocument changes, so a live
// element registry sees both main-window and popout cards without IPC copies.
const cards = new Set<HTMLElement>()
export function useQuestionVisibility(org: string, id: string) {
  const previous = useRef<HTMLElement | null>(null)
  return useCallback((element: HTMLDivElement | null) => {
    if (previous.current) cards.delete(previous.current)
    previous.current = element
    if (element) {
      element.dataset.questionOrg = org
      element.dataset.questionId = id
      cards.add(element)
    }
  }, [org, id])
}

export function questionVisible(org: string, id: string): boolean {
  return [...cards].some(element => {
    if (!element.isConnected || element.dataset.questionOrg !== org || element.dataset.questionId !== id) return false
    const doc = element.ownerDocument, view = doc.defaultView
    if (!view || doc.visibilityState !== 'visible' || !element.getClientRects().length) return false
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
