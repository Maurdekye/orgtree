// Changelog captures (changelog-window-one-row-per-version-pinnable-po). Build
// the fixture, run electron, view the PNGs (result.json carries the probes and
// the receipt: the window process's PID and Windows session, and the clipboard
// denial). Run it only from a turn in Session 0 or on a never-switched private
// desktop: the harness refuses any other session before it opens a window.
//   node tools/rig/changelog-visual.mjs --out <empty folder outside source> --deps-root <node_modules>
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
const notes = Object.fromEntries(['4.4.4', '4.4.3', '4.4.2'].map((v) =>
  [v, fs.readFileSync(path.join(repo, 'docs', `release-notes-${v}.md`), 'utf8')]))
try {
  await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/changelog.visual.tsx')],
    outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', jsx: 'automatic', nodePaths: [deps],
    define: { __CHANGELOG_NOTES__: JSON.stringify(JSON.stringify(notes)) },
    loader: { '.png': 'file', '.svg': 'file', '.jpg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
} finally { esbuild.stop() }
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
fs.mkdirSync(path.join(out, 'tmp'), { recursive: true })
const electron = args.electron ?? path.join(deps, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env, TMP: path.join(out, 'tmp'), TEMP: path.join(out, 'tmp') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawnSync(electron, [path.join(repo, 'tools/rig/desktop/changelog-visual.cjs'), '--probe-out', out],
  { env, windowsHide: true, timeout: 90000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
if (child.stdout) process.stdout.write(child.stdout)
if (child.stderr) process.stderr.write(child.stderr)
if (child.error) throw child.error
process.exitCode = child.status ?? 1
