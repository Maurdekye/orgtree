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
/** Attract mode moves the VIEW only and never keyboard focus (USER 2026-11-03 m65dc30c3f45a: "when attract mode focuses an
 *  agent desk, it defocuses whatever messagebox i may have been typing in"). While one of its targets is on screen, a desk
 *  that mounts does not take the caret; a desk the user opens when attract is not driving keeps today's behaviour. */
let attractQuiet = false
export function setAttractQuiet(on: boolean): void { attractQuiet = on }
export function focusComposerAutomatically(el: HTMLTextAreaElement): void {
  if (attractQuiet) return
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
