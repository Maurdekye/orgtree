import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('locked seed carries engine placeholder without claiming runtime parity', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(manifest.main, 'dist/main/index.cjs')
  assert.equal(manifest.devDependencies.electron, '44.2.0')
  assert.match(await readFile('engine/README.md', 'utf8'), /no copied or running v1 engine/)
})
