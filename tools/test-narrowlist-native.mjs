// Runs tests/narrowlist-native.probe.ts in a real Electron window: the email
// modal and the presentations modal, resized across the collapse threshold,
// measured and photographed. ORGTREE_NARROWLIST_SHOTS points the screenshots
// somewhere you can look at them; without it they land in the temp root the
// probe prints on exit.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-narrowlist-'))
const harness = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { NodeInboxModal } from './apps/desktop/renderer/src/canvas/mail'
import { DocGalleryModal } from './apps/desktop/renderer/src/canvas/gallery'
import './apps/desktop/renderer/src/styles.css'
const root = createRoot(document.getElementById('root'))
const noop = () => {}
const node = { id: 'agent-one', generation: 0, tier: 'opus', state: 'live' }
window.__mount = (kind) => {
  root.render(kind === 'mail'
    ? React.createElement(NodeInboxModal, { node, slug: 'demo', toast: noop, close: () => root.render(null) })
    : React.createElement(DocGalleryModal, { slug: 'demo', toast: noop, close: () => root.render(null) }))
}
`
await build({
  stdin: { contents: harness, loader: 'tsx', resolveDir: process.cwd() },
  outfile: path.join(root, 'narrowlist.js'), bundle: true, platform: 'browser',
  format: 'iife', jsx: 'automatic',
})
await build({ entryPoints: ['tests/narrowlist-native.probe.ts'], outfile: path.join(root, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
await build({ entryPoints: ['apps/desktop/preload/index.ts'], outfile: path.join(root, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })

const shots = process.env.ORGTREE_NARROWLIST_SHOTS || root
fs.mkdirSync(shots, { recursive: true })
const executable = process.env.ORGTREE_HISTORY_ELECTRON || createRequire(import.meta.url)('electron')
const env = {
  ...process.env,
  ORGTREE_NARROWLIST_TEST_ROOT: root,
  ORGTREE_NARROWLIST_SHOTS: shots,
  ORGTREE_DATA: path.join(root, 'data'),
  HOME: path.join(root, 'home'),
  USERPROFILE: path.join(root, 'home'),
}
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [path.join(root, 'probe.cjs')], { windowsHide: true, stdio: 'inherit', env })
child.on('error', (e) => { console.error(e); process.exitCode = 1 })
child.on('exit', (code) => { console.log('screenshots:', shots); process.exitCode = code ?? 1 })
