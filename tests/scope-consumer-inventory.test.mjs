import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { root, scan, scanText, validate } from '../tools/scope-consumer-inventory.mjs'

test('every renderer scope source has an explicit classification', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tools/scope-consumers-renderer.json'), 'utf8'))
  const matches = scan()
  assert.ok(matches.length >= 20)
  assert.deepEqual(validate(matches, manifest.entries), [])
})
test('new optional alias and repeated scope source fail the inventory', () => {
  const original = scanText('const saved = node?.scope', 'fixture.ts')
  const entry = { ...original[0], classification: 'effective', reason: 'fixture display body' }
  const changed = scanText('const saved = node?.scope; const another = node?.scope', 'fixture.ts')
  assert.match(validate(changed, [entry])[0], /unclassified expression \(1\)/)
  assert.equal(scanText('// node.scope\nconst text = "node.scope"', 'fixture.ts').length, 0)
})
test('a configured editor alias needs its own explanation', () => {
  const matches = scanText('const edit = node["configured_scope"]', 'fixture.ts')
  const entry = { ...matches[0], classification: 'configured', reason: 'saved editor values' }
  assert.deepEqual(validate(matches, [entry]), [])
  assert.match(validate(matches, [{ ...entry, reason: '' }])[0], /incomplete classification/)
  assert.match(validate([], [entry])[0], /stale classification/)
})
