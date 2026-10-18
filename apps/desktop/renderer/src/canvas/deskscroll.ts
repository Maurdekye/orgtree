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
