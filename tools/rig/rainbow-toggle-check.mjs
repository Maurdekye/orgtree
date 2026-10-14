// Run inside rig-sol's machine lock / kernel Job. No source/dependency junctions.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const [mode, depsArg, outArg] = process.argv.slice(2)
if (!['red', 'green'].includes(mode) || !depsArg || !outArg) {
  throw Error('Usage: node tools/rig/rainbow-toggle-check.mjs red|green <dependency-root> <assigned-C-output>')
}
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i)
assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use an empty output directory')
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')
const base = '7eb572a153ac44bb3104ffcea93c399ffa2dc0c3'
const themeFile = 'apps/desktop/renderer/src/themes.tsx'
const old = spawnSync('git', ['show', `${base}:${themeFile}`], { cwd: root, encoding: 'utf8', windowsHide: true })
assert.equal(old.status, 0, old.stderr)
const normalize = s => s.replaceAll('\r\n', '\n')
const before = normalize(old.stdout), after = normalize(fs.readFileSync(path.join(root, themeFile), 'utf8'))
assert.equal(after, before.replace('{rainbow.revealed && <SetToggle', '{rainbow.revealed && isCustomTheme(theme) && <SetToggle'),
  'only the assigned Rainbow render gate changes')
fs.mkdirSync(out, { recursive: true })
const suites = ['rainbowsetting', 'customtheme']
try {
  for (const name of suites) {
    await esbuild.build({
      entryPoints: [path.join(root, 'apps/desktop/renderer/tests', `${name}.test.tsx`)],
      outfile: path.join(out, `${name}.test.mjs`), bundle: true, platform: 'node', format: 'esm',
      target: 'node22', jsx: 'automatic', nodePaths: [path.join(deps, 'node_modules')], logLevel: 'warning',
      define: { 'process.env.NODE_ENV': '"development"' },
      banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(deps, 'package.json'))});` },
      plugins: [{ name: 'existing-deps-and-base-control', setup(build) {
        build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true }))
        if (mode === 'red') build.onLoad({ filter: /[\\/]src[\\/]themes\.tsx$/ }, () => ({
          contents: before, loader: 'tsx', resolveDir: path.join(root, 'apps/desktop/renderer/src'),
        }))
      } }],
    })
  }
} finally { esbuild.stop() }
console.log(JSON.stringify({ mode, base, suites, sourceOnly: true, output: out,
  control: mode === 'red' ? 'tip tests with exact base themes.tsx' : 'tip tests with tip source' }))
const run = spawnSync(process.execPath, ['--max-old-space-size=768', '--test', '--test-concurrency=1',
  '--test-timeout=10000', ...suites.map(name => path.join(out, `${name}.test.mjs`))],
  { cwd: root, stdio: 'inherit', windowsHide: true })
if (run.error) throw run.error
process.exitCode = run.status ?? 1
