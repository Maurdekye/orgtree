import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function descendant(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

function plainAncestors(target) {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current)
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'test output cannot use linked or non-directory ancestors: ' + current)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (path.dirname(current) === current) return
  }
}

// Overrides choose a parent, never a reusable bundle/fixture leaf. Ordinary
// node --test needs no output variables; a runner can set TEMP/TMP to its scope.
export function testOutput(variable, prefix, env = process.env) {
  assert.match(prefix, /^[a-z0-9-]+-$/i)
  const override = env[variable]
  let parent
  if (override !== undefined) {
    assert.equal(typeof override, 'string')
    assert.ok(override.trim() && path.isAbsolute(override), variable + ' must be an absolute owner-output directory')
    assert.match(env.ORGTREE_AGENT || '', /^[a-z0-9][a-z0-9-]*$/i, 'output overrides require ORGTREE_AGENT')
    assert.ok(!override.split(/[\\/]/).includes('..'), 'test output cannot traverse parents')
    const owner = path.resolve('C:/orgtree-build', env.ORGTREE_AGENT)
    parent = path.resolve(override)
    assert.ok(descendant(owner, parent), variable + ' must be below the current ORGTREE_AGENT build scope')
    plainAncestors(parent)
    fs.mkdirSync(parent, { recursive: true })
    plainAncestors(parent)
    assert.ok(descendant(fs.realpathSync(owner), fs.realpathSync(parent)), 'canonical owner-output scope mismatch')
  } else {
    // Resolve platform temp aliases (e.g. /var on macOS) before allocating.
    parent = fs.realpathSync(os.tmpdir())
    plainAncestors(parent)
  }
  const canonicalParent = fs.realpathSync(parent)
  const directory = fs.mkdtempSync(path.join(canonicalParent, prefix))
  const identity = fs.lstatSync(directory)
  let removed = false
  return {
    directory,
    cleanup() {
      if (removed) return
      plainAncestors(directory)
      assert.equal(fs.realpathSync(parent), canonicalParent, 'test output parent changed before cleanup')
      assert.ok(descendant(canonicalParent, fs.realpathSync(directory)), 'cleanup escaped its fresh output parent')
      const current = fs.lstatSync(directory)
      assert.equal(current.dev, identity.dev, 'test output directory was replaced')
      assert.equal(current.ino, identity.ino, 'test output directory was replaced')
      fs.rmSync(directory, { recursive: true, force: true })
      removed = true
    },
  }
}
