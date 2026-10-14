import { useLayoutEffect, useRef } from 'react'
import type { ToastUndo } from './types'
import { historyShortcut } from './undokeys'

export interface Toast {
  id: number
  lines: string[]
  undo: ToastUndo | null
  available: () => boolean
  dismiss: () => void
  runUndo: () => void
}

/** Shared by every mirrored presentation: consume before invoking the callback,
 * including before React commits removal or a second window handles a key. */
export function createToast(lines: string[], undo: ToastUndo | null, remove: (id: number) => void): Toast {
  const id = Date.now() + Math.random()
  const expires = Date.now() + 12000
  let active = true
  const dismiss = () => { active = false; remove(id) }
  const available = () => active && !!undo && Date.now() < expires
  return { id, lines, undo, available, dismiss, runUndo: () => {
    if (!available()) return
    dismiss()
    ;(typeof undo === 'function' ? undo : undo!.fn)()
  } }
}

/** Layout is checked in the toast's own document, never in the main window. */
function visible(button: HTMLButtonElement): boolean {
  const doc = button.ownerDocument, win = doc.defaultView
  if (!win || doc.hidden || button.disabled || !button.getClientRects().length) return false
  const rect = button.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
    || rect.top >= win.innerHeight || rect.left >= win.innerWidth) return false
  for (let el: Element | null = button; el; el = el.parentElement) {
    const css = win.getComputedStyle(el)
    if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || css.opacity === '0') return false
  }
  return true
}

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const stack = root.current
    const win = stack?.ownerDocument.defaultView
    if (!stack || !win) return
    const keydown = (event: KeyboardEvent) => {
      if (historyShortcut(event, stack.ownerDocument) !== 'undo') return
      for (let i = toasts.length - 1; i >= 0; i--) {
        const toast = toasts[i]!
        const button = stack.children[i]?.querySelector<HTMLButtonElement>('.toast-undo')
        if (!toast.available() || !button || !visible(button)) continue
        event.preventDefault()
        toast.runUndo()
        return
      }
    }
    win.addEventListener('keydown', keydown)
    return () => win.removeEventListener('keydown', keydown)
  }, [toasts])
  return <div className="toasts" ref={root}>
    {toasts.map(toast => <div key={toast.id} className="toast" onClick={toast.dismiss}>
      {toast.lines.map((line, i) => <div key={i}>{line}</div>)}
      {toast.undo && <button className="toast-undo" onClick={event => {
        event.stopPropagation()
        toast.runUndo()
      }}>{typeof toast.undo === 'function' ? 'undo' : toast.undo.label}</button>}
    </div>)}
  </div>
}
