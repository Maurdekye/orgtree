import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const repo = process.cwd(), out = process.argv[2], deps = process.argv[3]
if (!out || !path.isAbsolute(out) || !deps || fs.existsSync(out)) throw Error('Fresh absolute output and existing dependency root required')
fs.mkdirSync(out, { recursive: true })
const require = createRequire(path.join(deps, 'package.json'))
const esbuild = require('esbuild')
try {
  await esbuild.build({ entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/ticketmention.visual.tsx')],
    outfile: path.join(out, 'fixture.js'), bundle: true, format: 'iife', jsx: 'automatic', nodePaths: [deps],
    loader: { '.png': 'file', '.svg': 'file', '.jpg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } })
} finally { esbuild.stop() }
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(path.join(deps, 'electron/dist/electron.exe'), [path.join(repo, 'tools/rig/desktop/objectcomposer-visual.cjs'), out],
  { env, windowsHide: true, timeout: 45000, encoding: 'utf8' })
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
if (result.error) throw result.error
process.exitCode = result.status ?? 1
