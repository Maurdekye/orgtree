/** Normalized native crop: x/y are fractions of the available top-left travel. */
export type Crop = { x: number; y: number; size: number }
export type CropRect = { left: number; top: number; side: number }
export type Corner = 'nw' | 'ne' | 'sw' | 'se'
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
export function cropRect(crop: Crop, width: number, height: number): CropRect {
  const side = Math.min(width, height) * clamp(crop.size, .1, 1)
  return { left: (width - side) * clamp(crop.x, 0, 1), top: (height - side) * clamp(crop.y, 0, 1), side }
}
export function rectCrop(rect: CropRect, width: number, height: number): Crop {
  const side = clamp(rect.side, Math.min(width, height) * .1, Math.min(width, height))
  return { x: width === side ? .5 : clamp(rect.left / (width - side), 0, 1),
    y: height === side ? .5 : clamp(rect.top / (height - side), 0, 1), size: side / Math.min(width, height) }
}
export function moveCrop(rect: CropRect, dx: number, dy: number, width: number, height: number): Crop {
  return rectCrop({ ...rect, left: clamp(rect.left + dx, 0, width - rect.side), top: clamp(rect.top + dy, 0, height - rect.side) }, width, height)
}
export function resizeCrop(rect: CropRect, corner: Corner, dx: number, dy: number, width: number, height: number): Crop {
  const west = corner.includes('w'), north = corner.includes('n')
  const anchorX = rect.left + (west ? rect.side : 0), anchorY = rect.top + (north ? rect.side : 0)
  const side = clamp(rect.side + ((west ? -dx : dx) + (north ? -dy : dy)) / 2,
    Math.min(width, height) * .1, Math.min(west ? anchorX : width - anchorX, north ? anchorY : height - anchorY))
  return rectCrop({ left: west ? anchorX - side : anchorX, top: north ? anchorY - side : anchorY, side }, width, height)
}
export function keyCrop(crop: Crop, key: string, resize: boolean, width: number, height: number): Crop {
  const rect = cropRect(crop, width, height), step = Math.min(width, height) * .01
  if (!resize) return moveCrop(rect, key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0,
    key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0, width, height)
  const cx = rect.left + rect.side / 2, cy = rect.top + rect.side / 2
  const side = clamp(rect.side + (key === 'ArrowLeft' || key === 'ArrowUp' ? -step : step),
    Math.min(width, height) * .1, Math.min(cx, cy, width - cx, height - cy) * 2)
  return rectCrop({ left: cx - side / 2, top: cy - side / 2, side }, width, height)
}
