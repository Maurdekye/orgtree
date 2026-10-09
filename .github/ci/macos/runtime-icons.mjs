// macOS runtime icons: Electron there cannot read .ico, so the desktop loads
// PNGs with the same base names (resources/runtime-icons). The menu bar wants
// 16 pt images, so each .ico's 16 px PNG frame becomes <name>.png and its
// 32 px frame <name>@2x.png (Electron picks the @2x file on Retina screens).
// Usage: node runtime-icons.mjs <assets dir> <output dir>
import fs from 'node:fs'
import path from 'node:path'

const [source, output] = process.argv.slice(2)
if (!source || !output) throw new Error('usage: runtime-icons.mjs <assets dir> <output dir>')

function pngFrame(ico, size) {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('not an .ico file')
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + 16 * i
    const width = ico[entry] || 256
    const bytes = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12)
    const frame = ico.subarray(offset, offset + bytes)
    if (width === size && frame.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return frame
  }
  throw new Error(`no ${size}px PNG frame`)
}

fs.mkdirSync(output, { recursive: true })
const icons = fs.readdirSync(source).filter(name => /^orgtree-eye.*\.ico$/.test(name))
if (!icons.length) throw new Error(`no orgtree-eye*.ico in ${source}`)
for (const name of icons) {
  const ico = fs.readFileSync(path.join(source, name))
  const base = path.join(output, name.slice(0, -4))
  fs.writeFileSync(base + '.png', pngFrame(ico, 16))
  fs.writeFileSync(base + '@2x.png', pngFrame(ico, 32))
  console.log(`${name} -> ${path.basename(base)}.png, @2x.png`)
}
