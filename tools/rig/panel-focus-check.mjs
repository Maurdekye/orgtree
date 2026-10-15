// The current panel suite against release4.3.0 focus behavior or this patch.
// Existing dependencies are read in place; generated bundles stay on C.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const [mode, depsArg, outArg] = process.argv.slice(2)
assert.ok(['red', 'green'].includes(mode) && depsArg && outArg,
  'usage: node tools/rig/panel-focus-check.mjs red|green <existing-deps-root> <fresh-assigned-C-output>')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i)
assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use an empty output directory')
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')
const base = 'f1eed040b98b435e9d85b94c9237536993afa34a'
const relative = 'apps/desktop/renderer/src/canvas/panelsteps.ts'
const control = spawnSync('git', ['show', `${base}:${relative}`], { cwd: root, encoding: 'utf8', windowsHide: true })
assert.equal(control.status, 0, control.stderr)
fs.mkdirSync(out, { recursive: true })
const output = path.join(out, 'panelsteps.test.mjs')
try {
  await esbuild.build({
    entryPoints: [path.join(root, 'apps/desktop/renderer/tests/panelsteps.test.tsx')],
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', jsx: 'automatic',
    nodePaths: [path.join(deps, 'node_modules')], logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"development"' },
    banner: { js: `import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(deps, 'package.json'))});` },
    plugins: [{ name: 'read-dependencies-and-release-focus-control', setup(build) {
      build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true }))
      if (mode === 'red') build.onLoad({ filter: /[\\/]canvas[\\/]panelsteps\.ts$/ }, args => ({
        contents: control.stdout, loader: 'ts', resolveDir: path.dirname(args.path),
      }))
    } }],
  })
} finally { esbuild.stop() }
console.log(JSON.stringify({ mode, base, suite: 'panelsteps', sourceOnly: true,
  focusControl: mode === 'red' ? 'exact release shared panelsteps helper' : 'current helper' }))
const result = spawnSync(process.execPath, ['--max-old-space-size=768', '--test', '--test-force-exit',
  '--test-concurrency=1', '--test-timeout=15000', output], { cwd: root, stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
