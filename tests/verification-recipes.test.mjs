import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const recipes = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'verification-recipes.json'), 'utf8'))

test('recipe metadata names real runners and a pinned candidate', () => {
  assert.equal(recipes.schema, 'orgtree.verification-recipes/v1')
  assert.match(recipes.candidate, /^[0-9a-f]{40}$/)
  assert.equal(recipes.owner, 'notify-review')
  assert.ok(recipes.suites.length >= 5)
  for (const suite of recipes.suites) {
    assert.ok(suite.area)
    assert.ok(suite.runner)
    assert.ok(suite.command)
    assert.ok(suite.covers)
  }
  assert.ok(recipes.suites.some(suite => suite.area === 'root'))
  assert.ok(recipes.suites.some(suite => suite.area === 'renderer'))
  assert.ok(recipes.suites.some(suite => suite.area === 'native'))
  assert.ok(recipes.suites.some(suite => suite.area === 'backend'))
  assert.ok(recipes.suites.some(suite => suite.area === 'quality guards'))
})

test('metadata records no-op controls and every omitted check explicitly', () => {
  assert.ok(recipes.controls.some(control => /no.?op/i.test(control.name) && control.negative_control))
  assert.ok(recipes.skipped.length >= 3)
  for (const item of recipes.skipped) {
    assert.ok(['skipped', 'unexecuted'].includes(item.status))
    assert.ok(item.reason)
  }
  assert.equal(recipes.handoff.receipt_tool, 'tools/verification-receipt.py')
})

test('recipe command paths point at files in this checkout', () => {
  const paths = [
    'tests/notifications.test.mjs', 'tests/taskbarattention.test.mjs',
    'tests/icon-assets.test.mjs', 'apps/desktop/renderer/tests/run.mjs',
    'tools/test-popout-header-regions.mjs', 'tools/test-taskbar-native.mjs',
    'tests.test_work_evidence_receipts', 'tests.test_python_verification_runner',
    'tests/acceptance/isolation.mjs',
  ]
  for (const relative of paths) {
    if (relative.startsWith('tests.test_')) continue
    assert.ok(fs.existsSync(path.join(ROOT, relative)), `missing recipe path: ${relative}`)
  }
})
