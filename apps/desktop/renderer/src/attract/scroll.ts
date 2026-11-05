/* attract/scroll.ts — "focusing unread and edited presentations and scrolling
   through them" (USER m79cb0cf57f61), with the dwell "longer for presentations
   while scrolling" (mc8e118c58de9).

   The reader that opened is found by the document it shows: its scrolling
   pane, `.mailer-read`, carries `data-reading` (canvas/gallery.tsx). The scroll
   runs top to bottom at a steady pace after a short pause, then pauses again
   at the end. Its length is what `show` reports as the least dwell. Setting
   scrollTop is no user input (attract.ts listens for none of it), so the run
   keeps going. */

/** reading pace, in px per second */
export const SCROLL_PX_PER_S = 40
/** the pause before the scroll starts, and again at its end */
export const SCROLL_PAUSE_MS = 1_500
/** the longest a single presentation holds the screen */
export const SCROLL_MAX_MS = 90_000
/** A docket visit is short (USER 2026-11-05 m207f9caba2e3 "attract mode spends too much time scrolling through evidence on the
 *  docket"): the ticket pane shows its header, glides to the change in at most this long (it no longer reads down to it at
 *  SCROLL_PX_PER_S), and holds; the whole visit never outlasts the longest dwell. */
export const TICKET_GLIDE_MS = 2_000
export const TICKET_MAX_MS = 15_000
/** how long to wait for the reader to load the document */
const FIND_MS = 4_000

export const scrollMs = (distance: number): number =>
  Math.min(SCROLL_MAX_MS, 2 * SCROLL_PAUSE_MS + Math.max(0, distance) / SCROLL_PX_PER_S * 1000)

export function readerPane(doc: string, root: ParentNode = document): HTMLElement | null {
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(doc) : doc.replace(/["\\]/g, '\\$&')
  return root.querySelector<HTMLElement>(`.mailer-read[data-reading="${esc}"]`)
}

export interface Scroll {
  /** resolves to the scroll's whole length in ms (0 when there is none) */
  length: Promise<number>
  cancel: () => void
}

/** Scroll the reader showing `doc` through to its end. */
export function scrollThrough(doc: string): Scroll {
  let alive = true
  let frame = 0
  let wait: ReturnType<typeof setTimeout> | undefined
  let settle: (ms: number) => void = () => {}
  // a cancel before the reader loaded still settles the length, or the
  // cycle's `show` would wait on it forever
  const cancel = () => { alive = false; if (frame) cancelAnimationFrame(frame); clearTimeout(wait); settle(0) }
  const length = new Promise<number>((done) => {
    let settled = false
    const resolve = settle = (ms: number) => { if (!settled) { settled = true; done(ms) } }
    const started = Date.now()
    const find = () => {
      if (!alive) { resolve(0); return }
      const pane = readerPane(doc)
      // the pane exists before the body loads; wait for something to scroll
      const distance = pane ? pane.scrollHeight - pane.clientHeight : 0
      if (!pane || (distance <= 0 && Date.now() - started < FIND_MS)) {
        if (Date.now() - started >= FIND_MS) { resolve(0); return }
        wait = setTimeout(find, 200); return
      }
      if (distance <= 0) { resolve(0); return }
      const total = scrollMs(distance)
      resolve(total)
      pane.scrollTop = 0
      const run = Math.max(0, total - 2 * SCROLL_PAUSE_MS)
      const from = pane.scrollTop
      wait = setTimeout(() => {
        const t0 = performance.now()
        const tick = (now: number) => {
          if (!alive) return
          const k = run > 0 ? Math.min(1, (now - t0) / run) : 1
          pane.scrollTop = from + (distance - from) * k
          if (k < 1) frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
      }, SCROLL_PAUSE_MS)
    }
    find()
  })
  return { length, cancel }
}
