import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-header-wrap-'))
// The fixture mirrors App.tsx's native header structure (native-header-main
// slot, then update-notice and WindowControls as direct orgbar children)
// with the real flexible spacer, flattened detail group and badge buttons.
// Narrow widths must wrap; wide widths must leave the actions right aligned.
await build({ stdin: { contents: `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { WindowControls } from './apps/desktop/renderer/src/window-controls'
import './apps/desktop/renderer/src/styles.css'
const e = React.createElement
const chips = Array.from({ length: 4 }, (_, i) =>
  e('span', { className: 'chip', key: i }, 'status chip ' + i))
createRoot(document.getElementById('root')).render(e('main', { className: 'solo' },
  e('header', { id: 'native', className: 'orgbar native-header' },
    e('div', { className: 'native-header-main' },
      e('button', { className: 'iconbtn' }, 'menu'),
      e('h2', null, 'Orgtree'),
      e('div', { className: 'bar-detail' }, chips),
      e('span', { id: 'spacer', style: { flex: 1 } }),
      e('button', { className: 'iconbtn ask-bell' }, 'Inbox', e('b', { className: 'eye-count' }, '12')),
      e('button', { className: 'iconbtn doc-bell' }, 'Presented', e('b', { className: 'eye-count' }, '19')),
      e('button', null, 'Connections'),
      e('button', null, 'Settings'),
      e('a', { className: 'gh-link', href: '#', id: 'last-action' }, 'GitHub')),
    e('div', { className: 'update-notice' }, "You're up to date"),
    e(WindowControls, null))))
`, loader: 'tsx', resolveDir: process.cwd() },
  outfile: path.join(root, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' })
await build({ entryPoints: ['tests/header-wrap-native.probe.ts'], outfile: path.join(root, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
await build({ entryPoints: ['apps/desktop/preload/index.ts'], outfile: path.join(root, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const executable = process.env.ORGTREE_HISTORY_ELECTRON || createRequire(import.meta.url)('electron')
const env = { ...process.env, ORGTREE_HEADER_TEST_ROOT: root, ORGTREE_DATA: path.join(root, 'data'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [path.join(root, 'probe.cjs')], { windowsHide: true, stdio: 'inherit', env })
child.on('error', e => { console.error(e); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
