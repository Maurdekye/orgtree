/** The tray icon with a small "something needs you" dot in its top-right
 * corner: a red disc with a light ring, so it reads on both light and dark
 * taskbars and menu bars. `bitmap` is Electron's premultiplied BGRA, `width`
 * by `height`; the alpha of the dot's pixels is blended, never overwritten,
 * so the eye underneath keeps its antialiasing. */
export function addAttentionDot(bitmap: Buffer, width: number, height: number): Buffer {
  const result = Buffer.from(bitmap)
  const size = Math.min(width, height)
  const radius = Math.max(2.5, size * 0.22)
  const cx = width - radius - Math.max(0.5, size * 0.03)
  const cy = radius + Math.max(0.5, size * 0.03)
  const ring = Math.max(1, size * 0.06)
  const fill = [0x4d, 0x48, 0xe5]   // B, G, R of #e5484d
  const rim = [0xf2, 0xf2, 0xf2]
  for (let y = Math.max(0, Math.floor(cy - radius - 1)); y < Math.min(height, Math.ceil(cy + radius + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius - 1)); x < Math.min(width, Math.ceil(cx + radius + 1)); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - d))
      if (!coverage) continue
      const colour = d > radius - ring ? rim : fill
      const at = (y * width + x) * 4
      for (let c = 0; c < 3; c++) result[at + c] = Math.round(colour[c]! * coverage + result[at + c]! * (1 - coverage))
      result[at + 3] = Math.round(255 * coverage + result[at + 3]! * (1 - coverage))
    }
  }
  return result
}
