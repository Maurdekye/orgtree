import { initiatingDocument } from '../windowlife'
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
  img.src = src
  if (opts.name) img.alt = opts.name
  // the backdrop closes; the picture itself doesn't (mis-click near the edge)
  img.addEventListener('click', (e) => e.stopPropagation())
  ov.appendChild(img)
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
    bar.appendChild(dl)
  }
  const x = ownerDocument.createElement('button')
  x.className = 'lb-x'
  x.title = 'close (Esc)'
  x.textContent = '✕'
  x.addEventListener('click', () => closeLightbox(ownerDocument))
  ov.appendChild(x)
  ov.appendChild(bar)
  ov.addEventListener('click', () => closeLightbox(ownerDocument))
  ownerDocument.body.appendChild(ov)
  ownerDocument.addEventListener('keydown', onKey)
}

export function closeLightbox(ownerDocument: Document = initiatingDocument()): void {
  ownerDocument.querySelector('.lb-overlay')?.remove()
  ownerDocument.removeEventListener('keydown', onKey)
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    // the desk's own Esc handlers (panel close, deselect) live upstream —
    // while the viewer is up, Esc means ONLY "close the viewer"
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
// opens in the viewer, via the one check above.
if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
  openLightboxIfEligibleImage(e)
})
