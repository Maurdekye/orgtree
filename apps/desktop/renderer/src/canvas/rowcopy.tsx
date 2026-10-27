// canvas/rowcopy.tsx — DOUBLE-CLICK A ROW, COPY ITS MENTION. One helper for the
// docket rows (org Docket view, desk Docket tabs, attention queue: DocketRow)
// and the Presented rows (the org-wide list and the desk tab: GalleryEntry).
//
// WHAT IS COPIED is the object's mention token, exactly as agents write it
// (`@item:org/slug`, `@doc:org/id`). The docket row copied the bare slug from
// user 2026-09-07 15:41Z until USER 2026-10-27 ("also double clicking a docket
// item should copy its mention"; presentations: "double clicking a presentation
// in the list should also copy its mention"). The row menus keep "Copy slug".
//
// `Copied!` appears only after the write RESOLVES: a clipboard that is absent,
// blocked or denied says nothing rather than lying about what is on it.
//
// The position is stored as FRACTIONS of the row's box, not as pixels. These
// rows render in more than one place — the app's own overlay, a portal, and a
// popped-out window — and inside the canvas a CSS `transform: scale()` applies,
// under which `getBoundingClientRect()` is scaled while an absolutely
// positioned child is laid out unscaled. A ratio cancels the scale, so the
// bubble lands under the pointer in all of them. (The row needs
// `position: relative`: `.docket-row` and `.doc-gallery-row` in styles.css.)
//
// ⚠ TWO SEPARATE THINGS MAKE A REPEAT AT THE SAME PIXEL WORK, and they are
// easy to confuse (root review 2026-09-07 16:32Z; the first cut stored a bare
// number and had neither):
//   * the state is an OBJECT, so a second success is never `Object.is` the
//     first even at identical coordinates. React therefore does not bail out,
//     the effect below re-runs, and the timer restarts — without this the first
//     copy's timer would still fire and clear the second message.
//   * `id` differs every time and the element is KEYED on it, so React
//     remounts the span and the CSS animation replays from the start. Without
//     it the bubble would sit there mid-animation, already faded.
// Measured: a mutant that freezes `id` keeps the timer restart and loses only
// the replay, which is why the docket suite checks the animation's own clock.
import { useEffect, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { copyToClipboard } from './contextmenu'

/** One number per successful copy, anywhere in the app. It only has to DIFFER
 *  from the previous value of the same row, so a module counter is enough. */
let copyTicket = 0

export interface RowCopy {
  /** write `text` to the clipboard of the row's OWN window and, once the write
   *  resolved, show the bubble where the pointer was */
  copyAt(row: HTMLElement, clientX: number, clientY: number, text: string): void
  /** the row's `onDoubleClick`: copies `text` unless an embedded control owns
   *  the gesture, and clears the selection the gesture itself caused */
  onDoubleClick(e: ReactMouseEvent<HTMLElement>, text: string): void
  /** render once inside the row; null while there is nothing to say */
  bubble: ReactNode
}

export function useRowCopy(): RowCopy {
  const [copied, setCopied] = useState<{ id: number; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 900)
    return () => clearTimeout(t)
  }, [copied])
  const copyAt = (row: HTMLElement, clientX: number, clientY: number, text: string) => {
    const rect = row.getBoundingClientRect()
    const ratio = (value: number, size: number) =>
      size ? Math.min(1, Math.max(0, value / size)) : 0.5
    const x = ratio(clientX - rect.left, rect.width)
    const y = ratio(clientY - rect.top, rect.height)
    // the row's OWN window, not the global one: in a popped-out surface the
    // module-level `navigator` belongs to the opener (the same house pattern as
    // shared.ts's copyCodeFromEvent and deskhosts.tsx); `copyToClipboard` is it
    void copyToClipboard(row, text).then(ok => { if (ok) setCopied({ id: ++copyTicket, x, y }) })
  }
  const onDoubleClick = (e: ReactMouseEvent<HTMLElement>, text: string) => {
    // an embedded control owns its own double-click. `stopPropagation` on
    // those buttons' `click` does NOT stop `dblclick`, so the guard is here.
    if ((e.target as Element | null)?.closest?.(
      'button, input, textarea, select, a, .docket-copied')) return
    // ⚠ THE GESTURE IS OURS, SO ITS SELECTION IS OURS TO CLEAR (user report
    // 2026-09-12: "double-clicking a ticket to copy its slug leaves that ticket
    // in a temporary interaction state where right-click cannot open its
    // context menu until the operator opens another menu or clicks a different
    // ticket").
    //
    // A double-click is the browser's select-the-word gesture as well as our
    // copy, and the word it selects lies inside this row. A live selection
    // touching the object is EXACTLY when the context menu stands aside for the
    // browser's own (`nativeMenuPreferred`, canvas/contextmenu.tsx) — so the
    // selection this gesture left behind suppressed the row's own menu until
    // some later press collapsed it, which is why clicking another ticket
    // "fixed" it.
    //
    // Cleared HERE and nowhere wider, because the rule it works around is a
    // good one: a selection the READER made deliberately must still keep the
    // browser's menu, with its Copy and its search. This clears only the
    // selection the app's own gesture just caused. The row's OWN window.
    e.currentTarget.ownerDocument.defaultView?.getSelection()?.removeAllRanges()
    copyAt(e.currentTarget, e.clientX, e.clientY, text)
  }
  const bubble = copied && (
    <span key={copied.id} className="docket-copied" role="status"
      style={{ left: `${copied.x * 100}%`, top: `${copied.y * 100}%` }}>Copied!</span>
  )
  return { copyAt, onDoubleClick, bubble }
}
