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
