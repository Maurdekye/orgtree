// canvas/foldlines.ts — HOW MANY LINES IS THIS, REALLY, and where does line N
// end?
//
// Two surfaces fold long prose at a line count: a received-mail body (5 lines)
// and a docket item's description (10 lines, user requirement 2026-09-12).
// Both need the same answer and neither can get it from the source text —
// "lines" here means RENDERED rows on screen, so a paragraph that wraps four
// times is four lines and a `\n` inside a markdown list is not necessarily
// one. Only layout knows, so this measures layout.
//
// THREE THINGS THAT ARE NOT NEGOTIABLE, each of them a way a simpler version
// gets the wrong number:
//
//  1. FRAGMENTS ON ONE VISUAL ROW ARE ONE LINE. Inline code, links and
//     differently-sized spans each produce their own client rect on the same
//     row; counting rects would count that row several times. Rects that
//     overlap vertically are merged.
//  2. PARAGRAPH SPACING IS NOT A LINE. The gap between two blocks is margin,
//     not text, so the fold is placed in the MIDDLE of the gap after the last
//     kept row — clipping exactly at its baseline shaves descenders, and
//     clipping at the next row's top shows a sliver of the line being hidden.
//  3. THE MEASUREMENT IS TAKEN UNCLIPPED. `maxHeight` is applied by the
//     caller to a wrapper; this reads the body inside it, whose full height is
//     unaffected — so expanding cannot change the answer and the control
//     cannot flicker between "long" and "short" as the reader toggles it.

/** What one measurement says about a body of prose.
 *
 *  `limit` is the pixel height that shows exactly `maxLines` lines, or `null`
 *  when the body is short enough that there is nothing to fold — which is also
 *  the caller's signal to draw NO control at all (user requirement: a short
 *  description gets no unnecessary chrome).
 *
 *  `lines` is the total rendered line count, reported whether or not it is
 *  over the limit, because the control tells the reader how much is hidden. */
export interface FoldMeasure {
  limit: number | null
  lines: number
}

export const NO_FOLD: FoldMeasure = { limit: null, lines: 0 }

/** Whether two measurements say the same thing.
 *
 *  `foldAt` builds a fresh object every call, so storing its result always
 *  looked like a state change to React and forced a render for an answer that
 *  had not moved. Callers compare instead of assigning blindly. */
export function sameFold(a: FoldMeasure, b: FoldMeasure): boolean {
  return a.limit === b.limit && a.lines === b.lines
}

/** Measure `body` and, if it runs past `maxLines`, say where to clip it. */
export function foldAt(body: HTMLElement, maxLines: number): FoldMeasure {
  const box = body.getBoundingClientRect()
  if (!box.width || !body.offsetWidth) return NO_FOLD
  const fragments: DOMRect[] = []
  const walk = body.ownerDocument.createTreeWalker(body, 4 /* SHOW_TEXT */)
  const range = body.ownerDocument.createRange()
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (!node.textContent?.trim()) continue
    range.selectNodeContents(node)
    fragments.push(...Array.from(range.getClientRects())
      .filter(r => r.width > 0 && r.height > 0))
  }
  fragments.sort((a, b) => a.top - b.top || a.left - b.left)
  const rows = mergeRows(fragments)
  if (rows.length <= maxLines) return { limit: null, lines: rows.length }
  // Range rects include the canvas/desk transform; CSS height does not.
  const scale = box.width / body.offsetWidth
  const last = rows[maxLines - 1]!, next = rows[maxLines]!
  return {
    limit: (last.bottom + Math.max(0, next.top - last.bottom) / 2 - box.top) / scale,
    lines: rows.length,
  }
}

/** Collapse client rects into visual rows. Exported for its own test: the
 *  browser supplies the rects, but the rule for what counts as one line is
 *  ours and is the part that can be wrong. */
export function mergeRows(fragments: readonly DOMRect[]): { top: number; bottom: number }[] {
  const rows: { top: number; bottom: number }[] = []
  for (const rect of fragments) {
    const last = rows[rows.length - 1]
    // ⚠ THE 1px SLACK IS ON BOTH EDGES. Sub-pixel layout puts two fragments of
    // one row a fraction apart; without the slack they become two lines and a
    // 10-line description folds at 5.
    if (last && rect.top < last.bottom - 1 && rect.bottom > last.top + 1) {
      last.top = Math.min(last.top, rect.top)
      last.bottom = Math.max(last.bottom, rect.bottom)
    } else rows.push({ top: rect.top, bottom: rect.bottom })
  }
  return rows
}
