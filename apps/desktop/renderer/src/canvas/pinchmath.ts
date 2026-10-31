// Ported from Hubchat's image viewer (src/components/pinchmath.ts at 639cdeb, USER 2026-10-31
// 15:03:04Z md50218422de7; Orgtree gets the same zoom, USER 16:59:58Z mae5103702a59). The repos are
// separate, so this is a copy: keep every constant and formula IDENTICAL to Hubchat's, and change both.
/** The image viewer's own zoom (USER 2026-10-31 15:03:04Z md50218422de7: closing a zoomed-in image
 *  left the whole app zoomed in). Pinch and pan move only the picture; the page's own scale is never
 *  touched, and `resetPageZoom` puts it back at 1 if something did. */
export type View = { scale: number; x: number; y: number }
export type Size = { w: number; h: number }
export type Pt = { x: number; y: number }
export const MIN_SCALE = 1
export const MAX_SCALE = 6
export const HOME: View = { scale: 1, x: 0, y: 0 }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Keep the scale in range and the picture covering its own box: at scale 1 it is centred, zoomed
 *  in it may travel only until an edge meets the box edge. `img` is the unscaled picture size. */
export function clampView(v: View, img: Size): View {
  const scale = clamp(v.scale, MIN_SCALE, MAX_SCALE)
  const limit = (side: number) => Math.max(0, (side * scale - side) / 2)
  return { scale, x: clamp(v.x, -limit(img.w), limit(img.w)), y: clamp(v.y, -limit(img.h), limit(img.h)) }
}

/** The view after two fingers moved from (a0,b0) to (a1,b1), all relative to the picture's centre.
 *  The point under the old midpoint stays under the new one. */
export function pinchView(start: View, a0: Pt, b0: Pt, a1: Pt, b1: Pt, img: Size): View {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y)
  const scale = clamp(start.scale * (d1 / d0), MIN_SCALE, MAX_SCALE)
  const ratio = scale / start.scale
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 }
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 }
  return clampView({ scale, x: m1.x - (m0.x - start.x) * ratio, y: m1.y - (m0.y - start.y) * ratio }, img)
}

/** One finger (or the mouse) dragging a zoomed picture. At scale 1 there is nothing to pan. */
export function panView(start: View, dx: number, dy: number, img: Size): View {
  return start.scale <= MIN_SCALE ? HOME : clampView({ ...start, x: start.x + dx, y: start.y + dy }, img)
}

/** Double tap / double click: back to fit, or in to 2.5x about the point. */
export function toggleZoom(v: View, at: Pt, img: Size): View {
  if (v.scale > MIN_SCALE) return HOME
  const scale = 2.5
  return clampView({ scale, x: -at.x * (scale - 1), y: -at.y * (scale - 1) }, img)
}

/** Ctrl+wheel (a desktop trackpad pinch) about the pointer. */
export function wheelView(v: View, deltaY: number, at: Pt, img: Size): View {
  const scale = clamp(v.scale * Math.exp(-deltaY / 300), MIN_SCALE, MAX_SCALE)
  const ratio = scale / v.scale
  return clampView({ scale, x: at.x - (at.x - v.x) * ratio, y: at.y - (at.y - v.y) * ratio }, img)
}

/** The slice of `document` that `resetPageZoom` uses (so a test can fake it). */
export interface ZoomDoc {
  querySelector(sel: string): { getAttribute(n: string): string | null; setAttribute(n: string, v: string): void } | null
  defaultView: { requestAnimationFrame(cb: () => void): unknown; setTimeout(cb: () => void, ms: number): unknown } | null
}

/** The content each viewport meta had before a reset pinned it, and the latest reset's number: a reset
 *  inside another (open then close, or React's double effect) must restore the ORIGINAL, once, at the end. */
const original = new WeakMap<object, string>();
const latest = new WeakMap<object, number>();

/** Put the page back at scale 1 by pinning the viewport meta to 1 for a moment, then restoring it.
 *  Android's WebView takes the new bounds on the next frame; a zoom the user could not undo (closing
 *  a pinched image) is gone. A no-op when the meta is missing. */
export function resetPageZoom(doc: ZoomDoc): boolean {
  const meta = doc.querySelector('meta[name=viewport]')
  if (!meta) return false
  const was = original.get(meta) ?? meta.getAttribute('content') ?? ''
  original.set(meta, was)
  const n = (latest.get(meta) ?? 0) + 1
  latest.set(meta, n)
  meta.setAttribute('content', was.replace(/,?\s*(minimum|maximum)-scale=[^,]*/g, '') + ', minimum-scale=1, maximum-scale=1')
  const win = doc.defaultView
  const restore = () => {
    if (latest.get(meta) !== n) return
    meta.setAttribute('content', was)
    original.delete(meta)
  }
  if (win) win.requestAnimationFrame(() => win.requestAnimationFrame(restore))
  else restore()
  return true
}
