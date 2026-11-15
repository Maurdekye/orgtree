/** Center a transcript target without letting scrollIntoView scroll the desk's
 * overflow:hidden ancestors. Rects are screen pixels; scrollTop is unscaled
 * layout pixels, including in counter-scaled desks and adopted pop-outs. */
export function centerTranscriptTarget(list: HTMLElement | null, target: Element | null): boolean {
  if (!list || !target || !list.contains(target) || list.clientHeight <= 0) return false
  const box = list.getBoundingClientRect()
  const row = target.getBoundingClientRect()
  const scale = list.offsetHeight > 0 && box.height > 0 ? box.height / list.offsetHeight : 1
  const top = list.scrollTop + (row.top - box.top) / scale - list.clientTop
    - (list.clientHeight - row.height / scale) / 2
  if (!Number.isFinite(top)) return false
  list.scrollTop = Math.max(0, Math.min(Math.max(0, list.scrollHeight - list.clientHeight), top))
  return true
}

// canvas/deskscroll.ts — WHERE EACH PLACE'S DESK WAS SCROLLED, kept while the place is off screen.
//
// A place off screen mounts no desk (4.6.1, deskhosts.tsx `DeskView`): the canvas card behind the presented
// Attention view unmounts its desk and mounts it again on the way back. Without this the reader would come back to a
// desk reset to the bottom (@coordinator-opus m4c0bc69a8b6b: "a visible regression"). So a desk records its scroll
// as it unmounts, keyed by its place and its agent's identity, and the next desk in that place restores it: a reader
// who was at the bottom stays pinned there, one who was reading history comes back to the same place. The open tab
// is already remembered per agent (desktabs.ts `useDeskMemory`). In memory only: a restart starts at the bottom.

export interface PlaceScroll {
  /** following the live end (pinned to the bottom) */
  stuck: boolean
  /** scrollTop when not stuck */
  top: number
}

const scrolls = new Map<string, PlaceScroll>()

/** `place` names where the desk is shown (card, pin, attention, window, floating, place) */
export const placeScrollKey = (place: string, slug: string, id: string, generation: number | undefined) =>
  JSON.stringify([place, slug, id, generation ?? 0])
export const recallPlaceScroll = (key: string): PlaceScroll | undefined => scrolls.get(key)
export const rememberPlaceScroll = (key: string, scroll: PlaceScroll): void => { scrolls.set(key, scroll) }
/** test seam */
export const resetPlaceScrolls = (): void => scrolls.clear()
