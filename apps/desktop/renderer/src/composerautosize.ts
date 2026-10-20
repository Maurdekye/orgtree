// Agent and project desk composers: base rows plus thirty rendered text lines.
// CSS metrics also cover font scaling; measure after React commits the value.
export const COMPOSER_EXTRA_LINES = 30

export function resizeComposer(el: HTMLTextAreaElement | null): void {
  if (!el) return
  const style = el.ownerDocument.defaultView!.getComputedStyle(el)
  const px = (value: string): number => Number.parseFloat(value) || 0
  const line = px(style.lineHeight) || (px(style.fontSize) || 14) * 1.4
  const padding = px(style.paddingTop) + px(style.paddingBottom)
  const border = px(style.borderTopWidth) + px(style.borderBottomWidth)
  const cap = (el.rows + COMPOSER_EXTRA_LINES) * line + padding
  // Reset before reading: scrollHeight cannot shrink below the assigned size.
  // Measure without a scrollbar so its width cannot add an artificial wrap.
  el.style.height = 'auto'
  el.style.overflowY = 'hidden'
  const content = el.scrollHeight
  const height = Math.min(content, cap)
    + (style.boxSizing === 'border-box' ? border : -padding)
  el.style.height = `${height}px`
  el.style.overflowY = content > cap ? 'auto' : 'hidden'
}
