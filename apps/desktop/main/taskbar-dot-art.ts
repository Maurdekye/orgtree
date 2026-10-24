import { deflateSync } from 'node:zlib'

const RED = [0xe5, 0x48, 0x4d] as const
const RIM = [0xf2, 0xf2, 0xf2] as const
const SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const

/** USER 2026-10-24: match Hubchat's taskbar dot, including its light rim.
 * Hubchat taskbar_dot.rs at 66138d4 supplies the 16px geometry and coverage;
 * keep that geometry proportional at each physical DPI. PNG is straight RGBA. */
function rgba(size: number): Buffer {
  if (!Number.isInteger(size) || size < 8 || size > 256) throw new Error('Invalid taskbar dot size')
  const pixels = Buffer.alloc(size * size * 4), scale = size / 16, center = size / 2, radius = 7 * scale
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center)
    const alpha = Math.round(255 * Math.max(0, Math.min(1, radius + 0.5 - distance)))
    const colour = distance > radius - 1.5 * scale ? RIM : RED
    const at = (y * size + x) * 4
    if (alpha) { pixels[at] = colour[0]; pixels[at + 1] = colour[1]; pixels[at + 2] = colour[2]; pixels[at + 3] = alpha }
  }
  return pixels
}

/** Electron's raw bitmap format is premultiplied BGRA. Transparent pixels
 * are zero; colour and coverage come from the same raster as the PNG. */
export function taskbarDotBitmap(size = 16): Buffer {
  const pixels = rgba(size), bitmap = Buffer.alloc(pixels.length)
  for (let at = 0; at < pixels.length; at += 4) {
    const alpha = pixels[at + 3]
    bitmap[at] = Math.round(pixels[at + 2] * alpha / 255)
    bitmap[at + 1] = Math.round(pixels[at + 1] * alpha / 255)
    bitmap[at + 2] = Math.round(pixels[at] * alpha / 255)
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
