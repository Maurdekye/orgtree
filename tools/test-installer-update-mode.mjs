import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-update-mode-'))
const compiler=process.env.ORGTREE_MAKENSIS || path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe')
if(!fs.existsSync(compiler))throw Error('INERT: NSIS compiler unavailable; set ORGTREE_MAKENSIS')
const source=fs.readFileSync('build/installer.nsh','utf8')
const macro=source.match(/!macro customInit\r?\n[\s\S]*?\r?\n!macroend/)[0]
const tests=[
 {name:'update-machine',updated:1,target:'C:\\Program Files\\Orgtree',mode:'all',silent:1},
 {name:'update-user',updated:1,target:'D:\\User Apps\\Orgtree',mode:'CurrentUser',silent:1},
 {name:'old-client-no-directory',updated:1,target:'',mode:'CurrentUser',silent:1},
 {name:'manual-install',updated:0,target:'C:\\Program Files\\Orgtree',mode:'CurrentUser',silent:0},
]
for(const t of tests){
 const exe=path.join(temp,t.name+'.exe'),receipt=path.join(temp,t.name+'.txt')
 const nsi=`!include LogicLib.nsh
Name "Orgtree update-mode test"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall normal
Var installMode
Var perMachineInstallationFolder
Var perUserInstallationFolder
!define isUpdated '${t.updated} == 1'
!macro GetDParameter out
 StrCpy \${out} "${t.target}"
!macroend
!macro setInstallModePerAllUsers
 StrCpy $installMode all
!macroend
!macro setInstallModePerUser
 StrCpy $installMode CurrentUser
!macroend
${macro}
Function .onInit
 StrCpy $installMode CurrentUser
 StrCpy $perMachineInstallationFolder "C:\\Program Files\\Orgtree"
 StrCpy $perUserInstallationFolder "D:\\User Apps\\Orgtree"
 !insertmacro customInit
 StrCpy $5 0
 \${If} \${Silent}
  StrCpy $5 1
 \${EndIf}
 FileOpen $0 "${receipt}" w
 FileWrite $0 "$installMode|$5"
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
 assert.equal(run.status,0,run.stdout+run.stderr)
 assert.equal(fs.readFileSync(receipt,'utf8'),t.mode+'|'+t.silent,t.name)
 console.log('PASS '+t.name)
}
console.log('NSIS update-mode tests used no installation, registry writes, elevation or service operations.')
