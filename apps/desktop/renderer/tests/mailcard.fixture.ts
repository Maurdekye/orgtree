import assert from 'node:assert/strict'

/** Compare the painted card, retaining all content and its order. Selection
 * boundaries are layout-transparent; reject any wrapper that stops being so. */
export function mailCardContent(el: Element): Element {
  const clone = el.cloneNode(true) as Element
  for (const chrome of clone.querySelectorAll('.pend-tag, .pend-x, .ghost-acts')) chrome.remove()
  for (const surface of clone.querySelectorAll<HTMLElement>('.selection-source')) {
    assert.equal(surface.className, 'selection-source', 'selection wrapper has no extra styling class')
    assert.equal(surface.getAttribute('data-selection-source'), '', 'selection wrapper keeps its source marker')
    assert.equal(surface.style.cssText, 'display: contents;', 'selection wrapper must remain layout-transparent')
    surface.replaceWith(...surface.childNodes)
  }
  return clone
}
