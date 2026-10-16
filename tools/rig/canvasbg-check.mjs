// Canvas background themes (optional-canvas-background-in-the-flowing-ascii-a)
// source & renderer verification against 5efd8ae (red control) or tip (green).
// Existing dependencies are read in place from <deps>/node_modules; generated
// bundles and logs stay under C:/orgtree-build/<agent>/. No junctions or copies.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const [mode, depsArg, outArg, ...flags] = process.argv.slice(2)
assert.ok(['red', 'green'].includes(mode) && depsArg && outArg,
  'usage: node tools/rig/canvasbg-check.mjs red|green <existing-deps-root> <fresh-assigned-C-output> [--typecheck] [--neighbors]')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i,
  'output must be under C:/orgtree-build/<agent>/...')
assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use an empty output directory')
const modules = path.join(deps, 'node_modules')
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')

const BASE = '5efd8ae6287745bf38d5d1f05a15dfeff066fda0'
const CHANGED_TS = [
  'packages/contracts/canvas-background.ts',
  'apps/desktop/renderer/src/canvas/canvasbackground.tsx',
  'apps/desktop/renderer/src/canvas/asciigl.ts',
  'apps/desktop/renderer/src/canvas/asciifield.ts',
]
const gitShow = rel => {
  const r = spawnSync('git', ['show', `${BASE}:${rel}`], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}
const baseMap = mode === 'red'
  ? new Map(CHANGED_TS.map(f => [path.resolve(root, f).toLowerCase(), gitShow(f)]))
  : null

fs.mkdirSync(out, { recursive: true })
let srcDir = path.join(root, 'apps/desktop/renderer/src')
if (mode === 'red') {
  srcDir = path.join(out, 'red-src')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(path.join(srcDir, 'styles.css'), gitShow('apps/desktop/renderer/src/styles.css'))
}

const suites = ['canvasbg', 'canvasbg-setting', ...(flags.includes('--neighbors') ? ['agentstray', 'closemenu'] : [])]
try {
  for (const name of suites) {
    await esbuild.build({
      entryPoints: [path.join(root, `apps/desktop/renderer/tests/${name}.test.tsx`)],
      outfile: path.join(out, `${name}.test.mjs`),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      jsx: 'automatic',
      nodePaths: [modules],
      logLevel: 'warning',
      define: {
        'process.env.NODE_ENV': '"development"',
        __SRC_DIR__: JSON.stringify(srcDir),
      },
      banner: {
        js: `import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(deps, 'package.json'))});`,
      },
      plugins: [{
        name: 'existing-deps-and-base-control',
        setup(build) {
          build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true }))
          if (baseMap) {
            build.onLoad({ filter: /\.(tsx?|mts)$/ }, args => {
              const text = baseMap.get(path.resolve(args.path).toLowerCase())
              if (text === undefined) return undefined
              return { contents: text, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: path.dirname(args.path) }
            })
          }
        },
      }],
    })
  }
} finally {
  await esbuild.stop()
}

let typecheckStatus = null
if (flags.includes('--typecheck')) {
  const types = path.join(modules, '@types')
  const resolution = {
    typeRoots: [types],
    paths: {
      react: [path.join(types, 'react')], 'react/*': [path.join(types, 'react/*')],
      'react-dom': [path.join(types, 'react-dom')], 'react-dom/*': [path.join(types, 'react-dom/*')],
      '*': [path.join(modules, '*')],
    },
  }
  const tsc = path.join(modules, 'typescript/bin/tsc')
  const rootCfg = path.join(out, 'typecheck-root.json')
  fs.writeFileSync(rootCfg, JSON.stringify({
    extends: path.join(root, 'tsconfig.json'),
    compilerOptions: { ...resolution, types: ['node', path.join(modules, 'vite/client')] },
  }, null, 2))
  const rRoot = spawnSync(process.execPath, [tsc, '-p', rootCfg, '--noEmit'], { cwd: root, encoding: 'utf8', windowsHide: true })
  const renderer = path.join(root, 'apps/desktop/renderer')
  const strictCfg = path.join(out, 'typecheck-strict.json')
  fs.writeFileSync(strictCfg, JSON.stringify({
    extends: path.join(renderer, 'tests/tsconfig.json'),
    compilerOptions: { ...resolution, types: ['node', path.join(modules, 'vite/client')] },
    include: [
      path.join(root, 'packages/contracts/canvas-background.ts'),
      path.join(renderer, 'src/canvasbgpref.ts'),
      path.join(renderer, 'src/canvas/canvasbackground.tsx'),
      path.join(renderer, 'src/canvas/canvasbgsetting.tsx'),
      path.join(renderer, 'src/canvas/asciigl.ts'),
      path.join(renderer, 'src/canvas/asciifield.ts'),
      path.join(renderer, 'tests/canvasbg.test.tsx'),
      path.join(renderer, 'tests/canvasbg-setting.test.tsx'),
      path.join(renderer, 'tests/canvasbg-visual.tsx'),
    ],
    exclude: [],
  }, null, 2))
  const rStrict = spawnSync(process.execPath, [tsc, '-p', strictCfg, '--noEmit'], { cwd: root, encoding: 'utf8', windowsHide: true })
  const strictOut = (rStrict.stdout + rStrict.stderr).trim()
  const strictLines = strictOut ? strictOut.split(/\r?\n/).filter(l => /error TS\d+:/.test(l)) : []
  const strictTouchedErrors = strictLines.filter(l => /canvas-background|canvasbg|asciigl|asciifield/.test(l))
  typecheckStatus = {
    rootExit: rRoot.status,
    rootOut: (rRoot.stdout + rRoot.stderr).trim(),
    strictExit: rStrict.status,
    strictTotalDiagnostics: strictLines.length,
    strictTouchedDiagnostics: strictTouchedErrors.length,
    strictTouchedErrors,
    strictOut,
  }
  fs.writeFileSync(path.join(out, 'typecheck.json'), JSON.stringify(typecheckStatus, null, 2))
}

console.log(JSON.stringify({
  mode, base: BASE, suites, sourceOnly: true,
  control: mode === 'red' ? 'tip tests against exact 5efd8ae source' : 'tip tests against tip source',
  typecheck: typecheckStatus ? {
    rootExit: typecheckStatus.rootExit,
    strictTotalDiagnostics: typecheckStatus.strictTotalDiagnostics,
    strictTouchedDiagnostics: typecheckStatus.strictTouchedDiagnostics,
  } : undefined,
}))
const result = spawnSync(process.execPath, [
  '--max-old-space-size=1024', '--test', '--test-force-exit',
  '--test-concurrency=1', '--test-timeout=15000',
  ...suites.map(n => path.join(out, `${n}.test.mjs`)),
], { cwd: root, stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = (result.status ?? 1) || (typecheckStatus && (typecheckStatus.rootExit !== 0 || typecheckStatus.strictTouchedDiagnostics !== 0) ? 1 : 0)
