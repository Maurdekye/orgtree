// Project watchdog captures (docket project-watchdogs-a-watchdog-owned-by-a-project-f). Bundles
// apps/desktop/renderer/tests/projectwatchdogs.visual.tsx with an EXPLICIT tsconfigRaw/nodePaths (no local tsconfig
// discovery; team note C CAPTURE CONFIG COLLISION), asserts ONE copy of React in the bundle, then runs Electron in
// Session 0 (tools/rig/desktop/projectwatchdogs-visual.cjs): offscreen, muted, network and clipboard refused.
//   node tools/rig/projectwatchdogs-visual.mjs --out <empty artifact folder> --deps-root <node_modules>
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
let meta
try {
  const r = await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/projectwatchdogs.visual.tsx')],
    outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', jsx: 'automatic', nodePaths: [deps], metafile: true,
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    loader: { '.png': 'file', '.svg': 'file', '.jpg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
  meta = r.metafile
} finally { esbuild.stop() }
const reacts = new Set(Object.keys(meta.inputs).map(f => f.replaceAll('\\', '/')).filter(f => /node_modules\/react\/index\.js$/.test(f)))
fs.writeFileSync(path.join(out, 'bundle-react.json'), JSON.stringify([...reacts], null, 2))
if (reacts.size !== 1) throw new Error(`expected exactly one React in the bundle, found ${reacts.size}`)
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
fs.mkdirSync(path.join(out, 'tmp'), { recursive: true })
const electron = args.electron ?? path.join(deps, 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env, TMP: path.join(out, 'tmp'), TEMP: path.join(out, 'tmp') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawnSync(electron, [path.join(repo, 'tools/rig/desktop/projectwatchdogs-visual.cjs'), '--probe-out', out],
  { env, windowsHide: true, timeout: 90000, encoding: 'utf8', maxBuffer: 1024 * 1024 })
if (child.stdout) process.stdout.write(child.stdout)
if (child.stderr) process.stderr.write(child.stderr)
if (child.error) throw child.error
process.exitCode = child.status ?? 1
