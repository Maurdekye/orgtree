// EPIC Mode (epic/opus) source checks, one heavy phase under the machine build
// lock (tools/rig/lib.mjs withBuildLock: queue order, free-RAM floor, handover):
//   1. the root typecheck (tsc -p tsconfig.json, as `npm run typecheck`);
//   2. the three EPIC renderer suites GREEN: tip tests on tip source;
//   3. the same suites RED: tip tests on the exact base (b77512f) — every
//      changed file loaded as it was at the base, and the new src/epic modules
//      replaced by stubs that export nothing, as at the base.
// No source or dependency junctions or copies: esbuild and the type roots are
// read in place from an existing dependency checkout. Run it under the
// kernel memory cap:
//   powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/renderer/tests/joblimit.ps1 `
//     -LimitMB 4096 -TimeoutSec 1200 -WorkDir <repo> -Exe <node.exe> -ArgFile <args.txt>
// with args.txt holding, one per line: this script, <dependency-root>, <empty C:/orgtree-build/<agent>/... dir>.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { withBuildLock } from './lib.mjs'

// `--bundle <mode> <deps> <dir>` is the child that bundles one mode (esbuild
// plugins need its asynchronous API; the lock holder waits for it).
const bundling = process.argv[2] === '--bundle'
const [depsArg, outArg, ...flags] = bundling ? process.argv.slice(4) : process.argv.slice(2)
if (!depsArg || !outArg) throw Error('Usage: node tools/rig/epic-mode-check.mjs <dependency-root> <empty C:/orgtree-build/<agent>/... dir> [--no-typecheck] [--no-red]')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i, 'output goes under the authorized C:/orgtree-build scope')
if (!bundling) assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use an empty output directory')
const modules = path.join(deps, 'node_modules')
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')

const BASE = 'b77512f'
const CHANGED = [
  'apps/desktop/renderer/src/App.tsx', 'apps/desktop/renderer/src/api.ts', 'apps/desktop/renderer/src/main.tsx',
  'apps/desktop/renderer/src/canvas/accounts.tsx', 'apps/desktop/main/policy.ts', 'packages/contracts/index.ts',
]
const SUITES = ['epicmode-switch', 'epicmode-off', 'epicmode-engine']
// What the suites import from modules that do not exist at the base.
const STUBS = {
  sync: 'export const startEpicSync = undefined',
  tap: 'export const epic = null; export const setEpicTaps = undefined',
  director: 'export const FAREWELL_MS = 0, PLAYBOOK_KINDS = [], startEpic = undefined',
  diff: 'export const diffOrg = undefined, HIRE_WINDOW_MS = 0, pulseEvent = undefined, snapshotOrg = undefined, sparkEvent = undefined, streamEvent = undefined',
  audio: 'export const EpicSynth = undefined, LIGHT_CAP = 0, SOUND_NAMES = [], VOICE_CAP = 0',
  stage: 'export const PARTICLE_CAP = 0, Stage = undefined',
}

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}
const head = git('rev-parse', 'HEAD').trim()
const dirty = git('status', '--porcelain').trim()
const baseText = new Map(CHANGED.map(f => [path.resolve(root, f).toLowerCase(), git('show', `${BASE}:${f}`)]))
assert.equal(baseText.size, CHANGED.length)

fs.mkdirSync(out, { recursive: true })
const log = (name, text) => fs.writeFileSync(path.join(out, name), text)

// The suites read stylesheets from __SRC_DIR__. Red reads them from the base:
// a folder holding exactly the base's copies of those files (none of them
// exist at the base, so it stays empty), never the tip tree.
const DISK_READS = ['apps/desktop/renderer/src/epic/epic.css']
function sourceDir(mode) {
  if (mode !== 'red') return path.join(root, 'apps/desktop/renderer/src')
  const dir = path.join(out, 'red-src')
  for (const file of DISK_READS) {
    const r = spawnSync('git', ['show', `${BASE}:${file}`], { cwd: root, encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) continue
    const to = path.join(dir, path.relative('apps/desktop/renderer/src', file))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, r.stdout)
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function bundle(mode) {
  const dir = path.join(out, mode)
  fs.mkdirSync(dir)
  const srcDir = sourceDir(mode)
  for (const name of SUITES) {
    await esbuild.build({
      entryPoints: [path.join(root, 'apps/desktop/renderer/tests', `${name}.test.tsx`)],
      outfile: path.join(dir, `${name}.test.mjs`), bundle: true, platform: 'node', format: 'esm',
      target: 'node22', jsx: 'automatic', nodePaths: [modules], logLevel: 'warning',
      loader: { '.css': 'empty' },
      define: {
        'process.env.NODE_ENV': '"development"',
        __SRC_DIR__: JSON.stringify(srcDir),
      },
      banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(deps, 'package.json'))});` },
      plugins: [{
        name: 'existing-deps-and-base',
        setup(build) {
          build.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(require.resolve('jsdom')).href, external: true }))
          if (mode !== 'red') return
          build.onResolve({ filter: /[\\/]epic[\\/](sync|tap|director|diff|audio|stage)$/ }, args => {
            const resolved = path.resolve(args.resolveDir, args.path)
            if (!resolved.replaceAll('\\', '/').includes('/apps/desktop/renderer/src/epic/')) return undefined
            return { path: path.basename(resolved), namespace: 'epic-stub' }
          })
          build.onLoad({ filter: /.*/, namespace: 'epic-stub' }, args => ({ contents: STUBS[args.path], loader: 'js' }))
          build.onLoad({ filter: /\.(tsx?|mts)$/ }, args => {
            const text = baseText.get(path.resolve(args.path).toLowerCase())
            if (text === undefined) return undefined
            return { contents: text, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: path.dirname(args.path) }
          })
        },
      }],
    })
  }
  await esbuild.stop()
  return dir
}

if (bundling) {
  await bundle(process.argv[3])
  process.exit(0)
}

function run(name, exe, args) {
  const started = Date.now()
  const r = spawnSync(exe, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 })
  const text = (r.stdout || '') + (r.stderr || '') + (r.error ? `\n${r.error}` : '')
  log(`${name}.log`, text)
  const tail = text.trim().split('\n').slice(-14).join('\n')
  console.log(`== ${name}: exit ${r.status} in ${Math.round((Date.now() - started) / 1000)} s\n${tail}`)
  return { exit: r.status, seconds: Math.round((Date.now() - started) / 1000), summary: tail }
}

function tests(mode) {
  const built = run(`bundle-${mode}`, process.execPath, [fileURLToPath(import.meta.url), '--bundle', mode, deps, out])
  if (built.exit !== 0) return built
  const dir = path.join(out, mode)
  return run(`tests-${mode}`, process.execPath, ['--max-old-space-size=1024', '--test', '--test-force-exit',
    '--test-concurrency=1', '--test-timeout=30000', '--test-reporter=spec',
    ...SUITES.map(n => path.join(dir, `${n}.test.mjs`))])
}

function typecheck() {
  const types = path.join(modules, '@types')
  const config = {
    extends: path.join(root, 'tsconfig.json'),
    compilerOptions: {
      typeRoots: [types], types: ['node', path.join(modules, 'vite/client')],
      paths: {
        react: [path.join(types, 'react')], 'react/*': [path.join(types, 'react/*')],
        'react-dom': [path.join(types, 'react-dom')], 'react-dom/*': [path.join(types, 'react-dom/*')],
        '*': [path.join(modules, '*')],
      },
    },
  }
  const file = path.join(out, 'typecheck.json')
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  return run('typecheck', process.execPath, [path.join(modules, 'typescript/bin/tsc'), '-p', file, '--noEmit'])
}

// `--inside`: the caller already holds the build lock for this phase
const locked = (what, fn) => flags.includes('--inside') ? { result: fn(), lock: 'held by the caller' } : withBuildLock(what, fn)
const outcome = locked('EPIC Mode typecheck + renderer suites (epic/opus)', () => {
  const results = {}
  try {
    if (!flags.includes('--no-typecheck')) results.typecheck = typecheck()
    results.green = tests('green')
    if (!flags.includes('--no-red')) results.red = tests('red')
  } finally { /* each bundle child stops its own esbuild service */ }
  return results
})
const summary = { head, dirty: !!dirty, base: BASE, suites: SUITES, output: out, lock: outcome.lock, results: outcome.result }
log('summary.json', JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ head, dirty: !!dirty, lock: outcome.lock }))
process.exitCode = outcome.result.typecheck?.exit || outcome.result.green.exit ? 1 : 0
