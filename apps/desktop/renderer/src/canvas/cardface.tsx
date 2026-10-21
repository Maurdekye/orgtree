import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/** Fit the complete near-card face uniformly; card geometry and outside
 * furniture remain owned by the canvas. USER 2026-10-21 11:21Z. */
export function CardFace({ children, fit = true }: { children: ReactNode; fit?: boolean }) {
  return fit ? <FittedFace>{children}</FittedFace> : <>{children}</>
}
function FittedFace({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const measure = useCallback(() => {
    const host = frame.current, inner = content.current
    if (!host || !inner || !host.clientWidth || !host.clientHeight) return
    // offset/scroll sizes are pre-transform: camera zoom and our previous
    // fit never feed back into the next measurement or shrink repeatedly.
    // The full-name pill is an overlay, not content to fit. Absolute children
    // still enlarge scrollWidth, so measure the resting layout without them.
    // Hide/restore synchronously before paint: the reveal stays in place and
    // real badge/title changes still refit (USER 2026-10-21 17:35Z).
    const overlays = [...inner.querySelectorAll<HTMLElement>('[data-card-fit-overlay]')].map(el => ({
      el, display: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display'),
    }))
    let width: number, height: number
    try {
      for (const { el } of overlays) el.style.setProperty('display', 'none', 'important')
      width = Math.max(inner.offsetWidth, inner.scrollWidth)
      height = Math.max(inner.offsetHeight, inner.scrollHeight)
    } finally {
      for (const { el, display, priority } of overlays) {
        if (display) el.style.setProperty('display', display, priority)
        else el.style.removeProperty('display')
      }
    }
    const scale = Math.min(1, host.clientWidth / Math.max(1, width), host.clientHeight / Math.max(1, height))
    inner.style.transform = scale < 1 ? `scale(${scale})` : 'none'
    host.dataset.cardScale = String(scale)
  }, [])
  useLayoutEffect(measure)
  useEffect(() => {
    const host = frame.current, inner = content.current
    const Observer = host?.ownerDocument.defaultView?.ResizeObserver
    if (!host || !inner || !Observer) return
    const observer = new Observer(measure)
    observer.observe(host); observer.observe(inner)
    return () => observer.disconnect()
  }, [measure])
  return <div className="card-face" ref={frame}><div className="card-face-inner" ref={content}>{children}</div></div>
}
