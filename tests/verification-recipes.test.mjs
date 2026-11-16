import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const recipes = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'verification-recipes.json'), 'utf8'))

test('recipe metadata names real runners and resolves its symbolic candidate', () => {
  assert.equal(recipes.schema, 'orgtree.verification-recipes/v1')
  assert.equal(recipes.candidate_ref, 'HEAD', 'recipe metadata must use the symbolic checkout target')
  const resolved = execFileSync('git', ['rev-parse', '--verify', `${recipes.candidate_ref}^{commit}`], { cwd: ROOT, encoding: 'utf8' }).trim()
  assert.match(resolved, /^[0-9a-f]{40}$/)
  assert.equal(recipes.candidate, undefined, 'the recipe must not claim a literal SHA pins its containing commit')
  assert.equal(recipes.owner, 'notify-review')
  assert.ok(recipes.suites.length >= 4) // 4.6.1: the Python backend suite was retired
  for (const suite of recipes.suites) {
    assert.ok(suite.area)
    assert.ok(suite.runner)
    assert.ok(suite.command)
    assert.ok(suite.covers)
  }
  assert.ok(recipes.suites.some(suite => suite.area === 'root'))
  assert.ok(recipes.suites.some(suite => suite.area === 'renderer'))
  assert.ok(recipes.suites.some(suite => suite.area === 'native'))
  assert.ok(!recipes.suites.some(suite => suite.area === 'backend'), 'the Python backend suite was retired in 4.6.1')
  assert.ok(recipes.suites.some(suite => suite.area === 'quality guards'))
})

test('metadata records no-op controls and every omitted check explicitly', () => {
  assert.ok(recipes.controls.some(control => /no.?op/i.test(control.name) && control.negative_control))
  assert.ok(recipes.skipped.length >= 3)
  for (const item of recipes.skipped) {
    assert.ok(['skipped', 'unexecuted'].includes(item.status))
    assert.ok(item.reason)
  }
  // 4.6.1: the Python receipt tool is retired, and the recipe says so rather
  // than naming a file that no longer exists.
  assert.equal(recipes.handoff.receipt_tool, null)
  assert.match(recipes.handoff.receipt_tool_retired, /4\.6\.1/)
  for (const entry of [...recipes.suites, ...recipes.guards, ...recipes.controls]) {
    assert.doesNotMatch(JSON.stringify(entry), /\.py\b|python /, `no recipe may name a Python command: ${entry.command}`)
  }
})

test('recipe command paths point at files in this checkout', () => {
  const paths = [
    'tests/notifications.test.mjs', 'tests/taskbarattention.test.mjs',
    'tests/icon-assets.test.mjs', 'apps/desktop/renderer/tests/run.mjs',
    'tools/test-popout-header-regions.mjs', 'tools/test-taskbar-native.mjs',
  ]
  for (const relative of paths) {
    if (relative.startsWith('tests.test_')) continue
    assert.ok(fs.existsSync(path.join(ROOT, relative)), `missing recipe path: ${relative}`)
  }
})
