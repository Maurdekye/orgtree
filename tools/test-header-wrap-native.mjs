import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-header-wrap-'))
// The fixture mirrors App.tsx's native header structure (native-header-main
// slot, then update-notice and WindowControls as direct orgbar children)
// with enough content to overflow every tested width, plus a browser-style
// header as the probe's wrap-positive control.
await build({ stdin: { contents: `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { WindowControls } from './apps/desktop/renderer/src/window-controls'
import './apps/desktop/renderer/src/styles.css'
const chips = (n) => Array.from({ length: n }, (_, i) =>
  React.createElement('span', { className: 'chip', key: i }, 'status chip number ' + i))
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
  React.createElement('header', { id: 'native', className: 'orgbar native-header' },
    React.createElement('div', { className: 'native-header-main' },
      React.createElement('button', { className: 'iconbtn' }, 'menu'),
      React.createElement('h2', null, 'an-organization-with-a-deliberately-long-name-for-width-pressure'),
      chips(12)),
    React.createElement('div', { className: 'update-notice' }, 'Update ready: restart to apply 2.0.0-alpha.7'),
    React.createElement(WindowControls, null)),
  React.createElement('header', { id: 'browser', className: 'orgbar' },
    React.createElement('h2', null, 'an-organization-with-a-deliberately-long-name-for-width-pressure'),
    chips(12),
    React.createElement('div', { className: 'update-notice' }, 'Update ready: restart to apply 2.0.0-alpha.7'),
    React.createElement(WindowControls, null))))
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
