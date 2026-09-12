// Drives the dev channel's scope guard (build/installer.nsh
// orgtreeDevScopeGuard) through a compiled NSIS fixture, following
// test-installer-update-mode.mjs: the tiny installers run fully silent, quit
// in .onInit, and perform no installation, registry write or elevation.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-dev-guard-'))
const compiler=process.env.ORGTREE_MAKENSIS || path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe')
if(!fs.existsSync(compiler))throw Error('INERT: NSIS compiler unavailable; set ORGTREE_MAKENSIS')
const source=fs.readFileSync('build/installer.nsh','utf8')
const macro=source.match(/!macro orgtreeDevScopeGuard\r?\n[\s\S]*?\r?\n!macroend/)[0]
const tests=[
 // The all-users scope is where the published install's boot task and HKLM
 // uninstall entry live: a dev install must end with exit code 2, before
 // reaching anything after the guard.
 {name:'all-users-refused',mode:'all',status:2,receipt:null},
 {name:'per-user-proceeds',mode:'CurrentUser',status:0,receipt:'reached|CurrentUser'},
]
for(const t of tests){
 const exe=path.join(temp,t.name+'.exe'),receipt=path.join(temp,t.name+'.txt')
 const nsi=`!include LogicLib.nsh
Name "Orgtree dev guard test"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
Var installMode
${macro}
Function .onInit
 StrCpy $installMode "${t.mode}"
 !insertmacro orgtreeDevScopeGuard
 FileOpen $0 "${receipt}" w
 FileWrite $0 "reached|$installMode"
 FileClose $0
 SetErrorLevel 0
 Quit
FunctionEnd
Section
SectionEnd
`
 const file=path.join(temp,t.name+'.nsi');fs.writeFileSync(file,nsi)
 const compile=spawnSync(compiler,['/V1',file],{encoding:'utf8',windowsHide:true,timeout:15000})
 assert.equal(compile.status,0,compile.stdout+compile.stderr)
 const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:10000})
 assert.equal(run.status,t.status,t.name+': exit '+run.status)
 assert.equal(fs.existsSync(receipt)?fs.readFileSync(receipt,'utf8'):null,t.receipt,t.name)
 console.log('PASS '+t.name)
}
console.log('NSIS dev-guard tests used no installation, registry writes, elevation or service operations.')
