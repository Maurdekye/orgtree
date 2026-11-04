// The stall tooling's test-only busy hook (apps/desktop/renderer/src/stallfixture.ts) must exist ONLY in a fixture build.
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const bundle = async define => (await build({
  // the way main.tsx uses it: only installStallFixture is imported, so an unused export can be dropped
  stdin: { contents: "import { installStallFixture } from './stallfixture'; installStallFixture()", resolveDir: 'apps/desktop/renderer/src', loader: 'ts' },
  bundle: true, write: false, format: 'esm', minify: true, treeShaking: true, define, platform: 'browser',
})).outputFiles[0].text

test('a normal build carries no busy hook', async () => {
  const out = await bundle({ __ORGTREE_STALL_FIXTURE__: JSON.stringify('') })
  assert.ok(!out.includes('1500'), 'the spin is compiled out of a normal build: ' + out.slice(0, 200))
  assert.ok(!out.includes('desk-composer'), 'and so is the target selector')
})
test('a fixture build (ORGTREE_STALL_FIXTURE=busy) carries it', async () => {
  const out = await bundle({ __ORGTREE_STALL_FIXTURE__: JSON.stringify('busy') })
  assert.ok(out.includes('1500') && out.includes('desk-composer'))
})
