// Read dependencies in place; put generated renderer bundles in the assigned C scope.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const [mode, depsArg, outArg] = process.argv.slice(2)
assert.ok(['red', 'green'].includes(mode) && depsArg && outArg,
  'usage: node tools/rig/shared-scratch-check.mjs red|green <existing-deps-root> <fresh-assigned-C-output>')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i)
assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use an empty output directory')
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')
const base = 'b3791bb9fdd227a470ba2c31addc463865a31cfc'
const controls = new Map()
if (mode === 'red') for (const relative of [
  'apps/desktop/renderer/src/scratch-folder.ts',
  'apps/desktop/renderer/src/canvas/agentmenu.tsx',
  'apps/desktop/renderer/src/canvas/cards.tsx',
  'apps/desktop/renderer/src/canvas/OrgCanvas.tsx',
  'apps/desktop/renderer/src/App.tsx',
]) {
  const source = spawnSync('git', ['show', `${base}:${relative}`], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(source.status, 0, source.stderr)
  controls.set(path.resolve(root, relative), source.stdout)
}
fs.mkdirSync(out, { recursive: true })
const output = path.join(out, 'shared-scratch-folder.test.mjs')
try {
  await esbuild.build({
    entryPoints: [path.join(root, 'apps/desktop/renderer/tests/shared-scratch-folder.test.tsx')],
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', jsx: 'automatic',
    nodePaths: [path.join(deps, 'node_modules')], logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"development"', __SRC_DIR__: JSON.stringify(path.join(root, 'apps/desktop/renderer/src')) },
    banner: { js: `import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(deps, 'package.json'))});` },
    plugins: [{ name: 'existing-deps-and-scoped-scratch-control', setup(build) {
      build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true }))
      if (mode === 'red') build.onLoad({ filter: /\.[tj]sx?$/ }, args => {
        const contents = controls.get(path.resolve(args.path))
        if (contents !== undefined) return { contents, loader: args.path.endsWith('tsx') ? 'tsx' : 'ts', resolveDir: path.dirname(args.path) }
      })
    } }],
  })
} finally { esbuild.stop() }
console.log(JSON.stringify({ mode, base, suite: 'shared-scratch-folder', sourceOnly: true }))
const result = spawnSync(process.execPath, ['--max-old-space-size=768', '--test', '--test-force-exit',
  '--test-concurrency=1', '--test-timeout=15000', output], { cwd: root, stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
