import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-history-native-'))
await build({stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import{HistoryBrowser}from'./apps/desktop/renderer/src/history';createRoot(document.getElementById('mount')).render(<HistoryBrowser slug='fixture' close={()=>{}}/>);",loader:'tsx',resolveDir:process.cwd()},outfile:path.join(root,'history.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic'})
await build({entryPoints:['tests/history-native.probe.ts'],outfile:path.join(root,'probe.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']})
const executable=process.env.ORGTREE_HISTORY_ELECTRON||createRequire(import.meta.url)('electron')
const env={...process.env,ORGTREE_HISTORY_TEST_ROOT:root,ORGTREE_DATA:path.join(root,'data'),HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home')}
delete env.ELECTRON_RUN_AS_NODE
const child=spawn(executable,[path.join(root,'probe.cjs')],{windowsHide:true,stdio:'inherit',env})
child.on('error',e=>{console.error(e);process.exitCode=1})
child.on('exit',code=>{process.exitCode=code??1})
