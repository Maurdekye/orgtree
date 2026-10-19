import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
type PopKind = 'superior' | 'model' | 'files' | 'options'
const LEAVE_PX = 70

/** an overlay beside the bar holding the box — above a footer, below a
 *  header — in the anchor's own window; outside press or Escape closes it */
const SIDE_GAP = 6
const SIDE_EDGE = 8

/** `beside`: this picker was opened from the Quick chat hire-options dropdown
 *  (`.quickchat-pop-options`, still open) and must not cover it (user
 *  2026-10-19 16:57Z): it goes to the dropdown's right, else its left, else
 *  stacked outward from it (above a footer, below a header), always inside the
 *  window, bottoms (or tops) level, and no taller than the room it has.
 *  `group` names pop-overs that count as "inside" for one another's outside
 *  press; `noEscape` leaves Escape to the pop-over opened from this one. */
export function PickerPopover({ anchor, onClose, kind, leaving, children, className = '', label, focusFirst, beside, group, noEscape }: {
  anchor: HTMLElement; onClose: () => void; kind: PopKind; leaving?: boolean; children: ReactNode
  className?: string; label?: string; focusFirst?: boolean; beside?: boolean; group?: string; noEscape?: boolean
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
  const [side, setSide] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!beside) { setSide(null); return }
    const host = doc.querySelector<HTMLElement>('.quickchat-pop-options')
    const el = ref.current
    if (!host || !el) return
    const h = host.getBoundingClientRect()
    const w = el.offsetWidth
    const vw = doc.documentElement.clientWidth || (doc.defaultView?.innerWidth ?? 0)
    const vh = doc.documentElement.clientHeight || (doc.defaultView?.innerHeight ?? 0)
    let next: CSSProperties
    if (h.right + SIDE_GAP + w <= vw - SIDE_EDGE || h.left - SIDE_GAP - w >= SIDE_EDGE) {
      const left = h.right + SIDE_GAP + w <= vw - SIDE_EDGE ? h.right + SIDE_GAP : h.left - SIDE_GAP - w
      next = up ? { left, bottom: vh - h.bottom, maxHeight: h.bottom - SIDE_EDGE }
        : { left, top: h.top, maxHeight: vh - h.top - SIDE_EDGE }
    } else {
      const left = Math.min(Math.max(h.left, SIDE_EDGE), Math.max(SIDE_EDGE, vw - w - SIDE_EDGE))
      next = up ? { left, bottom: vh - h.top + SIDE_GAP, maxHeight: h.top - SIDE_GAP - SIDE_EDGE }
        : { left, top: h.bottom + SIDE_GAP, maxHeight: vh - h.bottom - SIDE_GAP - SIDE_EDGE }
    }
    setSide(prev => prev && Object.keys(next).every(k => (prev as Record<string, unknown>)[k] === (next as Record<string, unknown>)[k]) ? prev : next)
  }, [beside, doc, up, anchor])
  const closeRef = useRef(onClose); closeRef.current = onClose
  const noEscapeRef = useRef(noEscape); noEscapeRef.current = noEscape
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
      const inGroup = !!group && !!(t as Element).closest?.(`[data-pop-group="${group}"]`)
      if (!ref.current?.contains(t) && !anchor.contains(t) && !inGroup) closeRef.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !noEscapeRef.current) { e.preventDefault(); e.stopPropagation(); closeRef.current() }
    }
    doc.addEventListener('pointerdown', down, true)
    doc.addEventListener('keydown', key, true)
    return () => {
      doc.removeEventListener('pointerdown', down, true)
      doc.removeEventListener('keydown', key, true)
    }
  }, [doc, anchor, leaving, group])
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
        || (!!beside && near(e.clientX, e.clientY, doc.querySelector('.quickchat-pop-options')))
      if (inside) armed = true
      else if (armed) closeRef.current()
    }
    doc.addEventListener('pointermove', move, true)
    return () => doc.removeEventListener('pointermove', move, true)
  }, [doc, anchor, kind, leaving])
  return createPortal(
    <div ref={ref} data-pop-group={group} className={(leaving ? 'quickchat-leaving' : 'quickchat-pop') + ' quickchat-pop-' + kind
      + (up ? ' up' : '') + (className ? ' ' + className : '')}
      role={leaving ? undefined : 'dialog'} aria-label={label} tabIndex={focusFirst ? -1 : undefined} aria-hidden={leaving || undefined}
      style={beside ? { ...(side ?? { left, ...place }), overflowY: 'auto', visibility: side ? undefined : 'hidden' } : { ...place, left }}>
      {children}
    </div>, doc.body)
}
