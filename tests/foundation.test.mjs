import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('desktop manifest preserves runtime entry and original source license', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(manifest.main, 'dist/main/index.cjs')
  assert.equal(manifest.devDependencies.electron, '44.2.0')
  assert.match(await readFile('LICENSE', 'utf8'), /Maurdekye/)
  assert.equal(manifest.build.nsis.perMachine, false)
})
