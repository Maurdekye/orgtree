// EPIC Mode (the final version, epic/final) screenshots: bundles the synthetic fixture
// (apps/desktop/renderer/tests/epicmode-visual.tsx), loads it from file:// in
// an offscreen Electron window (apps/desktop/renderer/tests/epicmode-capture.cjs)
// and writes PNGs plus visual-result.json. One heavy phase under the machine
// build lock (tools/rig/lib.mjs withBuildLock). No engine, no live data, no
// network; dependencies are read in place from an existing checkout.
// Run it under the kernel memory cap:
//   powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/renderer/tests/joblimit.ps1 `
//     -LimitMB 4096 -TimeoutSec 900 -WorkDir <repo> -Exe <node.exe> -ArgFile <args.txt>
// with args.txt holding, one per line: this script, <dependency-root>, <empty C:/orgtree-build/<agent>/... dir>.
// `--before <sha>` bundles the fixture with every renderer source changed since
// <sha> loaded as it was there (the red of a fix made on top of the final
// version: 296deb0 for the canvas caret fix); the capture script is the tip's.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { withBuildLock } from './lib.mjs'

// `--bundle <deps> <dir> [--before <sha>]` is the child that bundles the
// fixture (esbuild plugins need its asynchronous API; the lock holder waits)
const bundling = process.argv[2] === '--bundle'
const [depsArg, outArg, ...flags] = process.argv.slice(bundling ? 3 : 2)
if (!depsArg || !outArg) throw Error('Usage: node tools/rig/epic-mode-visual.mjs <dependency-root> <empty C:/orgtree-build/<agent>/... dir> [--before <sha>] [--inside]')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i, 'output goes under the authorized C:/orgtree-build scope')
if (!bundling) assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use an empty output directory')
const beforeAt = flags.indexOf('--before')
const BEFORE = beforeAt >= 0 ? flags[beforeAt + 1] ?? '' : null
if (BEFORE !== null) assert.match(BEFORE, /^[0-9a-f]{7,40}$/i, `a commit id, not a ref expression: ${BEFORE}`)
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}
const head = git('rev-parse', 'HEAD').trim()
const dirty = !!git('status', '--porcelain').trim()
// changed since --before: bundled as it was there (every one must exist there)
const sinceBefore = BEFORE
  ? git('diff', '--name-only', BEFORE, 'HEAD', '--', 'apps/desktop/renderer/src', 'packages')
    .split(/\r?\n/).map(f => f.trim()).filter(f => /\.(tsx?|mts)$/.test(f))
  : []

if (bundling) {
  const text = new Map(sinceBefore.map(f => [path.resolve(root, f).toLowerCase(), git('show', `${BEFORE}:${f}`)]))
  await esbuild.build({
    entryPoints: [path.join(root, 'apps/desktop/renderer/tests/epicmode-visual.tsx')],
    outfile: path.join(out, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife',
    jsx: 'automatic', nodePaths: [path.join(deps, 'node_modules')], logLevel: 'warning',
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.png': 'empty', '.svg': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'changed-sources-before',
      setup(build) {
        if (!text.size) return
        build.onLoad({ filter: /\.(tsx?|mts)$/ }, args => {
          const contents = text.get(path.resolve(args.path).toLowerCase())
          if (contents === undefined) return undefined
          return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: path.dirname(args.path) }
        })
      },
    }],
  })
  await esbuild.stop()
  process.exit(0)
}
const electron = require('electron')

// `--inside`: the caller already holds the build lock for this phase
const locked = (what, fn) => flags.includes('--inside') ? { result: fn(), lock: 'held by the caller' } : withBuildLock(what, fn)
const outcome = locked(`EPIC Mode final screenshots (${BEFORE ? `sources before ${BEFORE}` : 'tip'})`, () => {
  fs.mkdirSync(out, { recursive: true })
  const bundled = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--bundle', deps, out, ...(BEFORE ? ['--before', BEFORE] : [])],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  fs.writeFileSync(path.join(out, 'bundle.log'), (bundled.stdout || '') + (bundled.stderr || '') + (bundled.error ? String(bundled.error) : ''))
  if (bundled.status !== 0) return { exit: bundled.status ?? 1, seconds: 0, bundle: 'failed: see bundle.log' }
  fs.writeFileSync(path.join(out, 'fixture.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  const env = { ...process.env, EPIC_VISUAL_ROOT: out, EPIC_VISUAL_URL: pathToFileURL(out).href }
  delete env.ELECTRON_RUN_AS_NODE
  const started = Date.now()
  const r = spawnSync(electron, [path.join(root, 'apps/desktop/renderer/tests/epicmode-capture.cjs')],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
  fs.writeFileSync(path.join(out, 'electron.log'), (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : ''))
  return { exit: r.status, seconds: Math.round((Date.now() - started) / 1000) }
})
const result = fs.existsSync(path.join(out, 'visual-result.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'visual-result.json'), 'utf8')) : null
const shots = fs.existsSync(path.join(out, 'shots')) ? fs.readdirSync(path.join(out, 'shots')) : []
console.log(JSON.stringify({ head, dirty, before: BEFORE, sinceBefore, electron: outcome.result, lock: outcome.lock, passed: result?.passed ?? false, shots: shots.length,
  error: fs.existsSync(path.join(out, 'visual-error.txt')) ? fs.readFileSync(path.join(out, 'visual-error.txt'), 'utf8').slice(0, 1500) : null }, null, 2))
process.exitCode = outcome.result.exit === 0 && result?.passed ? 0 : 1
