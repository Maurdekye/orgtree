// shell/equalsides.ts — the centred-bar rule for the shell's Quick chat row.
import { useLayoutEffect, useRef } from 'react'

/** Each side of a centred bar claims ITS OWN controls as its minimum width —
 *  published as `--shell-start-min` / `--shell-end-min`. Equal growth centres
 *  the box while both sides have room; once one side is down to its controls
 *  the other keeps the rest, so the box slides off-centre at full width and
 *  only shrinks once neither side has free space left (user 2026-10-10: "it
 *  should keep its full width until the free space on both sides is gone").
 *  The footer's Quick chat row uses it (shell/statusbar.tsx).
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
      const cs = getComputedStyle(el)
      const kids = [...el.children] as HTMLElement[]
      const gap = parseFloat(cs.columnGap) || 0
      return kids.reduce((w, k) => w + k.getBoundingClientRect().width, 0)
        + gap * Math.max(0, kids.length - 1)
        + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
    }
    const sync = () => {
      h.style.setProperty('--shell-start-min', `${Math.ceil(need(a))}px`)
      h.style.setProperty('--shell-end-min', `${Math.ceil(need(b))}px`)
    }
    const sizes = new ResizeObserver(sync)
    const watch = () => {
      sizes.disconnect()
      for (const k of [...a.children, ...b.children]) sizes.observe(k)
      sync()
    }
    // a control that appears later (an update notice, the killswitch) counts too
    const kids = typeof MutationObserver === 'undefined' ? null : new MutationObserver(watch)
    kids?.observe(a, { childList: true }); kids?.observe(b, { childList: true })
    watch()
    return () => { sizes.disconnect(); kids?.disconnect() }
  }, [on])
  return { head, start, end }
}
