import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-popout-header-'))
const styles = path.join(root, 'styles.css')
fs.copyFileSync('apps/desktop/renderer/src/styles.css', styles)
await build({ entryPoints: ['tests/popout-header-native.probe.ts'], outfile: path.join(root, 'probe.cjs'),
  bundle: true, format: 'cjs', platform: 'node', external: ['electron'] })
const env = { ...process.env, ORGTREE_POPOUT_STYLES: styles }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'probe.cjs')],
  { stdio: 'inherit', windowsHide: true, env })
// The probe holds its own, shorter deadline and exits through app.exit(), so
// this is a backstop for a process that never got that far - not the normal way
// out. It says so when it fires, because a silent kill reads like a pass.
const timer = setTimeout(() => {
  console.error('popout header probe did not exit within 50s; killing it')
  child.kill()
  process.exitCode = 1
}, 50000)
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
