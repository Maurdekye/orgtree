import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('desktop manifest preserves runtime entry and original source license', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(manifest.main, 'dist/main/index.cjs')
  // 44.4.4+ keeps the GPU shaders Skia compiles between launches (electron/electron#54161); 44.2.0 recompiled them every
  // start, and a new desk waited 0.3 to 1.4 s on each (item hang-every-time-a-new-desk-loads-especially-whil)
  assert.equal(manifest.devDependencies.electron, '44.11.3')
  assert.match(await readFile('LICENSE', 'utf8'), /Maurdekye/)
  assert.equal(manifest.build.nsis.perMachine, false)
})
