/** Navigation yields to editors, widget keys, composition and open overlays. */
const OWN_KEYS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), '
  + '[role="textbox"], [role="combobox"], [role="listbox"], [role="slider"], [role="spinbutton"], '
  + '.monaco-editor, .cm-editor, .CodeMirror'

export function navigationBlocked(event: KeyboardEvent, owner?: Document): boolean {
  const target = event.target as Element | null
  const doc = target?.ownerDocument ?? owner
  return event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
    || !!target?.closest?.(OWN_KEYS)
    || !!doc?.activeElement?.closest(OWN_KEYS)
    || !!doc?.querySelector('[aria-modal="true"], [role="dialog"]:not(.modalpin-win), '
      + '[role="menu"], .lb-overlay, .picker-overlay')
}

/** Bubble after local handlers; a pointer gesture keeps its ownership. */
export function installNavigationKeys(doc: Document, onKey: (event: KeyboardEvent) => void): () => void {
  const pointers = new Set<number>()
  const down = (event: PointerEvent) => { if (event.buttons) pointers.add(event.pointerId) }
  const up = (event: PointerEvent) => { pointers.delete(event.pointerId) }
  const clear = () => pointers.clear()
  const key = (event: KeyboardEvent) => { if (!pointers.size && !navigationBlocked(event, doc)) onKey(event) }
  doc.addEventListener('pointerdown', down, true)
  doc.addEventListener('pointerup', up, true)
  doc.addEventListener('pointercancel', up, true)
  doc.defaultView?.addEventListener('blur', clear)
  const host = doc.defaultView ?? doc
  host.addEventListener('keydown', key as EventListener)
  return () => {
    doc.removeEventListener('pointerdown', down, true)
    doc.removeEventListener('pointerup', up, true)
    doc.removeEventListener('pointercancel', up, true)
    doc.defaultView?.removeEventListener('blur', clear)
    host.removeEventListener('keydown', key as EventListener)
  }
}
