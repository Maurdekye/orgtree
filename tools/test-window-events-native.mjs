// Runs tests/window-events-native.probe.ts in real Electron: the window log
// records real minimize/restore/show/hide events, and revealing one window
// fires no minimize or hide on another. Everything lives in a temp folder
// that is removed afterwards; the probe exits on its own or is killed at 60 s.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-window-events-native-'))
await build({ entryPoints: ['tests/window-events-native.probe.ts'], outfile: path.join(root, 'probe.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const executable = process.env.ORGTREE_WINDOW_EVENTS_ELECTRON || createRequire(import.meta.url)('electron')
const env = { ...process.env, ORGTREE_WINDOW_EVENTS_ROOT: root, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [path.join(root, 'probe.cjs')], { windowsHide: true, stdio: 'inherit', env })
const timer = setTimeout(() => { console.error('the probe did not finish in 60 s'); child.kill() }, 60_000)
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => {
  clearTimeout(timer)
  fs.rmSync(root, { recursive: true, force: true })
  process.exitCode = code ?? 1
})
