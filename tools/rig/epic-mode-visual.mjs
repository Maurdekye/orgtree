// EPIC Mode (epic/opus) screenshots: bundles the synthetic fixture
// (apps/desktop/renderer/tests/epicmode-visual.tsx), loads it from file:// in
// an offscreen Electron window (apps/desktop/renderer/tests/epicmode-capture.cjs)
// and writes PNGs plus visual-result.json. One heavy phase under the machine
// build lock (tools/rig/lib.mjs withBuildLock). No engine, no live data, no
// network; dependencies are read in place from an existing checkout.
// Run it under the kernel memory cap:
//   powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/renderer/tests/joblimit.ps1 `
//     -LimitMB 4096 -TimeoutSec 900 -WorkDir <repo> -Exe <node.exe> -ArgFile <args.txt>
// with args.txt holding, one per line: this script, <dependency-root>, <empty C:/orgtree-build/<agent>/... dir>.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { withBuildLock } from './lib.mjs'

const [depsArg, outArg, ...flags] = process.argv.slice(2)
if (!depsArg || !outArg) throw Error('Usage: node tools/rig/epic-mode-visual.mjs <dependency-root> <empty C:/orgtree-build/<agent>/... dir>')
const root = fileURLToPath(new URL('../../', import.meta.url))
const deps = path.resolve(depsArg), out = path.resolve(outArg)
assert.match(out.replaceAll('\\', '/'), /^C:\/orgtree-build\/[^/]+\/.+/i, 'output goes under the authorized C:/orgtree-build scope')
assert.equal(fs.existsSync(out) && fs.readdirSync(out).length > 0, false, 'use an empty output directory')
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')
const electron = require('electron')

// `--inside`: the caller already holds the build lock for this phase
const locked = (what, fn) => flags.includes('--inside') ? { result: fn(), lock: 'held by the caller' } : withBuildLock(what, fn)
const outcome = locked('EPIC Mode screenshots (epic/opus)', () => {
  fs.mkdirSync(out, { recursive: true })
  esbuild.buildSync({
    entryPoints: [path.join(root, 'apps/desktop/renderer/tests/epicmode-visual.tsx')],
    outfile: path.join(out, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife',
    jsx: 'automatic', nodePaths: [path.join(deps, 'node_modules')], logLevel: 'warning',
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.png': 'empty', '.svg': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  })
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
console.log(JSON.stringify({ electron: outcome.result, lock: outcome.lock, passed: result?.passed ?? false, shots: shots.length,
  error: fs.existsSync(path.join(out, 'visual-error.txt')) ? fs.readFileSync(path.join(out, 'visual-error.txt'), 'utf8').slice(0, 1500) : null }, null, 2))
process.exitCode = outcome.result.exit === 0 && result?.passed ? 0 : 1
