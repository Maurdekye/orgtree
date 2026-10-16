// EPIC Mode (the final version, epic/final) source checks, one heavy phase
// under the machine build lock (tools/rig/lib.mjs withBuildLock: queue order,
// free-RAM floor, handover):
//   1. the root typecheck (tsc -p tsconfig.json, as `npm run typecheck`);
//   2. the strict renderer and test configurations (both enable
//      noUncheckedIndexedAccess, which the root check does not), at the tip
//      and — given --base-tree <clean checkout of b77512f> — at the base, with
//      every diagnostic compared by file and code. The test configuration
//      inherits `exclude: ["tests"]`, which silently skips every suite, so the
//      overlay clears it and lists src and tests itself (the Astra take's trap);
//   3. the four EPIC renderer suites GREEN: tip tests on tip source;
//   4. RED: tip tests on the exact base (b77512f) — every changed file loaded as
//      it was at the base, the src/epic modules (absent there) replaced by stubs
//      that export nothing;
//   5. OPUS CONTROL: tip tests on the approved Opus take (fdd645f), whose
//      director, stage, synth, taps, api.ts and appfeed.ts the final version
//      builds on — every file the final version changed loaded as it was there
//      (exports added since are stubbed undefined), so the tests that fail are
//      exactly the final version's additions.
//   6. NEIGHBORS (--neighbors a,b,c): other renderer suites run green on the
//      tip, for the existing behaviour of files the final version touched
//      (api.ts's request and interrupt paths, appfeed.ts, the settings panel).
//   7. BEFORE (--before <sha>): the tip's suites on the tip tree with every
//      source file changed since <sha> loaded as it was there — the red of a
//      fix made on top of the final version (296deb0 for the canvas caret fix,
//      docket epic-mode-typing-effects-desync-in-canvas-desks).
// Each test run also writes JUnit XML, and summary.json lists every test's
// outcome per mode. No source or dependency junctions or copies: esbuild, tsc
// and the type roots are read in place from an existing dependency checkout.
// Run it under the kernel memory cap:
//   powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/renderer/tests/joblimit.ps1 `
//     -LimitMB 4096 -TimeoutSec 1500 -WorkDir <repo> -Exe <node.exe> -ArgFile <args.txt>
// with args.txt holding, one per line: this script, <dependency-root>, <empty C:/orgtree-build/<agent>/... dir>
// and optionally --base-tree, <clean checkout of b77512f>.
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
if (!depsArg || !outArg) throw Error('Usage: node tools/rig/epic-mode-check.mjs <dependency-root> <empty C:/orgtree-build/<agent>/... dir> [--base-tree <b77512f checkout>] [--neighbors a,b,c] [--before <sha>] [--no-typecheck] [--no-strict] [--no-red] [--no-opus] [--inside]')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i, 'output goes under the authorized C:/orgtree-build scope')
if (!bundling) assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use an empty output directory')
const baseTreeAt = flags.indexOf('--base-tree')
const baseTree = baseTreeAt >= 0 ? path.resolve(flags[baseTreeAt + 1] ?? '') : null
// the bundling child learns the neighbor list from the environment
const neighborsAt = flags.indexOf('--neighbors')
const NEIGHBORS = (neighborsAt >= 0 ? flags[neighborsAt + 1] ?? '' : process.env.EPIC_NEIGHBORS ?? '')
  .split(',').map(n => n.trim()).filter(Boolean)
for (const n of NEIGHBORS) assert.match(n, /^[a-z0-9-]+$/i, `a suite name, not a path: ${n}`)
// and the commit the before run loads changed sources from
const beforeAt = flags.indexOf('--before')
const BEFORE = (beforeAt >= 0 ? flags[beforeAt + 1] ?? '' : bundling ? process.env.EPIC_BEFORE ?? '' : '') || null
if (BEFORE) assert.match(BEFORE, /^[0-9a-f]{7,40}$/i, `a commit id, not a ref expression: ${BEFORE}`)
const modules = path.join(deps, 'node_modules')
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')

const BASE = 'b77512f'
const OPUS = 'fdd645f'
// changed since the base: loaded from the base in the red run
const CHANGED = [
  'apps/desktop/renderer/src/App.tsx', 'apps/desktop/renderer/src/api.ts', 'apps/desktop/renderer/src/main.tsx',
  'apps/desktop/renderer/src/appfeed.ts', 'apps/desktop/renderer/src/canvas/accounts.tsx',
  'apps/desktop/main/policy.ts', 'packages/contracts/index.ts',
]
// changed since the Opus take: loaded from it in the Opus control
const SINCE_OPUS = [
  'apps/desktop/renderer/src/epic/director.ts', 'apps/desktop/renderer/src/epic/stage.ts',
  'apps/desktop/renderer/src/epic/audio.ts', 'apps/desktop/renderer/src/epic/tap.ts',
  'apps/desktop/renderer/src/api.ts', 'apps/desktop/renderer/src/appfeed.ts',
]
// what the suites import that the Opus take did not export yet
const OPUS_MISSING = {
  'apps/desktop/renderer/src/epic/director.ts': ['COMBO_DECAY_MS', 'METER_FROM', 'MILESTONES', 'RANKS', 'climbFor', 'noteRatio', 'rankOf'],
  'apps/desktop/renderer/src/epic/stage.ts': ['MAX_DPR', 'MAX_PIXELS'],
}
const SUITES = ['epicmode-switch', 'epicmode-off', 'epicmode-engine', 'epicmode-final', 'epicmode-caret', 'epicmode-wheel', 'epicmode-urgent', 'epicmode-comfort', 'epicmode-linger', 'epicmode-progress']
// What the suites import from modules that do not exist at the base.
const STUBS = {
  sync: 'export const startEpicSync = undefined',
  tap: 'export const epic = null; export const setEpicTaps = undefined',
  director: 'export const FAREWELL_MS = 0, PLAYBOOK_KINDS = [], startEpic = undefined, COMBO_DECAY_MS = 0, METER_FROM = 0, '
    + 'MILESTONES = [], RANKS = [], climbFor = undefined, noteRatio = undefined, rankOf = undefined',
  diff: 'export const diffOrg = undefined, HIRE_WINDOW_MS = 0, pulseEvent = undefined, snapshotOrg = undefined, sparkEvent = undefined, streamEvent = undefined',
  audio: 'export const EpicSynth = undefined, LIGHT_CAP = 0, SOUND_NAMES = [], VOICE_CAP = 0',
  stage: 'export const PARTICLE_CAP = 0, Stage = undefined, MAX_DPR = 0, MAX_PIXELS = 0',
}

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}
const head = git('rev-parse', 'HEAD').trim()
const dirty = git('status', '--porcelain').trim()
const key = f => path.resolve(root, f).toLowerCase()
const baseText = new Map(CHANGED.map(f => [key(f), git('show', `${BASE}:${f}`)]))
const opusText = new Map(SINCE_OPUS.map(f => {
  const missing = OPUS_MISSING[f]
  const text = git('show', `${OPUS}:${f}`)
  return [key(f), missing ? `${text}\nexport const ${missing.map(n => `${n} = undefined`).join(', ')}\n` : text]
}))
assert.equal(baseText.size, CHANGED.length)
// changed since --before: loaded from it in the before run. A file added since
// then has no "before": there it is a stub whose exports are all undefined, so
// the tests of what it adds fail, as they must
const SINCE_BEFORE = BEFORE
  ? git('diff', '--name-only', BEFORE, 'HEAD', '--', 'apps/desktop/renderer/src', 'apps/desktop/main', 'packages')
    .split(/\r?\n/).map(f => f.trim()).filter(f => /\.(tsx?|mts)$/.test(f))
  : []
const ADDED_SINCE_BEFORE = new Set(BEFORE
  ? git('diff', '--name-only', '--diff-filter=A', BEFORE, 'HEAD', '--', 'apps/desktop/renderer/src', 'apps/desktop/main', 'packages')
    .split(/\r?\n/).map(f => f.trim()).filter(Boolean)
  : [])
const stubOf = f => {
  const names = [...fs.readFileSync(path.join(root, f), 'utf8')
    .matchAll(/^export (?:async )?(?:const|let|var|function\*?|class) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
  return names.length ? `export const ${names.map(n => `${n} = undefined`).join(', ')}\n` : 'export {}\n'
}
const beforeText = new Map(SINCE_BEFORE.map(f => [key(f), ADDED_SINCE_BEFORE.has(f) ? stubOf(f) : git('show', `${BEFORE}:${f}`)]))

fs.mkdirSync(out, { recursive: true })
const log = (name, text) => fs.writeFileSync(path.join(out, name), text)
// the native-preferences suite writes its temporary file here, inside the scope
const tmp = path.join(out, 'tmp')
fs.mkdirSync(tmp, { recursive: true })

// The suites read stylesheets from __SRC_DIR__. Red reads them from the base:
// a folder holding exactly the base's copies of those files (none of them
// exist at the base, so it stays empty), never the tip tree. The Opus take's
// stylesheet is the tip's: the final version did not change it.
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
  const replaced = mode === 'red' ? baseText : mode === 'opus' ? opusText : mode === 'before' ? beforeText : null
  for (const name of mode === 'neighbors' ? NEIGHBORS : SUITES) {
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
          if (!replaced) return
          if (mode === 'red') {
            build.onResolve({ filter: /[\\/]epic[\\/](sync|tap|director|diff|audio|stage)$/ }, args => {
              const resolved = path.resolve(args.resolveDir, args.path)
              if (!resolved.replaceAll('\\', '/').includes('/apps/desktop/renderer/src/epic/')) return undefined
              return { path: path.basename(resolved), namespace: 'epic-stub' }
            })
            build.onLoad({ filter: /.*/, namespace: 'epic-stub' }, args => ({ contents: STUBS[args.path], loader: 'js' }))
          }
          build.onLoad({ filter: /\.(tsx?|mts)$/ }, args => {
            const text = replaced.get(path.resolve(args.path).toLowerCase())
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

function run(name, exe, args, env = {}) {
  const started = Date.now()
  const r = spawnSync(exe, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000, env: { ...process.env, ...env } })
  const text = (r.stdout || '') + (r.stderr || '') + (r.error ? `\n${r.error}` : '')
  log(`${name}.log`, text)
  const tail = text.trim().split('\n').slice(-14).join('\n')
  console.log(`== ${name}: exit ${r.status} in ${Math.round((Date.now() - started) / 1000)} s\n${tail}`)
  return { exit: r.status, seconds: Math.round((Date.now() - started) / 1000), summary: tail, text }
}

/** every test case's name and outcome from a JUnit report */
function outcomes(xml) {
  const cases = []
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1], inner = m[3] ?? ''
    const name = (/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '').replaceAll('&apos;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&')
    const file = (/\bfile="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/[\\/]/).pop()?.replace(/\.test\.mjs$/, '') ?? ''
    const state = /<failure\b/.test(inner) ? 'fail' : /<skipped\b/.test(inner) ? 'skip' : 'pass'
    cases.push({ suite: file, name, state })
  }
  return cases
}

function tests(mode) {
  const suites = mode === 'neighbors' ? NEIGHBORS : SUITES
  const built = run(`bundle-${mode}`, process.execPath, [fileURLToPath(import.meta.url), '--bundle', mode, deps, out],
    { EPIC_NEIGHBORS: NEIGHBORS.join(','), EPIC_BEFORE: BEFORE ?? '' })
  if (built.exit !== 0) return { exit: built.exit, seconds: built.seconds, summary: built.summary }
  const dir = path.join(out, mode)
  const junit = path.join(out, `tests-${mode}.xml`)
  // 10 s per test, the renderer runner's default (tests/run.mjs), so a test
  // that needs longer fails here as it does in a release round, unless it sets
  // its own { timeout }
  const r = run(`tests-${mode}`, process.execPath, ['--max-old-space-size=1024', '--test', '--test-force-exit',
    '--test-concurrency=1', '--test-timeout=10000',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=junit', `--test-reporter-destination=${junit}`,
    ...suites.map(n => path.join(dir, `${n}.test.mjs`))], { EPIC_TMP: tmp })
  const cases = fs.existsSync(junit) ? outcomes(fs.readFileSync(junit, 'utf8')) : []
  const count = state => cases.filter(c => c.state === state).length
  return { exit: r.exit, seconds: r.seconds, executed: cases.length, passed: count('pass'), failed: count('fail'),
    skipped: count('skip'), cases }
}

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

function typecheck() {
  const config = {
    extends: path.join(root, 'tsconfig.json'),
    compilerOptions: { ...resolution, types: ['node', path.join(modules, 'vite/client')] },
  }
  const file = path.join(out, 'typecheck.json')
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  const r = run('typecheck', process.execPath, [tsc, '-p', file, '--noEmit'])
  return { exit: r.exit, seconds: r.seconds, summary: r.summary }
}

/** One strict configuration over one tree: its diagnostics by file and code,
 *  and the file list, to show the suites really were included. */
function strictCheck(tree, which, label) {
  const renderer = path.join(tree, 'apps/desktop/renderer')
  const config = which === 'renderer'
    ? { extends: path.join(renderer, 'tsconfig.json'),
      compilerOptions: { ...resolution, types: [path.join(modules, 'vite/client')] } }
    : { extends: path.join(renderer, 'tests/tsconfig.json'),
      compilerOptions: { ...resolution, types: ['node', path.join(modules, 'vite/client')] },
      include: [path.join(renderer, 'src'), path.join(renderer, 'tests')], exclude: [] }
  const file = path.join(out, `strict-${which}-${label}.json`)
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  const r = run(`strict-${which}-${label}`, process.execPath, [tsc, '-p', file, '--noEmit', '--pretty', 'false', '--listFiles'])
  const diagnostics = []
  const files = []
  for (const line of r.text.split(/\r?\n/)) {
    const d = /^(.+?)\(\d+,\d+\): error (TS\d+):/.exec(line)
    if (d) diagnostics.push(`${path.relative(tree, path.resolve(root, d[1])).replaceAll('\\', '/')} ${d[2]}`)
    else if (/\.(tsx?|mts)$/.test(line.trim()) && fs.existsSync(line.trim())) files.push(line.trim())
  }
  const inTree = files.filter(f => path.resolve(f).toLowerCase().startsWith(tree.toLowerCase()))
  return { exit: r.exit, seconds: r.seconds, count: diagnostics.length, diagnostics,
    suitesListed: SUITES.filter(s => inTree.some(f => f.replaceAll('\\', '/').endsWith(`/tests/${s}.test.tsx`))) }
}

function strict() {
  const result = {}
  for (const which of ['renderer', 'tests']) {
    const tip = strictCheck(root, which, 'tip')
    const entry = { tip: { exit: tip.exit, count: tip.count, seconds: tip.seconds, suitesListed: tip.suitesListed },
      epicDiagnostics: tip.diagnostics.filter(d => /epic/i.test(d)) }
    if (baseTree) {
      const base = strictCheck(baseTree, which, 'base')
      entry.base = { exit: base.exit, count: base.count, seconds: base.seconds }
      // compare as multisets of "file code"
      const tally = list => list.reduce((m, d) => m.set(d, (m.get(d) ?? 0) + 1), new Map())
      const a = tally(base.diagnostics), b = tally(tip.diagnostics)
      entry.added = [...b].filter(([d, n]) => n > (a.get(d) ?? 0)).map(([d, n]) => `${d} ×${n - (a.get(d) ?? 0)}`)
      entry.removed = [...a].filter(([d, n]) => n > (b.get(d) ?? 0)).map(([d, n]) => `${d} ×${n - (b.get(d) ?? 0)}`)
    }
    result[which] = entry
  }
  return result
}

// `--inside`: the caller already holds the build lock for this phase
const locked = (what, fn) => flags.includes('--inside') ? { result: fn(), lock: 'held by the caller' } : withBuildLock(what, fn)
const outcome = locked('EPIC Mode final: typecheck, strict, renderer suites green/red/opus', () => {
  const results = {}
  if (!flags.includes('--no-typecheck')) results.typecheck = typecheck()
  if (!flags.includes('--no-strict')) results.strict = strict()
  results.green = tests('green')
  if (!flags.includes('--no-red')) results.red = tests('red')
  if (!flags.includes('--no-opus')) results.opus = tests('opus')
  if (NEIGHBORS.length) results.neighbors = tests('neighbors')
  if (BEFORE) results.before = tests('before')
  return results
})
const summary = { head, dirty: !!dirty, base: BASE, opus: OPUS, before: BEFORE, sinceBefore: SINCE_BEFORE, baseTree, suites: SUITES,
  output: out, lock: outcome.lock, results: outcome.result }
log('summary.json', JSON.stringify(summary, null, 2))
const brief = mode => outcome.result[mode] && { exit: outcome.result[mode].exit, executed: outcome.result[mode].executed,
  passed: outcome.result[mode].passed, failed: outcome.result[mode].failed, skipped: outcome.result[mode].skipped }
console.log(JSON.stringify({ head, dirty: !!dirty, lock: outcome.lock, typecheck: outcome.result.typecheck?.exit,
  green: brief('green'), red: brief('red'), opus: brief('opus'), neighbors: brief('neighbors'), before: brief('before') }, null, 2))
process.exitCode = outcome.result.typecheck?.exit || outcome.result.green.exit || outcome.result.neighbors?.exit ? 1 : 0
