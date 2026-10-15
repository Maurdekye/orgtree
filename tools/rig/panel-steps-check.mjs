// Source-only mounted panel regression. Read existing dependencies in place;
// all generated output stays in the rig's explicitly assigned C directory.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const [mode, depsArg, outArg] = process.argv.slice(2)
assert.ok((mode === 'red' || mode === 'green') && depsArg && outArg,
  'usage: node tools/rig/panel-steps-check.mjs red|green <existing-dependency-root> <assigned-C-output>')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i)
assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use an empty output directory')
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')
const base = '72ea305a4718655c7c0ea123edfe187e97afe393'
const sources = ['gallery.tsx', 'docket.tsx'].map(file => 'apps/desktop/renderer/src/canvas/' + file)
const controls = new Map(sources.map(file => {
  const result = spawnSync('git', ['show', `${base}:${file}`], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  return [path.resolve(root, file).toLowerCase(), result.stdout]
}))
fs.mkdirSync(out, { recursive: true })
const output = path.join(out, 'panelsteps.test.mjs')
try {
  await esbuild.build({
    entryPoints: [path.join(root, 'apps/desktop/renderer/tests/panelsteps.test.tsx')],
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    jsx: 'automatic', nodePaths: [path.join(deps, 'node_modules')], logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"development"' },
    banner: { js: `import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(deps, 'package.json'))});` },
    plugins: [{ name: 'shared-dependencies-and-exact-base', setup(build) {
      build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true }))
      if (mode === 'red') build.onLoad({ filter: /[\\/]src[\\/]canvas[\\/](gallery|docket)\.tsx$/ }, args => ({
        contents: controls.get(path.resolve(args.path).toLowerCase()), loader: 'tsx', resolveDir: path.dirname(args.path),
      }))
    } }],
  })
} finally { esbuild.stop() }
console.log(JSON.stringify({ mode, base, sources, suite: 'panelsteps', sourceOnly: true,
  control: mode === 'red' ? 'exact base gallery and docket with current tests' : 'current source' }))
const result = spawnSync(process.execPath, ['--max-old-space-size=768', '--test', '--test-force-exit',
  '--test-concurrency=1', '--test-timeout=15000', output], { cwd: root, stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
