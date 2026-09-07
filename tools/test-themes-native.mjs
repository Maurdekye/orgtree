import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-themes-native-'))
await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{ThemeSetting,startThemeSync}from'./apps/desktop/renderer/src/themes';import{PinFrame}from'./apps/desktop/renderer/src/canvas/modalpin';import './apps/desktop/renderer/src/styles.css';startThemeSync();createRoot(document.getElementById('root')).render(<PinFrame kind='app-settings' title='App settings' panel='settings app-settings' close={()=>{}}><h3>App settings</h3><div className='app-settings-tabs' role='tablist'><button role='tab' aria-selected='true'>Display</button></div><ThemeSetting/><p style={{color:'var(--ok)'}}>✓ Done</p><p style={{color:'var(--bad)'}}>! Blocked</p><p className='desk-nav-chip prov-openai'>Codex provider identity</p><textarea aria-label='Unsent draft' defaultValue='Keep this draft'/><button className='primary'>Done</button></PinFrame>);`,loader:'tsx',resolveDir:process.cwd()},outfile:path.join(root,'themes.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic'})
await build({entryPoints:['tests/themes-native.probe.ts'],outfile:path.join(root,'probe.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']})
await build({entryPoints:['apps/desktop/preload/index.ts'],outfile:path.join(root,'preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']})
const executable=process.env.ORGTREE_HISTORY_ELECTRON||createRequire(import.meta.url)('electron')
const env={...process.env,ORGTREE_THEME_TEST_ROOT:root,ORGTREE_DATA:path.join(root,'data'),HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home')}
delete env.ELECTRON_RUN_AS_NODE
const child=spawn(executable,[path.join(root,'probe.cjs')],{windowsHide:true,stdio:'inherit',env})
child.on('error',e=>{console.error(e);process.exitCode=1})
child.on('exit',code=>{process.exitCode=code??1})
