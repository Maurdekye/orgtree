// Bundle the existing native test in the assigned C scope without copying deps.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
const [depsArg, outArg] = process.argv.slice(2)
assert.ok(depsArg && outArg, 'usage: node tools/rig/shared-scratch-native.mjs <existing-deps-root> <fresh-assigned-C-output>')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i)
assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use fresh output')
const require = createRequire(path.join(deps, 'package.json')), esbuild = require('esbuild')
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(path.join(out, 'tmp'), { recursive: true })
const test = path.join(out, 'scratch-folder.test.mjs'), helper = path.join(out, 'native-helper.cjs')
try {
  await esbuild.build({ entryPoints: [path.join(root, 'tests/scratch-folder.test.mjs')],
    outfile: test, bundle: true, platform: 'node', format: 'esm', nodePaths: [path.join(deps, 'node_modules')],
    plugins: [{ name: 'existing-esbuild', setup(build) {
      build.onResolve({ filter: /^esbuild$/ }, () => ({ path: pathToFileURL(require.resolve('esbuild')).href, external: true }))
    } }] })
  await esbuild.build({ entryPoints: [path.join(root, 'apps/desktop/main/scratch-folder.ts')],
    outfile: helper, bundle: true, platform: 'node', format: 'cjs' })
} finally { esbuild.stop() }
console.log(JSON.stringify({ suite: 'scratch-folder-native', proofBundle: helper }))
const result = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-concurrency=1', '--test-timeout=15000', test],
  { cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, TMP: path.join(out, 'tmp'), TEMP: path.join(out, 'tmp') } })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
