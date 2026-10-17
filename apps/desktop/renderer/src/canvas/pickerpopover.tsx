import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
type PopKind = 'superior' | 'model' | 'files'
const LEAVE_PX = 70

/** an overlay beside the bar holding the box — above a footer, below a
 *  header — in the anchor's own window; outside press or Escape closes it */
export function PickerPopover({ anchor, onClose, kind, leaving, children, className = '', label, focusFirst }: {
  anchor: HTMLElement; onClose: () => void; kind: PopKind; leaving?: boolean; children: ReactNode
  className?: string; label?: string; focusFirst?: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const doc = anchor.ownerDocument
  const r = anchor.getBoundingClientRect()
  // clear of the whole bar, not just the box (the bar is taller): upward
  // from a footer, downward from anything else
  const bar = anchor.closest('footer, header')
  const up = bar?.tagName === 'FOOTER'
  const b = bar?.getBoundingClientRect()
  const vh = doc.documentElement.clientHeight || (doc.defaultView?.innerHeight ?? 0)
  const place = up
    ? { bottom: vh - Math.min(r.top, b?.top ?? r.top) + 4 }
    : { top: Math.max(r.bottom, b?.bottom ?? 0) + 4 }
  // the model chips hang centred under their button, as the hire strip hangs
  // centred under its card; the lists open from the button's left edge
  const centred = kind === 'model'
  const [left, setLeft] = useState(r.left)
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0
    const vw = doc.documentElement.clientWidth || (doc.defaultView?.innerWidth ?? 0)
    const want = centred ? r.left + r.width / 2 - w / 2 : r.left
    if (w && vw) setLeft(Math.max(8, Math.min(want, vw - w - 8)))
  }, [doc, r.left, r.width, centred])
  const closeRef = useRef(onClose); closeRef.current = onClose
  useEffect(() => {
    if (!focusFirst || leaving) return
    const host = ref.current
    const target = host?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)')
      ?? host?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? host
    target?.focus({preventScroll:true})
  }, [focusFirst, leaving])
  useEffect(() => {
    if (leaving) return
    const down = (e: Event) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !anchor.contains(t)) closeRef.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current() }
    }
    doc.addEventListener('pointerdown', down, true)
    doc.addEventListener('keydown', key, true)
    return () => {
      doc.removeEventListener('pointerdown', down, true)
      doc.removeEventListener('keydown', key, true)
    }
  }, [doc, anchor, leaving])
  // the model chips close themselves once the pointer wanders off (user
  // 2026-10-10), fading out like any close: farther than LEAVE_PX from both
  // the chips and their button. Armed only once the pointer has been inside
  // that zone, so a picker opened from the keyboard waits for the mouse.
  useEffect(() => {
    if (leaving || kind !== 'model') return
    let armed = false
    const near = (x: number, y: number, el: Element | null) => {
      if (!el) return false
      const b = el.getBoundingClientRect()
      return x >= b.left - LEAVE_PX && x <= b.right + LEAVE_PX && y >= b.top - LEAVE_PX && y <= b.bottom + LEAVE_PX
    }
    const move = (e: PointerEvent) => {
      const inside = near(e.clientX, e.clientY, ref.current) || near(e.clientX, e.clientY, anchor)
      if (inside) armed = true
      else if (armed) closeRef.current()
    }
    doc.addEventListener('pointermove', move, true)
    return () => doc.removeEventListener('pointermove', move, true)
  }, [doc, anchor, kind, leaving])
  return createPortal(
    <div ref={ref} className={(leaving ? 'quickchat-leaving' : 'quickchat-pop') + ' quickchat-pop-' + kind
      + (up ? ' up' : '') + (className ? ' ' + className : '')}
      role={leaving ? undefined : 'dialog'} aria-label={label} tabIndex={focusFirst ? -1 : undefined} aria-hidden={leaving || undefined}
      style={{ ...place, left }}>
      {children}
    </div>, doc.body)
}
