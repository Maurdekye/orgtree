// Presented screen captures (USER 2026-10-27 mb56fc243d55d, mbebb35945cb1): the Presented list column stops at 400px, so
// a maximised window gives the presentation the room, and the HTML card's chip reads "</> HTML". An agent's Presented
// view filling the window and the centred Presented documents window, each at the main window's normal 1400x900 and a
// maximised 1920x1040, with one contact sheet. Build the fixture, run electron, view the PNGs (result.json carries the
// probes and the pass/fail). Session 0 or a never-switched private desktop only.
//   node tools/rig/presentedwidth-visual.mjs --out <empty artifact folder> --deps-root <node_modules>
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
const out = path.resolve(args.out)
if (out === repo || out.startsWith(repo + path.sep)) throw new Error('artifact folder must be outside source')
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('use an empty artifact folder')
fs.mkdirSync(out, { recursive: true })
const deps = path.resolve(args['deps-root'] ?? path.join(repo, 'node_modules'))
const esbuild = createRequire(import.meta.url)(path.join(deps, 'esbuild'))
try {
  await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/presentedwidth.visual.tsx')],
    outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', jsx: 'automatic', nodePaths: [deps],
    loader: { '.png': 'file', '.svg': 'file', '.jpg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
} finally { esbuild.stop() }
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
fs.mkdirSync(path.join(out, 'tmp'), { recursive: true })
const electron = args.electron ?? path.join(deps, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env, TMP: path.join(out, 'tmp'), TEMP: path.join(out, 'tmp') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawnSync(electron, [path.join(repo, 'tools/rig/desktop/presentedwidth-visual.cjs'), '--probe-out', out],
  { env, windowsHide: true, timeout: 180000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
if (child.stdout) process.stdout.write(child.stdout)
if (child.stderr) process.stderr.write(child.stderr)
if (child.error) throw child.error
process.exitCode = child.status ?? 1
