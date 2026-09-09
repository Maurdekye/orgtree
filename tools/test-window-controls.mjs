import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-window-controls-'))
await build({ entryPoints: ['tests/window-controls-native.probe.ts'], outfile: path.join(root, 'probe.cjs'), bundle: true, format: 'cjs', platform: 'node', external: ['electron'] })
const executable = createRequire(import.meta.url)('electron')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [path.join(root, 'probe.cjs')], { stdio: 'inherit', windowsHide: true, env })
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 45000)
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
