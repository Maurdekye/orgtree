import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// Keep conversion dependency-free: the SVG remains the source of truth and this
// small rasterizer creates the Windows ICO frames used by Electron/electron-builder.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const root = path.resolve(import.meta.dirname, '..')
const outputDirectory = path.join(root, 'apps/desktop/assets')
const orange = [245, 130, 32]
const pupil = [24, 35, 45]
const trayColors = {
  grey: [127, 135, 148],
  orgtree: [182, 189, 200],
  claude: [217, 119, 87],
  codex: [34, 196, 189],
  antigravity: [117, 165, 255],
  openrouter: [182, 154, 250],
}

const eyePolygon = (() => {
  const points = []
  const cubic = (p0, p1, p2, p3, includeStart = true) => {
    for (let i = includeStart ? 0 : 1; i <= 32; i++) {
      const t = i / 32, u = 1 - t
      points.push([
        p0[0] * u ** 3 + p1[0] * 3 * u ** 2 * t + p2[0] * 3 * u * t ** 2 + p3[0] * t ** 3,
        p0[1] * u ** 3 + p1[1] * 3 * u ** 2 * t + p2[1] * 3 * u * t ** 2 + p3[1] * t ** 3,
      ])
    }
  }
  cubic([10, 128], [39, 78], [82, 48], [128, 48])
  cubic([128, 48], [174, 48], [217, 78], [246, 128], false)
  cubic([246, 128], [217, 178], [174, 208], [128, 208], false)
  cubic([128, 208], [82, 208], [39, 178], [10, 128], false)
  return points
})()

function insideEye(x, y) {
  let hit = false
  for (let i = 0, j = eyePolygon.length - 1; i < eyePolygon.length; j = i++) {
    const [xi, yi] = eyePolygon[i], [xj, yj] = eyePolygon[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function pixel(size, x, y, color, center = color) {
  const scale = 4
  const samples = []
  for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
    const vx = (x + (sx + .5) / scale) * 256 / size
    const vy = (y + (sy + .5) / scale) * 256 / size
    if (!insideEye(vx, vy)) { samples.push([0, 0, 0, 0]); continue }
    const dx = vx - 128, dy = vy - 128, r = Math.hypot(dx, dy)
    samples.push(r <= 57 ? (r <= 25 ? [...center, 255] : [...color, 255]) : [...color, 255])
  }
  const alpha = samples.reduce((sum, sample) => sum + sample[3], 0) / samples.length
  const rgb = samples.reduce((sum, sample) => sample[3] ? sum.map((v, i) => v + sample[i]) : sum, [0, 0, 0]).map(v => Math.round(v / (samples.filter(s => s[3]).length || 1)))
  return [...rgb, Math.round(alpha)]
}

function crc32(buffer) {
  let crc = 0xFFFFFFFF
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1)) }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data])
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

function png(size, color, center = color) {
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); row[0] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(size, x, y, color, center); const offset = 1 + x * 4
      row[offset] = r; row[offset + 1] = g; row[offset + 2] = b; row[offset + 3] = a
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

function writeIcon(filename, color, center = color) {
  const frames = sizes.map(size => png(size, color, center))
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4)
  const entries = Buffer.alloc(frames.length * 16); let offset = 6 + entries.length
  for (let i = 0; i < frames.length; i++) {
    const size = sizes[i], frame = frames[i], at = i * 16
    entries[at] = size === 256 ? 0 : size; entries[at + 1] = size === 256 ? 0 : size; entries[at + 2] = 0; entries[at + 3] = 0
    entries.writeUInt16LE(1, at + 4); entries.writeUInt16LE(32, at + 6); entries.writeUInt32LE(frame.length, at + 8); entries.writeUInt32LE(offset, at + 12); offset += frame.length
  }
  const output = path.join(outputDirectory, filename)
  fs.writeFileSync(output, Buffer.concat([header, entries, ...frames]))
  console.log(`wrote ${output} (${sizes.join(', ')}px PNG frames)`)
}

// The orange artwork remains the static app/installer icon. Tray and window
// icons are monochrome variants so their state and the saved visual theme can
// change without recoloring pixels in Electron's platform-specific bitmap.
writeIcon('orgtree-eye.ico', orange, pupil)
for (const [name, color] of Object.entries(trayColors)) writeIcon(`orgtree-eye-tray-${name}.ico`, color)
