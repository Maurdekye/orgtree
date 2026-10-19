import type { MouseEvent } from 'react'

/** Empty padding/rows belong to the text field; nested controls and portaled
 * pickers keep their own focus and click behavior. The textarea's caret and
 * the surrounding desk's scroll position are left where the user put them. */
export function focusComposerBackground(e: MouseEvent<HTMLElement>): void {
  if (e.defaultPrevented || e.button !== 0) return
  const target = e.target as Element
  if (!e.currentTarget.contains(target)) return
  if (target.closest('button,input,textarea,select,a,label,summary,[role="button"],[role="menuitem"],[role="option"],[role="dialog"],[role="listbox"],[contenteditable]')) return
  e.currentTarget.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'textarea:not(:disabled),input.quickchat-input:not(:disabled)',
  )?.focus({preventScroll:true})
}
