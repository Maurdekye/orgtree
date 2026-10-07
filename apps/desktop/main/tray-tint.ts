// tools/generate-icon.mjs produces the neutral tray from these two layers.
const ACCENT_BGR = [200, 189, 182] as const
const IRIS_BGR = [45, 35, 24] as const
const DIFFERENCE = ACCENT_BGR.map((value, channel) => value - IRIS_BGR[channel]!)
const LENGTH_SQUARED = DIFFERENCE.reduce((sum, value) => sum + value * value, 0)

/** Tint only the neutral eye's accent, retaining its dark iris and the mixed
 * pixels at the iris boundary. Electron bitmaps use premultiplied BGRA.
 * Partly transparent pixels are on the outer accent silhouette; the iris
 * sits entirely inside its opaque interior. Alpha is never changed. */
export function tintTrayBitmap(bitmap: Buffer, hex: string): Buffer {
  const result = Buffer.from(bitmap)
  const color = [5, 3, 1].map(at => parseInt(hex.slice(at, at + 2), 16))
  for (let at = 0; at < result.length; at += 4) {
    const alpha = result[at + 3]! / 255
    if (!alpha) continue
    const accent = alpha < 1 ? 1 : Math.max(0, Math.min(1,
      DIFFERENCE.reduce((sum, delta, channel) => sum + (bitmap[at + channel]! - IRIS_BGR[channel]!) * delta, 0) / LENGTH_SQUARED))
    for (let channel = 0; channel < 3; channel++)
      result[at + channel] = Math.round(alpha * (IRIS_BGR[channel]! + accent * (color[channel]! - IRIS_BGR[channel]!)))
  }
  return result
}
