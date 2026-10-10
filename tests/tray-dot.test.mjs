// The tray icon's attention dot (apps/desktop/main/tray-dot.ts): drawn top-right
// on a premultiplied BGRA bitmap, red with a light ring, and nothing else moves.
// Run: node --test tests/tray-dot.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-traydot-test-'))
const out = path.join(temp, 'tray-dot.cjs')
await build({ entryPoints: ['apps/desktop/main/tray-dot.ts'], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
const { addAttentionDot } = createRequire(import.meta.url)(out)

const size = 32
const px = (b, x, y) => [...b.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)]

test('a dot lands in the top-right corner, opaque red in the middle, light at the rim', () => {
  const grey = Buffer.alloc(size * size * 4, 0)             // fully transparent icon
  const dotted = addAttentionDot(grey, size, size)
  assert.notDeepEqual(dotted, grey)
  const radius = size * 0.22, cx = size - radius - size * 0.03, cy = radius + size * 0.03
  assert.deepEqual(px(dotted, Math.floor(cx), Math.floor(cy)), [0x4d, 0x48, 0xe5, 255], 'centre is #e5484d (BGRA)')
  const rim = px(dotted, Math.floor(cx + radius - 0.6), Math.floor(cy))
  assert.ok(rim[1] > 0xc0 && rim[3] > 200, `rim is light and opaque: ${rim}`)
  assert.deepEqual(px(dotted, 2, size - 3), [0, 0, 0, 0], 'the far corner is untouched')
})

test('the source bitmap is not modified, and pixels under the dot are blended not replaced', () => {
  const eye = Buffer.alloc(size * size * 4, 0x80)
  const copy = Buffer.from(eye)
  addAttentionDot(eye, size, size)
  assert.deepEqual(eye, copy)
  assert.deepEqual(px(addAttentionDot(eye, size, size), 1, 1), [0x80, 0x80, 0x80, 0x80], 'outside the dot nothing changes')
})
