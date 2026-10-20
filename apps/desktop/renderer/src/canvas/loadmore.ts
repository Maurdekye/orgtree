// canvas/loadmore.ts — a history table's "older" row loading the next page
// as it comes into view (Orgtree 4.4.0; docket
// `project-desk-mail-event-listeners-and-slots-tabs`, user 2026-10-20
// 06:22Z: Recently Finished, Delivered and Fired load lazily as you scroll,
// like the Slots tab's Recently Held). Whichever ancestor scrolls — the
// table's own region, the Mail tab's pane, a pinned window — the row's
// coming into view is what counts; the tables' scroll handlers stay for hosts
// without IntersectionObserver (and for the tests).

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** Call `onSeen` when `ref`'s element comes into view while `key` names a
 *  page still to load (a new key re-arms it, so a short page that leaves the
 *  row in view loads the next at once). */
export function useLoadWhenSeen(ref: RefObject<Element | null>, key: string | null | undefined, onSeen: () => void) {
  const latest = useRef(onSeen)
  latest.current = onSeen
  useEffect(() => {
    const el = ref.current
    if (!key || !el || typeof IntersectionObserver === 'undefined') return
    const watch = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) latest.current() })
    watch.observe(el)
    return () => watch.disconnect()
  }, [ref, key])
}
