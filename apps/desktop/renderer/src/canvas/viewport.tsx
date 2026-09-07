import type { SVGProps } from 'react'

export interface WorldRect { x: number; y: number; w: number; h: number }
export function worldViewport(view: { x: number; y: number; z: number }, width: number, height: number,
  overscan = 160): WorldRect | null {
  if (!(width > 0 && height > 0 && view.z > 0) || !Number.isFinite(view.z)) return null
  return { x: (-view.x - overscan) / view.z, y: (-view.y - overscan) / view.z,
    w: (width + 2 * overscan) / view.z, h: (height + 2 * overscan) / view.z }
}

export function intersectsViewport(rect: WorldRect, viewport: WorldRect | null): boolean {
  return !viewport || rect.x + rect.w >= viewport.x && rect.y + rect.h >= viewport.y
    && rect.x <= viewport.x + viewport.w && rect.y <= viewport.y + viewport.h
}

/** Current graph paths use M/L/C only. A Bézier stays inside its control-point hull,
 * so conservative bounds retain crossing edges even when both endpoint cards are offscreen.
 * Unknown SVG commands remain visible rather than making an unsupported path disappear. */
export function pathBounds(path: string): WorldRect | null {
  if (/[^MLC\d\s.,+eE-]/.test(path)) return null
  const values = path.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)?.map(Number)
  if (!values?.length || values.length % 2 || values.some(n => !Number.isFinite(n))) return null
  const xs = values.filter((_, i) => i % 2 === 0), ys = values.filter((_, i) => i % 2 === 1)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function ViewportPath({ viewport, ...props }: SVGProps<SVGPathElement> & { viewport: WorldRect | null }) {
  const bounds = typeof props.d === 'string' ? pathBounds(props.d) : null
  if (bounds && !intersectsViewport(bounds, viewport)) return null
  return <path {...props} />
}
