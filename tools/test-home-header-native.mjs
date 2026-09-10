import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-home-header-'))
// Two home-page shapes: the FIXED corner header + centered card (shipped),
// and the OLD shape with the controls inside the centered card's h1 as the
// probe's card-attached positive control.
await build({ stdin: { contents: `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { WindowControls } from './apps/desktop/renderer/src/window-controls'
import './apps/desktop/renderer/src/styles.css'
const card = (id, controls) =>
  React.createElement('div', { className: 'welcome-card', id },
    React.createElement('h1', null, 'orgtree', controls),
    React.createElement('nav', null,
      ...['one', 'two', 'three'].map(n =>
        React.createElement('div', { className: 'org', key: n }, n))))
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
  React.createElement('div', { className: 'app' },
    React.createElement('div', { className: 'welcome' },
      React.createElement('header', { id: 'home', className: 'orgbar native-header home-header' },
        React.createElement('h2', null, 'orgtree'),
        React.createElement('div', { className: 'update-notice' }, 'Update ready: 2.0.0-alpha.7'),
        React.createElement(WindowControls, null)),
      card('goodcard', null))),
  React.createElement('div', { className: 'welcome', id: 'badcard' },
    card('badcard-card', React.createElement(WindowControls, null)))))
`, loader: 'tsx', resolveDir: process.cwd() },
  outfile: path.join(root, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' })
await build({ entryPoints: ['tests/home-header-native.probe.ts'], outfile: path.join(root, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
await build({ entryPoints: ['apps/desktop/preload/index.ts'], outfile: path.join(root, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
const executable = process.env.ORGTREE_HISTORY_ELECTRON || createRequire(import.meta.url)('electron')
const env = { ...process.env, ORGTREE_HOME_TEST_ROOT: root, ORGTREE_DATA: path.join(root, 'data'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [path.join(root, 'probe.cjs')], { windowsHide: true, stdio: 'inherit', env })
child.on('error', e => { console.error(e); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
