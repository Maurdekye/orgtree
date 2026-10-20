// Retired pile captures (with-hide-retired-agents-off-no-retired-agents-a):
// build the fixture, inject a real engine snapshot (the `/records` answer
// retired-piles-scale.mjs saved), run electron, view the PNGs (result.json
// carries the probes and the timings).
//   node tools/rig/retiredpiles-visual.mjs --snapshot <snapshot.json> --out <empty dir> [--deps-root <node_modules>]
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = Object.fromEntries(process.argv.slice(2).reduce((all, value, i, values) => {
  if (value.startsWith('--')) all.push([value.slice(2), values[i + 1]])
  return all
}, []))
if (!args.out) throw new Error('--out is required')
if (!args.snapshot) throw new Error('--snapshot is required (the scale proof\'s snapshot.json)')
const out = path.resolve(args.out)
if (out === repo || out.startsWith(repo + path.sep)) throw new Error('artifact folder must be outside source')
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('use an empty artifact folder')
fs.mkdirSync(out, { recursive: true })
const snapshot = JSON.parse(fs.readFileSync(path.resolve(args.snapshot), 'utf8'))
if (!Array.isArray(snapshot.records)) throw new Error('not a record snapshot')
fs.writeFileSync(path.join(out, 'snapshot.js'), `window.__RETIRED_SNAPSHOT__ = ${JSON.stringify(snapshot)};\n`)
const deps = path.resolve(args['deps-root'] ?? path.join(repo, 'node_modules'))
const esbuild = createRequire(import.meta.url)(path.join(deps, 'esbuild'))
try {
  await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/retiredpiles.visual.tsx')],
    outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', jsx: 'automatic', nodePaths: [deps],
    loader: { '.png': 'file', '.svg': 'file', '.jpg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
} finally { esbuild.stop() }
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="snapshot.js"></script><script src="fixture.js"></script>')
fs.mkdirSync(path.join(out, 'tmp'), { recursive: true })
const electron = args.electron ?? path.join(deps, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env, TMP: path.join(out, 'tmp'), TEMP: path.join(out, 'tmp') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawnSync(electron, [path.join(repo, 'tools/rig/desktop/retiredpiles-visual.cjs'), '--probe-out', out],
  { env, windowsHide: true, timeout: 120000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
if (child.stdout) process.stdout.write(child.stdout)
if (child.stderr) process.stderr.write(child.stderr)
if (child.error) throw child.error
process.exitCode = child.status ?? 1
