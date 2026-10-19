// shell/equalsides.ts — the centred-bar rule for the bar holding Quick chat
// (the header or the footer, per App settings › Display › Quick chat position).
import { useLayoutEffect, useRef } from 'react'

/** Each side of a centred bar claims ITS OWN controls as its minimum width —
 *  published as `--shell-start-min` / `--shell-end-min`. Equal growth centres
 *  the box while both sides have room; once one side is down to its controls
 *  the other keeps the rest, so the box slides off-centre at full width and
 *  only shrinks once neither side has free space left (user 2026-10-10: "it
 *  should keep its full width until the free space on both sides is gone").
 *  Used by whichever bar holds Quick chat (shell/header.tsx, shell/statusbar.tsx).
 *  Measured from the controls themselves (their widths do not depend on the
 *  side's), so the observer cannot feed back into itself. */
export function useEqualSides(on: boolean) {
  const head = useRef<HTMLElement>(null)
  const start = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const h = head.current, a = start.current, b = end.current
    if (!on || !h || !a || !b || typeof ResizeObserver === 'undefined') return
    const need = (el: HTMLElement) => {
      // Measure without the previous minimum constraining the flex children.
      // Otherwise a clipped title becomes the next minimum, which changes its
      // clipping again on the next ResizeObserver delivery. Restore before
      // paint; ResizeObserver sees only the final, settled allocation.
      const min = el.style.getPropertyValue('min-width')
      const priority = el.style.getPropertyPriority('min-width')
      el.style.setProperty('min-width', 'max-content')
      try {
        const cs = getComputedStyle(el)
        const kids = [...el.children] as HTMLElement[]
        const gap = parseFloat(cs.columnGap) || 0
        const width = kids.reduce((w, k) => w + k.getBoundingClientRect().width, 0)
          + gap * Math.max(0, kids.length - 1)
          + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
        const title = kids.find(k => k.classList.contains('shell-header-title'))
        return { width, title: title?.getBoundingClientRect().width ?? 0 }
      } finally {
        if (min) el.style.setProperty('min-width', min, priority)
        else el.style.removeProperty('min-width')
      }
    }
    const sync = () => {
      const set = (key: string, width: number) => {
        const value = `${Math.ceil(width)}px`
        if (h.style.getPropertyValue(key) !== value) h.style.setProperty(key, value)
      }
      const left = need(a), right = need(b)
      // Long org names still yield to the controls and Quick chat's responsive
      // floor. This budget comes from the bar width, never a clipped title.
      const quick = h.querySelector<HTMLElement>(':scope > .shell-header-quick')
      if (left.title && quick) {
        const gap = parseFloat(getComputedStyle(h).columnGap) || 0
        const floor = parseFloat(getComputedStyle(quick).minWidth) || 0
        const available = Math.floor(h.clientWidth - gap * 2 - floor)
        const fixed = Math.ceil(left.width - left.title)
        left.width = Math.min(left.width, Math.max(fixed, available - Math.ceil(right.width)))
      }
      set('--shell-start-min', left.width)
      set('--shell-end-min', right.width)
    }
    const sizes = new ResizeObserver(sync)
    const watch = () => {
      sizes.disconnect()
      sizes.observe(h)
      for (const k of [...a.children, ...b.children]) sizes.observe(k)
      sync()
    }
    // a control that appears later (an update notice, the killswitch) counts too
    const kids = typeof MutationObserver === 'undefined' ? null : new MutationObserver(watch)
    kids?.observe(a, { childList: true, subtree: true, characterData: true })
    kids?.observe(b, { childList: true, subtree: true, characterData: true })
    watch()
    return () => { sizes.disconnect(); kids?.disconnect() }
  }, [on])
  return { head, start, end }
}
