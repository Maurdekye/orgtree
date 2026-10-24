import type { MouseEvent } from 'react'

// A navigation-opened composer keeps direct typing, without trapping the next
// org chord. Explicit user interaction returns normal editor key ownership.
const navigationFocus = new WeakMap<Document, HTMLElement | null>()
export function beginKeyboardNavigation(doc: Document): void {
  if (!navigationFocus.has(doc)) navigationFocus.set(doc, null)
}
export function endKeyboardNavigation(doc: Document): void { navigationFocus.delete(doc) }
export function navigationAutofocusedEditor(doc: Document): HTMLElement | null {
  const editor = navigationFocus.get(doc)
  return editor?.isConnected && doc.activeElement === editor ? editor : null
}
export function focusComposerAutomatically(el: HTMLTextAreaElement): void {
  if (navigationFocus.has(el.ownerDocument)) navigationFocus.set(el.ownerDocument, el)
  el.focus({ preventScroll: true })
}

/** Empty padding/rows belong to the text field; nested controls and portaled
 * pickers keep their own focus and click behavior. The textarea's caret and
 * the surrounding desk's scroll position are left where the user put them. */
export function focusComposerBackground(e: MouseEvent<HTMLElement>): void {
  if (e.defaultPrevented || e.button !== 0) return
  const target = e.target as Element
  if (!e.currentTarget.contains(target)) return
  const control = target.closest('button,input,textarea,select,a,label,summary,[role="button"],[role="menuitem"],[role="option"],[role="dialog"],[role="listbox"],[contenteditable]')
  if (control && e.currentTarget.contains(control)) return
  e.currentTarget.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'textarea:not(:disabled),input.quickchat-input:not(:disabled)',
  )?.focus({preventScroll:true})
}
