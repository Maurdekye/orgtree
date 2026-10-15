import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

const KEY_OWNER = 'input, textarea, select, .askcard, [contenteditable]:not([contenteditable="false"]), '
  + '[role="combobox"], [role="listbox"], [role="menu"], [role="slider"], [role="spinbutton"]'

/** Mail's panel-level Alt arrows, over the caller's already filtered/folded
 * order. Keep selection in its existing owner, including virtualized lists.
 * DOM checks use the event's document, so detached panels behave identically. */
export function usePanelSteps(ids: readonly string[], selected: string | null,
  select: (id: string) => void, rowSelector: string) {
  const rootRef = useRef<HTMLDivElement>(null)
  const opened = useRef(false)
  const [keyboardSelection, setKeyboardSelection] = useState<string | null>(null)
  const pendingScroll = useRef<string | null>(null)

  // Auto-selection does not focus a DOM row. Claim the panel once its list
  // mounts, so the first chord bubbles here without a click. A child editor
  // that already took focus keeps it; later polls never reclaim focus.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || opened.current) return
    opened.current = true
    if (!root.contains(root.ownerDocument.activeElement)) root.focus({ preventScroll: true })
  })

  // Selection may first reveal a row outside a virtualized viewport. Retry
  // after that commit, rather than scrolling the old window's row by index.
  useLayoutEffect(() => {
    if (!pendingScroll.current) return
    if (pendingScroll.current !== selected) { pendingScroll.current = null; return }
    const row = rootRef.current?.querySelector<HTMLElement>(rowSelector + '.on')
    if (!row || row.closest('[hidden]')) return
    row.scrollIntoView({ block: 'nearest' })
    pendingScroll.current = null
  })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.defaultPrevented) return
    const root = e.currentTarget
    const target = e.target as Element
    const focus = root.ownerDocument.activeElement
    if (target.closest?.(KEY_OWNER) || (focus && root.contains(focus) && focus.closest(KEY_OWNER))) return
    // A blurred editor still owns its unfinished reply. The explicit marker
    // also covers uploads/attachments and a send whose refusal restores text.
    if (root.querySelector('.mailer-read [data-panel-draft="true"]')) return
    if ([...root.querySelectorAll<HTMLTextAreaElement>('.mailer-read textarea')]
      .some(box => box.value.length > 0)) return
    if ([...root.querySelectorAll<HTMLInputElement>('.mailer-read .askcard input')]
      .some(box => box.type === 'checkbox' || box.type === 'radio' ? box.checked !== box.defaultChecked
        : box.value !== box.defaultValue)) return
    if ([...root.querySelectorAll('.mailer-read [contenteditable]:not([contenteditable="false"])')]
      .some(box => box.textContent?.length)) return
    e.preventDefault()
    if (!ids.length) return
    const index = selected === null ? -1 : ids.indexOf(selected)
    const next = index < 0 ? 0 : e.key === 'ArrowDown'
      ? Math.min(ids.length - 1, index + 1) : Math.max(0, index - 1)
    const id = ids[next]!
    if (id === selected) return
    pendingScroll.current = id
    setKeyboardSelection(id)
    select(id)
  }
  return { rootRef, onKeyDown, reveal: keyboardSelection === selected ? selected : null }
}
