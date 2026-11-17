import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/** Fit the complete near-card face uniformly; card geometry and outside
 * furniture remain owned by the canvas. USER 2026-10-21 11:21Z. */
export function CardFace({ children, fit = true }: { children: ReactNode; fit?: boolean }) {
  return fit ? <FittedFace>{children}</FittedFace> : <>{children}</>
}
// Every face waiting for a fit, measured together once per commit (a microtask: after React's commit,
// before paint). One face measured alone is a write (hide overlays), a forced layout (read) and a
// write; measured one after another, N faces forced N layouts. Mounting a zoom level's faces at once
// (a glide crossing into near zoom) did that for every visible card. Here all writes, then all reads,
// then all writes: two layouts for any number of faces.
interface Face { host: HTMLElement; inner: HTMLElement; mutation: MutationObserver | null }
const waiting = new Set<Face>()
function fitSoon(face: Face): void {
  if (!waiting.size) queueMicrotask(fitAll)
  waiting.add(face)
}
function fitAll(): void {
  const faces = [...waiting].filter(f => f.host.isConnected && f.inner.isConnected)
  waiting.clear()
  // reads: the box each face must fit in
  const boxes = faces.map(f => ({ f, w: f.host.clientWidth, h: f.host.clientHeight })).filter(b => b.w && b.h)
  // offset/scroll sizes are pre-transform: camera zoom and our previous
  // fit never feed back into the next measurement or shrink repeatedly.
  // The full-name pill is an overlay, not content to fit. Absolute children
  // still enlarge scrollWidth, so measure the resting layout without them.
  // Hide/restore synchronously before paint: the reveal stays in place and
  // real badge/title changes still refit (USER 2026-10-21 17:35Z).
  const hidden = boxes.map(({ f }) => [...f.inner.querySelectorAll<HTMLElement>('[data-card-fit-overlay]')].map(el => ({
    el, display: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display'),
  })))
  const sizes: { width: number; height: number }[] = []
  try {
    for (const list of hidden) for (const { el } of list) el.style.setProperty('display', 'none', 'important')
    for (const { f } of boxes) sizes.push({ width: Math.max(f.inner.offsetWidth, f.inner.scrollWidth), height: Math.max(f.inner.offsetHeight, f.inner.scrollHeight) })
  } finally {
    for (const list of hidden) for (const { el, display, priority } of list) {
      if (display) el.style.setProperty('display', display, priority)
      else el.style.removeProperty('display')
    }
  }
  boxes.forEach(({ f, w, h }, i) => {
    if (!sizes[i]) return
    const scale = Math.min(1, w / Math.max(1, sizes[i].width), h / Math.max(1, sizes[i].height))
    const transform = scale < 1 ? `scale(${scale})` : 'none'
    if (f.inner.style.transform !== transform) f.inner.style.transform = transform
    f.host.dataset.cardScale = String(scale)
  })
  // our own style writes are not content changes: drop them from each face's mutation queue
  for (const f of faces) f.mutation?.takeRecords()
}

function FittedFace({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const face = useRef<Face | null>(null)
  const measure = useCallback(() => {
    const host = frame.current, inner = content.current
    if (!host || !inner) return
    if (!face.current || face.current.host !== host || face.current.inner !== inner) face.current = { host, inner, mutation: face.current?.mutation ?? null }
    fitSoon(face.current)
  }, [])
  // Measure once at mount, then only when something can have changed the fit: the face's own DOM (a
  // title, a badge: overflow that need not resize the box) or a size. NOT after every render: every
  // camera frame of a glide re-renders every card, and each measure is a forced synchronous layout, so
  // one frame cost one reflow per card over a DOM that had just gained a desk (4.6.1-alpha.3 hang).
  useLayoutEffect(measure, [measure])
  useEffect(() => {
    const host = frame.current, inner = content.current
    const win = host?.ownerDocument.defaultView
    if (!host || !inner || !win) return
    const Resize = win.ResizeObserver, Mutation = win.MutationObserver
    const resize = Resize ? new Resize(measure) : null
    resize?.observe(host); resize?.observe(inner)
    const mutation = Mutation ? new Mutation(measure) : null
    mutation?.observe(inner, { subtree: true, childList: true, characterData: true, attributes: true })
    if (face.current) face.current.mutation = mutation
    return () => { resize?.disconnect(); mutation?.disconnect(); if (face.current) face.current.mutation = null }
  }, [measure])
  return <div className="card-face" ref={frame}><div className="card-face-inner" ref={content}>{children}</div></div>
}
