// Isolated fixture bundle/captures only, never the desktop application build.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const [depsArg, outArg, evidenceArg] = process.argv.slice(2)
assert.ok(depsArg && outArg && evidenceArg,
  'usage: node tools/rig/shared-scratch-visual.mjs <existing-deps-root> <fresh-assigned-C-output> <D-evidence>')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg), evidence = path.resolve(evidenceArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i)
assert.match(evidence.replaceAll('\\', '/'), /^D:\/orgtree-work\/.+/i)
assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use fresh output')
const require = createRequire(path.join(deps, 'package.json')), esbuild = require('esbuild')
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(path.join(out, 'tmp'), { recursive: true })
try {
  await esbuild.build({ entryPoints: [path.join(root, 'apps/desktop/renderer/tests/shared-scratch.visual.tsx')],
    outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', jsx: 'automatic',
    nodePaths: [path.join(deps, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.png': 'file', '.svg': 'file', '.jpg': 'file', '.woff': 'file', '.woff2': 'file' } })
} finally { esbuild.stop() }
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
const electron = path.join(deps, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env, TMP: path.join(out, 'tmp'), TEMP: path.join(out, 'tmp') }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(electron, [path.join(root, 'apps/desktop/renderer/tests/shared-scratch-capture.cjs'), out, evidence],
  { env, windowsHide: true, timeout: 60000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.error) throw result.error
assert.equal(result.status, 0, 'capture child must exit successfully')
const receipt = JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'), 'utf8'))
assert.equal(receipt.passed, true, 'capture result must report success')
assert.deepEqual(receipt.receipts.map(r => r.entry), ['agent', 'switchboard', 'settings'],
  'all three capture entries must finish')
for (const entry of ['agent', 'switchboard', 'settings']) {
  assert.ok(fs.statSync(path.join(evidence, `${entry}.png`)).size > 0,
    `${entry} capture must be non-empty`)
}
