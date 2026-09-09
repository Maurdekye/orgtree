import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
function firstFramePixels(ico) {
  const at = 6
  const offset = ico.readUInt32LE(at + 12), length = ico.readUInt32LE(at + 8)
  const png = ico.subarray(offset, offset + length)
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
  let cursor = 8, compressed = Buffer.alloc(0)
  while (cursor < png.length) {
    const size = png.readUInt32BE(cursor), type = png.subarray(cursor + 4, cursor + 8).toString('ascii')
    if (type === 'IDAT') compressed = Buffer.concat([compressed, png.subarray(cursor + 8, cursor + 8 + size)])
    cursor += 12 + size
  }
  const raw = zlib.inflateSync(compressed), stride = width * 4 + 1
  const pixel = (x, y) => raw.subarray(1 + y * stride + x * 4, 1 + y * stride + x * 4 + 4)
  return { center: pixel(Math.floor(width / 2), Math.floor(height / 2)), iris: pixel(Math.floor(width / 2), Math.floor(height * .34)) }
}

test('the overseer eye source is orange and transparent outside the silhouette', () => {
  const svg = read('apps/desktop/assets/orgtree-eye.svg')
  assert.match(svg, /viewBox="0 0 256 256"/)
  assert.match(svg, /fill="#F58220"/)
  assert.match(svg, /<path fill="#F58220"/)
  assert.match(svg, /<circle cx="128" cy="128" r="57" fill="#18232D"\/>/)
  assert.doesNotMatch(svg, /<rect[^>]+fill=/)
})

test('Windows ICO contains all required crisp PNG sizes', () => {
  const ico = fs.readFileSync(path.join(root, 'apps/desktop/assets/orgtree-eye.ico'))
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field')
  assert.equal(ico.readUInt16LE(2), 1, 'ICO image type')
  const count = ico.readUInt16LE(4)
  assert.equal(count, 7)
  const sizes = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    sizes.push(ico[at] || 256)
    assert.equal(ico.readUInt16LE(at + 6), 32, '32-bit RGBA frame')
    const offset = ico.readUInt32LE(at + 12), length = ico.readUInt32LE(at + 8)
    assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a', 'PNG frame')
    assert.ok(offset + length <= ico.length, 'frame lies inside ICO')
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256])
})

test('runtime eye variants contain the same crisp Windows frames', () => {
  const names = ['grey', 'orgtree', 'claude', 'codex', 'antigravity', 'openrouter']
  const icons = names.map(name => fs.readFileSync(path.join(root, `apps/desktop/assets/orgtree-eye-tray-${name}.ico`)))
  for (const ico of icons) {
    assert.equal(ico.readUInt16LE(0), 0)
    assert.equal(ico.readUInt16LE(2), 1)
    assert.equal(ico.readUInt16LE(4), 7)
    for (let i = 0; i < 7; i++) {
      const at = 6 + i * 16, offset = ico.readUInt32LE(at + 12), length = ico.readUInt32LE(at + 8)
      assert.equal(ico.readUInt16LE(at + 6), 32)
      assert.equal(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a')
      assert.ok(offset + length <= ico.length)
    }
  }
  assert.equal(new Set(icons.map(icon => icon.toString('hex'))).size, names.length, 'each runtime state/theme has its own color')
  for (const icon of icons) {
    const { center, iris } = firstFramePixels(icon)
    assert.notDeepEqual([...center], [...iris], 'runtime eye keeps a contrasting internal iris')
  }
})

test('packaging, renderer, tray and windows reference the eye icons', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.build.icon, 'apps/desktop/assets/orgtree-eye.ico')
  assert.ok(pkg.build.files.includes('apps/desktop/assets/**/*'))
  assert.equal(pkg.build.nsis.createStartMenuShortcut, true)
  assert.equal(pkg.build.nsis.shortcutName, 'Orgtree')
  assert.equal(pkg.build.nsis.menuCategory, 'Orgtree')
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /app\.isPackaged\s*\?\s*path\.join\(process\.resourcesPath, 'runtime-icons'\)/)
  assert.match(main, /path\.join\(app\.getAppPath\(\), 'apps\/desktop\/assets'\)/)
  assert.match(main, /const iconPath = path\.join\(assetsPath, 'orgtree-eye\.ico'\)/)
  assert.match(main, /new Tray\(runtimeIcon\(\)\)/)
  assert.match(main, /engine\.status\.state === 'ready'/)

  assert.match(main, /engine\.on\('status',[^\r\n]*rebuildTray\(\)/)
  assert.match(main, /tray\?\.setImage\(image\)/)
  assert.match(main, /window\.setIcon\(image\)/)
  for (const name of ['grey', 'orgtree', 'claude', 'codex', 'antigravity', 'openrouter']) assert.match(main, new RegExp(`orgtree-eye-tray-${name}\\.ico`))
  assert.equal((main.match(/icon: iconPath/g) ?? []).length, 2, 'main and viewer windows')
  assert.ok((main.match(/\.setIcon\(runtimeIcon\(\)\)/g) ?? []).length >= 2, 'main and viewer windows start with runtime icon')
  assert.deepEqual(pkg.build.extraResources.at(-1), { from: 'apps/desktop/assets', to: 'runtime-icons', filter: ['orgtree-eye*.ico'] })
  assert.match(read('apps/desktop/renderer/index.html'), /href="\/assets\/orgtree-eye\.svg"/)
  assert.match(read('tools/build.mjs'), /copyFileSync\('apps\/desktop\/assets\/orgtree-eye\.svg', 'dist\/renderer\/assets\/orgtree-eye\.svg'\)/)
})
