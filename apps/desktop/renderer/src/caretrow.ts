/** WHICH VISUAL ROW OF A TEXTAREA THE CARET IS ON, for the keys that must know
 *  whether an arrow can still move the caret up or down a row before it means
 *  something else (the sent-message history, composerhistorynav.ts).
 *
 *  A textarea exposes no row geometry, so the text is laid out again in a
 *  hidden copy of it: the same width, padding, font and wrapping rules, with an
 *  empty marker at the start of the text, at the caret and at the end. Markers
 *  on the same row share an offsetTop; a different row is a line apart, which
 *  is always more than a couple of pixels. An EMPTY marker is the right probe:
 *  any character in it (a zero-width space, a word joiner) would add or remove a
 *  line-break opportunity beside the caret and shift the very wrap being asked
 *  about. A marker at a soft-wrap boundary stays with the text before it, so
 *  the caret there counts as the END of the row above, as the End key puts it.
 *
 *  Returns null when there is no layout to ask (an unrendered or detached
 *  textarea, a zero-width one, a test DOM): the caller then keeps to the
 *  newline rule alone, which is what it did before rows existed. */
export interface CaretRows {
  /** the caret is on the top row of the text */
  first: boolean
  /** the caret is on the bottom row of the text */
  last: boolean
}

/** the properties that decide where the text wraps */
const WRAP_PROPS = [
  'direction', 'font-family', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-variant',
  'font-weight', 'font-kerning', 'font-feature-settings', 'line-height', 'letter-spacing', 'word-spacing',
  'text-transform', 'text-indent', 'tab-size', 'text-align', 'word-break',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
] as const

const probe = (name: string): HTMLSpanElement => {
  const span = document.createElement('span')
  span.setAttribute('data-caret-probe', name)
  return span
}

export function caretRows(field: HTMLTextAreaElement, offset: number): CaretRows | null {
  if (typeof document === 'undefined' || !field.isConnected) return null
  const width = field.clientWidth
  if (!width) return null
  const mirror = document.createElement('div')
  try {
    const computed = getComputedStyle(field)
    for (const name of WRAP_PROPS) {
      const value = computed.getPropertyValue(name)
      if (value) mirror.style.setProperty(name, value)
    }
    // the textarea's clientWidth is its padding box without a scrollbar; border-box
    // with the copied padding leaves the same width for the text
    mirror.style.cssText += ';position:absolute;top:0;left:-99999px;visibility:hidden;pointer-events:none;'
      + `box-sizing:border-box;border:0;margin:0;height:auto;overflow:hidden;width:${width}px;`
      + 'white-space:pre-wrap;overflow-wrap:break-word;'
    const start = probe('start')
    const caret = probe('caret')
    const end = probe('end')
    mirror.append(start, document.createTextNode(field.value.slice(0, offset)), caret,
      document.createTextNode(field.value.slice(offset)), end)
    document.body.appendChild(mirror)
    const top = start.offsetTop
    const here = caret.offsetTop
    const bottom = end.offsetTop
    if (![top, here, bottom].every(Number.isFinite)) return null
    return { first: Math.abs(here - top) < 2, last: Math.abs(bottom - here) < 2 }
  } catch { return null } finally { mirror.remove() }
}
