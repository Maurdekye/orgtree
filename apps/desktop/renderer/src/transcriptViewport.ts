/** Measure laid-out rows, not character counts or assumed message heights. */
export function transcriptViewport(el: HTMLElement) {
  const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-transcript-row]'))
    .filter(row => row.offsetHeight > 0)
  if (el.clientHeight <= 0 || !rows.length) return { more: 0, page: 8 }
  // All row wrappers are siblings with the same offset parent. offset* uses
  // layout pixels, unaffected by the canvas camera's CSS scale.
  const first = rows[0]!, last = rows[rows.length - 1]!
  const height = last.offsetTop + last.offsetHeight - first.offsetTop
  if (height <= 0) return { more: 0, page: 8 }
  const average = height / rows.length
  const target = el.clientHeight * 2
  return {
    more: Math.max(0, Math.min(64, Math.ceil((target - height) / average))),
    page: Math.max(1, Math.min(64, Math.ceil(target / average))),
  }
}
