// resolve-packaged-python-path.test.mjs — the packaged interpreter path
// Engine.start gets pointed at, per platform. 01.03 shipped
// engine/runtime/python.exe unconditionally, so the packaged macOS app
// (interpreter actually at engine/runtime/bin/python3.13) threw "Python
// runtime is missing" on first launch. This asserts the resolved path SHAPE
// against a real fixture layout, not just "some file exists somewhere" —
// that gap is what let the original bug through.
//
// Run: node --test tests/resolve-packaged-python-path.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-resolve-python-'))
const outfile = path.join(temp, 'engine.cjs')
await build({ entryPoints: ['apps/desktop/main/engine.ts'], outfile, bundle: true, platform: 'node', format: 'cjs' })
const { resolvePackagedPythonPath } = createRequire(import.meta.url)(outfile)

function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  try { fn() } finally { Object.defineProperty(process, 'platform', original) }
}

function fixtureRoot(interpreterRelativePath) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-resolve-python-fixture-'))
  const interpreter = path.join(root, 'runtime', interpreterRelativePath)
  fs.mkdirSync(path.dirname(interpreter), { recursive: true })
  fs.writeFileSync(interpreter, '')
  return root
}

test('resolves to runtime/bin/python3.13 on darwin, matching the provisioned layout', () => {
  const root = fixtureRoot('bin/python3.13')
  try {
    withPlatform('darwin', () => {
      const resolved = resolvePackagedPythonPath(root)
      assert.equal(resolved, path.join(root, 'runtime', 'bin', 'python3.13'))
      assert.equal(fs.existsSync(resolved), true)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resolves to runtime/python.exe on win32, matching the provisioned layout', () => {
  const root = fixtureRoot('python.exe')
  try {
    withPlatform('win32', () => {
      const resolved = resolvePackagedPythonPath(root)
      assert.equal(resolved, path.join(root, 'runtime', 'python.exe'))
      assert.equal(fs.existsSync(resolved), true)
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
