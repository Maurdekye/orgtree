import { deflateSync } from 'node:zlib'

const RED = [0xe5, 0x48, 0x4d] as const
const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const

/** A standalone circle, without the tray icon's intentional white rim.
 * Sample coverage at each physical resolution; PNG stores straight RGBA. */
function rgba(size: number): Buffer {
  if (!Number.isInteger(size) || size < 8 || size > 256) throw new Error('Invalid taskbar dot size')
  const pixels = Buffer.alloc(size * size * 4), samples = 8, center = size / 2, radius = size * 7 / 16
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let covered = 0
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const dx = x + (sx + 0.5) / samples - center, dy = y + (sy + 0.5) / samples - center
      if (dx * dx + dy * dy <= radius * radius) covered++
    }
    const at = (y * size + x) * 4, alpha = Math.round(255 * covered / (samples * samples))
    if (alpha) { pixels[at] = RED[0]; pixels[at + 1] = RED[1]; pixels[at + 2] = RED[2]; pixels[at + 3] = alpha }
  }
  return pixels
}

/** Electron's raw bitmap format is premultiplied BGRA. Transparent pixels
 * are zero; every partially covered pixel has the same unassociated red. */
export function taskbarDotBitmap(size = 16): Buffer {
  const pixels = rgba(size), bitmap = Buffer.alloc(pixels.length)
  for (let at = 0; at < pixels.length; at += 4) {
    const alpha = pixels[at + 3]
    bitmap[at] = Math.round(RED[2] * alpha / 255)
    bitmap[at + 1] = Math.round(RED[1] * alpha / 255)
    bitmap[at + 2] = Math.round(RED[0] * alpha / 255)
    bitmap[at + 3] = alpha
  }
  return bitmap
}

function chunk(kind: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(kind), data])
  let crc = 0xffffffff
  for (const byte of payload) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const size = Buffer.alloc(4), sum = Buffer.alloc(4)
  size.writeUInt32BE(data.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([size, payload, sum])
}

function png(size: number): Buffer {
  const pixels = rgba(size), rows = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

interface DotImage { addRepresentation(options: { scaleFactor: number; dataURL: string }): void }
/** Let Electron decode PNG alpha once, and give native consumers the actual
 * physical raster for common Windows DPI scales instead of upscaling 16px. */
export function taskbarDotImage<Image extends DotImage>(images: {
  createFromBuffer(buffer: Buffer, options: { scaleFactor: number }): Image
}): Image {
  const image = images.createFromBuffer(png(16), { scaleFactor: 1 })
  for (const scaleFactor of SCALES.slice(1)) image.addRepresentation({
    scaleFactor, dataURL: 'data:image/png;base64,' + png(16 * scaleFactor).toString('base64'),
  })
  return image
}
