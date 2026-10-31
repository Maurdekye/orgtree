import { downloadFile } from './filedownload'
import { initiatingDocument } from '../windowlife'
import { HOME, panView, pinchView, resetPageZoom, toggleZoom, wheelView, type Pt, type View } from './pinchmath'
// canvas/lightbox.ts — the full-size image viewer (user spec 2026-08-25:
// images flow both ways — agents present them, users attach them — and every
// inline rendering needs a "view it properly" step that isn't a download).
//
// Pure DOM, like shared.ts's code-copy button: markdown bodies are innerHTML,
// so per-element React handlers don't exist there, and one document-level
// listener + one overlay element serves every surface — chat thumbnails, mail
// attachments, presented documents — without threading state through them.

/** open the viewer on one image. `download` names the href a "download"
 *  chrome link points at (usually the same /file URL); omitted = no link. */
export function openLightbox(src: string, opts: { name?: string; download?: string } = {}, ownerDocument: Document = initiatingDocument()): void {
  closeLightbox(ownerDocument)                       // one viewer, ever — a second click retargets
  const ov = ownerDocument.createElement('div')
  ov.className = 'lb-overlay'
  const img = ownerDocument.createElement('img')
  img.className = 'lb-img'
  // no native image drag: it steals the mouse pan (dragstart -> pointercancel) and ghosts the picture
  img.draggable = false
  img.addEventListener('dragstart', (e) => e.preventDefault())
  img.src = src
  if (opts.name) img.alt = opts.name
  // the backdrop closes; the picture itself doesn't (mis-click near the edge)
  img.addEventListener('click', (e) => e.stopPropagation())
  ov.appendChild(img)
  const zoom = attachZoom(ov, img, ownerDocument)
  const bar = ownerDocument.createElement('div')
  bar.className = 'lb-bar'
  bar.addEventListener('click', (e) => e.stopPropagation())
  if (opts.name) {
    const name = ownerDocument.createElement('span')
    name.className = 'lb-name'
    name.textContent = opts.name
    bar.appendChild(name)
  }
  if (opts.download) {
    const dl = ownerDocument.createElement('a')
    dl.className = 'lb-dl'
    dl.href = opts.download
    dl.setAttribute('download', opts.name ?? '')
    dl.textContent = 'download'
    const error = ownerDocument.createElement('span')
    error.setAttribute('role', 'alert')
    let busy = false
    dl.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      if (busy) return
      busy = true; dl.setAttribute('aria-disabled', 'true'); error.textContent = ''
      void downloadFile(ownerDocument, opts.download!, opts.name ?? 'image')
        .catch((e: Error) => { error.textContent = e.message })
        .finally(() => { busy = false; dl.removeAttribute('aria-disabled') })
    })
    bar.appendChild(dl)
    bar.appendChild(error)
  }
  const x = ownerDocument.createElement('button')
  x.className = 'lb-x'
  x.title = 'close (Esc)'
  x.textContent = '✕'
  x.addEventListener('click', () => closeLightbox(ownerDocument))
  ov.appendChild(x)
  ov.appendChild(bar)
  // the end of a pinch or a drag is not the tap that closes the viewer
  ov.addEventListener('click', () => { if (zoom.moved()) zoom.settle(); else closeLightbox(ownerDocument) })
  ownerDocument.body.appendChild(ov)
  resetPageZoom(ownerDocument)
  // Capture before a detached surface's keyboard bubbling boundary.
  ownerDocument.addEventListener('keydown', onKey, true)
}

export function closeLightbox(ownerDocument: Document = initiatingDocument()): void {
  const open = ownerDocument.querySelector('.lb-overlay')
  open?.remove()
  ownerDocument.removeEventListener('keydown', onKey, true)
  // closing always leaves the page at 1:1, whatever scaled it (Hubchat's bug: the app stayed zoomed)
  if (open) resetPageZoom(ownerDocument)
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    // the desk's own Esc handlers (panel close, deselect) live upstream —
    // while the viewer is up, Esc means ONLY "close the viewer"
    e.preventDefault()
    e.stopPropagation()
    closeLightbox((e.currentTarget as Document))
  }
}

/** If `e.target` is (or is inside) an eligible `.md img`, opens the viewer
 *  for it and returns true. An image the author wrapped in a LINK keeps the
 *  link: explicit navigation outranks the default view. Broken images
 *  (relative path that resolved to nothing) keep their broken-icon state
 *  instead of opening an empty viewer.
 *
 *  Exported (not just used by the document listener below) so a surface
 *  that must stop a click from propagating past itself for OTHER reasons —
 *  docs.tsx's DocReader stops every click from reaching the surrounding
 *  `.overlay`'s backdrop-close handler — can still recognise and open an
 *  eligible image directly, instead of the click silently never reaching
 *  this file at all. */
export function openLightboxIfEligibleImage(e: { target: EventTarget | null; defaultPrevented?: boolean; preventDefault(): void }): boolean {
  if (e.defaultPrevented) return false
  const img = (e.target as Element | null)?.closest?.('.md img') as HTMLImageElement | null
  if (!img || img.closest('a')) return false
  if (img.complete && img.naturalWidth === 0) return false
  e.preventDefault()
  openLightbox(img.currentSrc || img.src, {
    name: img.alt || undefined,
    download: img.currentSrc || img.src,
  }, img.ownerDocument)
  return true
}

// every image inside a markdown body (.md is innerHTML — no React handlers)
// opens in the viewer, via the one check above. CAPTURE, not bubble: every
// PinFrame panel (the Attention view's desk, mail, the docket) stops click
// propagation at the panel, so a bubbling listener never saw a click on a
// picture inside one (docket v3-copy-button-on-code-blocks-in-the-agent-chat,
// the same fault as the code-copy button). Popped-out windows already listen
// in capture (popout.tsx); the explicit calls in gallery.tsx then
// see `defaultPrevented` and do nothing twice.
if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
  openLightboxIfEligibleImage(e)
}, true)

/** Pinch, drag, double click and ctrl+wheel move only the picture (a CSS transform); the overlay takes the touches
 *  (touch-action: none) so the page is never scaled under a gesture. The same gestures, limits and math as Hubchat's
 *  image viewer (./pinchmath is a copy of its pinchmath.ts). No pointer capture: it would retarget the click that ends
 *  a tap to the overlay, so the picture's own double click would never arrive. */
function attachZoom(ov: HTMLElement, img: HTMLImageElement, doc: Document): { moved: () => boolean; settle: () => void } {
  let view: View = HOME
  let moved = false
  const fingers = new Map<number, Pt>()
  let gesture: { view: View; a: Pt; b: Pt } | { view: View; at: Pt } | null = null
  const put = (v: View) => { view = v; img.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})` }
  const size = () => ({ w: img.offsetWidth, h: img.offsetHeight })
  // the picture's unscaled centre on screen: its box centre less the current pan
  const centre = (): Pt => {
    const r = img.getBoundingClientRect()
    return { x: r.left + r.width / 2 - view.x, y: r.top + r.height / 2 - view.y }
  }
  const from = (p: Pt): Pt => { const c = centre(); return { x: p.x - c.x, y: p.y - c.y } }
  const begin = () => {
    const pts = [...fingers.values()]
    gesture = pts.length >= 2 ? { view, a: pts[0]!, b: pts[1]! } : pts.length === 1 ? { view, at: pts[0]! } : null
  }
  ov.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('.lb-x, .lb-bar')) return
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved = false
    begin()
  })
  ov.addEventListener('pointermove', (e) => {
    if (!fingers.has(e.pointerId) || !gesture) return
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...fingers.values()]
    const g = gesture
    if ('a' in g && pts.length >= 2) {
      put(pinchView(g.view, from(g.a), from(g.b), from(pts[0]!), from(pts[1]!), size()))
      moved = true
    } else if ('at' in g && pts.length === 1) {
      const dx = pts[0]!.x - g.at.x, dy = pts[0]!.y - g.at.y
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true
      if (g.view.scale > 1) put(panView(g.view, dx, dy, size()))
    }
  })
  const up = (e: PointerEvent) => { fingers.delete(e.pointerId); begin() }
  ov.addEventListener('pointerup', up)
  ov.addEventListener('pointercancel', up)
  // ctrl+wheel (a trackpad pinch) is the browser's page zoom unless it is stopped here
  ov.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    put(wheelView(view, e.deltaY, from({ x: e.clientX, y: e.clientY }), size()))
  }, { passive: false })
  img.addEventListener('dblclick', (e) => put(toggleZoom(view, from({ x: e.clientX, y: e.clientY }), size())))
  return { moved: () => moved, settle: () => { moved = false } }
}
