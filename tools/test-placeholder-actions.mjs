// tools/test-placeholder-actions.mjs — bundles the REAL <OrgCanvas> page and
// runs tests/placeholder-actions.probe.ts against it in a real Electron
// window. See that file for what is being asked and why it cannot be asked
// anywhere cheaper.
//
//   node tools/test-placeholder-actions.mjs
//   node tools/test-placeholder-actions.mjs --only show | --only return
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : ''
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-placeholder-actions-'))

await build({ entryPoints: ['tests/placeholder-actions-probe.tsx'], outfile: path.join(root, 'fixture.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' } })
await build({ entryPoints: ['tests/placeholder-actions.preload.ts'], outfile: path.join(root, 'preload.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
await build({ entryPoints: ['tests/placeholder-actions.probe.ts'], outfile: path.join(root, 'probe.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })

const env = { ...process.env, ORGTREE_PLACEHOLDER_ROOT: root, ORGTREE_PROBE_ONLY: only,
  ORGTREE_DATA: path.join(root, 'data'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'probe.cjs')],
  { env, windowsHide: true, stdio: 'inherit' })
child.on('error', e => { console.error(e); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
