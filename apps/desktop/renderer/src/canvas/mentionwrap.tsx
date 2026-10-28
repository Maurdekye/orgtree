import { useSyncExternalStore } from 'react'
import type { HTMLAttributes, KeyboardEvent } from 'react'
import { onAppValue } from '../appfeed'

export const MENTION_WRAP_KEY = 'wrap_object_mentions'
const CLASS = 'wrap-object-mentions'

// Each renderer receives the app value; browser popouts mirror the root class.
// Mentions read it from here, never by subscribing to the app feed themselves:
// a chip that did opened the feed on its own wherever nothing else had (one
// more /api/app/records read and a socket) and re-rendered on EVERY feed change
// (4.5.0 release gate, 2026-10-28). The feed the shell keeps open runs this hook.
let wrapping = false
const wrapListeners = new Set<() => void>()
onAppValue(MENTION_WRAP_KEY, value => {
  wrapping = value === true
  document.documentElement.classList.toggle(CLASS, wrapping)
  for (const fn of wrapListeners) fn()
})
const subscribeWrap = (fn: () => void) => { wrapListeners.add(fn); return () => { wrapListeners.delete(fn) } }
/** Whether object mentions wrap; re-renders only when that setting changes. */
export const useObjectMentionsWrap = (): boolean => useSyncExternalStore(subscribeWrap, () => wrapping, () => false)

export const objectMentionsWrap = (doc: Document) => doc.documentElement.classList.contains(CLASS)

function activateInline(e: KeyboardEvent<HTMLElement>) {
  if (!e.defaultPrevented && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.click()
  }
}

/** Buttons are atomic in Chromium even with display:inline. Only the opt-in
 * control uses a fragmentable span, retaining button keyboard activation. */
export function ObjectMentionButton({ wrappable = true, ...props }:
  HTMLAttributes<HTMLElement> & { wrappable?: boolean; 'data-copy-ticket-title'?: string }) {
  const wrap = useObjectMentionsWrap() && wrappable
  if (!wrap) return <button {...props} type="button" />
  return <span {...props} role="button" tabIndex={props.tabIndex ?? 0}
    onKeyDown={e => { props.onKeyDown?.(e); activateInline(e) }} />
}

/** The same control for sanitized Markdown's DOM-only reference pass. */
export function createObjectMentionButton(doc: Document): HTMLElement {
  if (!objectMentionsWrap(doc)) {
    const button = doc.createElement('button')
    button.type = 'button'
    return button
  }
  const span = doc.createElement('span')
  span.setAttribute('role', 'button')
  span.tabIndex = 0
  span.addEventListener('keydown', e => {
    if (!e.defaultPrevented && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); e.stopPropagation(); span.click()
    }
  })
  return span
}
