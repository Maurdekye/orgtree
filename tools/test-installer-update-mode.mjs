// Compile and RUN the repository's real customInit macro and check what it did
// to silence, to the install mode, and to the recorded upgrade selection.
//
// The distinction this file exists to protect: `isUpdated` is REDEFINED by
// customWelcomePage to `$OrgUpgradeSelected == "1"`, so it answers true for a
// manual Upgrade as well as for the auto-updater's --updated entry point.
// `orgtreeOriginalIsUpdated` is the snapshot of the generated predicate and
// answers true only for a real --updated run. Silence belongs to the second.
//
// Keying `SetSilent silent` off the first was the 2.1.3-RC5 field failure: once
// preInit carried $OrgUpgradeSelected into the elevated inner instance, that
// instance matched the redefined predicate and silenced itself, so after
// approving the UAC prompt the user saw no Installing page and no finish page
// — and the finish page is the only place an assisted installer offers to run
// the app. The install completed and the desktop was never relaunched.
//
// The old version of this test defined both predicates to the same value, so
// it could not tell them apart and the regression passed straight through it.
//
// Nothing here installs, elevates, writes a registry key, starts an
// application or touches any real installation.
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

// `updated` is the generated --updated predicate. `selected` is the value of
// $OrgUpgradeSelected on entry: "" for a first instance, "1" for an elevated
// inner instance that inherited the outer instance's choice in preInit.
//
// $INSTDIR and the three inherited OrgUpgrade* values are deliberately
// different from each other, so overwriting one is visible in the receipt
// rather than accidentally matching what was already there.
const INSTDIR='Z:\\Not The Inherited Directory'
const tests=[
 // The auto-updater entry point. Silent, and it records the selection and the
 // mode for the pages that follow. This is the behaviour to preserve.
 {name:'update-machine',updated:1,selected:'',target:'C:\\Program Files\\Orgtree',
  expect:{mode:'all',silent:1,selected:'1',choice:'upgrade',upgradeMode:'CurrentUser',upgradeDir:INSTDIR}},
 {name:'update-user',updated:1,selected:'',target:'D:\\User Apps\\Orgtree',
  expect:{mode:'CurrentUser',silent:1,selected:'1',choice:'upgrade',upgradeMode:'CurrentUser',upgradeDir:INSTDIR}},
 {name:'old-client-no-directory',updated:1,selected:'',target:'',
  expect:{mode:'CurrentUser',silent:1,selected:'1',choice:'upgrade',upgradeMode:'CurrentUser',upgradeDir:INSTDIR}},

 // An ordinary manually launched Setup: no flag, and no choice made yet.
 {name:'manual-install',updated:0,selected:'',target:'C:\\Program Files\\Orgtree',
  expect:{mode:'CurrentUser',silent:0,selected:'',choice:'',upgradeMode:'',upgradeDir:''}},

 // THE REGRESSION. The elevated inner instance of a MANUAL Upgrade: no
 // --updated on its command line, but $OrgUpgradeSelected inherited as "1".
 // It must NOT silence itself, or the user is left with no window at all
 // after approving the prompt. Its inherited selection must also survive
 // untouched: the outer instance showed the user that directory and scope and
 // got their agreement, and an elevated process cannot re-derive them because
 // it does not see the same per-user registry.
 {name:'elevated-inner-manual-upgrade',updated:0,selected:'1',target:'C:\\Program Files\\Orgtree',
  inherit:{choice:'upgrade',upgradeMode:'all',upgradeDir:'C:\\Program Files\\Orgtree'},
  expect:{mode:'CurrentUser',silent:0,selected:'1',choice:'upgrade',upgradeMode:'all',upgradeDir:'C:\\Program Files\\Orgtree'}},

 // The elevated inner instance of an --updated run is still an --updated run:
 // it carries the flag on its own command line and stays silent.
 {name:'elevated-inner-updated',updated:1,selected:'1',target:'C:\\Program Files\\Orgtree',
  inherit:{choice:'upgrade',upgradeMode:'all',upgradeDir:'C:\\Program Files\\Orgtree'},
  expect:{mode:'all',silent:1,selected:'1',choice:'upgrade',upgradeMode:'CurrentUser',upgradeDir:INSTDIR}},
]
for(const t of tests){
 const inherit=t.inherit||{choice:'',upgradeMode:'',upgradeDir:''}
 const exe=path.join(temp,t.name+'.exe'),receipt=path.join(temp,t.name+'.txt')
 const nsi=`!include LogicLib.nsh
Name "Orgtree update-mode test"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall normal
Var installMode
Var perMachineInstallationFolder
Var perUserInstallationFolder
Var OrgUpgradeChoice
Var OrgUpgradeInstallMode
Var OrgUpgradeInstallDir
Var OrgUpgradeSelected
# Exactly as build/installer.nsh defines them: the redefined predicate reads
# the manual selection, the snapshot reads the real --updated flag.
!define isUpdated '$OrgUpgradeSelected == "1"'
!define orgtreeOriginalIsUpdated '${t.updated} == 1'
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
 StrCpy $INSTDIR "${INSTDIR}"
 StrCpy $perMachineInstallationFolder "C:\\Program Files\\Orgtree"
 StrCpy $perUserInstallationFolder "D:\\User Apps\\Orgtree"
 StrCpy $OrgUpgradeSelected "${t.selected}"
 StrCpy $OrgUpgradeChoice "${inherit.choice}"
 StrCpy $OrgUpgradeInstallMode "${inherit.upgradeMode}"
 StrCpy $OrgUpgradeInstallDir "${inherit.upgradeDir}"
 !insertmacro customInit
 StrCpy $5 0
 \${If} \${Silent}
  StrCpy $5 1
 \${EndIf}
 FileOpen $0 "${receipt}" w
 FileWrite $0 "$installMode|$5|$OrgUpgradeSelected|$OrgUpgradeChoice|$OrgUpgradeInstallMode|$OrgUpgradeInstallDir"
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
 const e=t.expect
 const expected=[e.mode,e.silent,e.selected,e.choice,e.upgradeMode,e.upgradeDir].join('|')
 assert.equal(fs.readFileSync(receipt,'utf8'),expected,t.name)
 console.log('PASS '+t.name)
}
fs.rmSync(temp,{recursive:true,force:true})
console.log('NSIS update-mode tests used no installation, registry writes, elevation or service operations.')
