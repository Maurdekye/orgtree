// Inert, silent NSIS control: execute the actual failure/exit hooks and durable
// logger. The sole task-helper launch is replaced with stack results. No task,
// registry, elevation, application payload or installation operation exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawnSync} from 'node:child_process'
const source=fs.readFileSync('build/installer.nsh','utf8')
const compiler=process.env.ORGTREE_MAKENSIS || path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/makensis.exe')
const macro=name=>{
  const value=source.match(new RegExp(`^!macro ${name}(?:[ \\t]+[^\\r\\n]*)?\\r?\\n[\\s\\S]*?^!macroend`,'m'))?.[0]
  assert.ok(value,`actual ${name} macro must exist, including its parameters`)
  return value
}
const func=name=>source.match(new RegExp(`^[ \\t]*Function ${name.replaceAll('.','\\.')}\\r?\\n[\\s\\S]*?^[ \\t]*FunctionEnd`,'m'))?.[0]
function execute(name,body) {
  assert.ok(fs.existsSync(compiler),'NSIS compiler is required for an executed verdict')
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),`orgtree-inert-${name}-`))
  const exe=path.join(dir,'control.exe'), nsi=path.join(dir,'control.nsi')
  const restore=func('orgtreeRestoreBootTasks')
  assert.ok(restore,'actual rollback function must exist')
  const safe=restore.replace(/^[ \t]*nsExec::ExecToStack [^\r\n]+/m,'        Push "synthetic rollback completed"\n        Push "0"')
  assert.notEqual(safe,restore,'task-helper boundary must have been substituted')
  assert.doesNotMatch(safe,/nsExec|powershell|ExecWait|ExecShell/,'no process launch can remain')
  const code=`Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
Name "Inert task rollback control"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Var OrgBootPending
Var OrgBootAction
Var OrgLogPath
Var OrgLogStage
Var OrgLogDetail
!define ORGTREE_LOG_MAX_BYTES 262144
${macro('OrgLog')}
${func('orgtreeInstallerLog')}
${safe}
${func('.onInstFailed')}
${func('.onGUIEnd')}
${macro('BootResult')}
Function .onInit
  StrCpy $OrgBootPending "1"
  StrCpy $OrgBootAction "Register"
FunctionEnd
Section
${body}
SectionEnd
`
  fs.writeFileSync(nsi,code,'utf8')
  const compiled=spawnSync(compiler,['/V2',nsi],{encoding:'utf8',windowsHide:true,timeout:30000})
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr)
  const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:10000})
  assert.equal(run.signal,null)
  assert.equal(run.error,undefined)
  const log=path.join(dir,'orgtree-installer.log')
  return {status:run.status,log:fs.existsSync(log)?fs.readFileSync(log,'utf8'):''}
}
test('silent Quit after Prepare invokes the real exit rollback hook',()=>{
  const r=execute('prepare','  Quit')
  assert.equal(r.status,0)
  assert.equal((r.log.match(/\[boot-rollback\]/g)||[]).length,1,r.log)
})
test('copy Abort invokes the real installation-failure rollback hook',()=>{
  const r=execute('copy','  Abort')
  assert.notEqual(r.status,0)
  assert.equal((r.log.match(/\[boot-rollback\]/g)||[]).length,1,r.log)
})
test('Register failure durably logs bounded stderr and restores once before exit',()=>{
  const r=execute('register',`  Push "${'x'.repeat(900)}"
  Push "2"
  !insertmacro BootResult`)
  assert.equal(r.status,2)
  assert.match(r.log,/\[boot-result\] action=Register; exit=2; /)
  assert.equal(r.log.match(/\[boot-result\] action=Register; exit=2; (x+)/)?.[1].length,640)
  assert.equal((r.log.match(/\[boot-rollback\]/g)||[]).length,1,r.log)
})
test('committed exit never invokes the rollback helper',()=>{
  const r=execute('committed','  StrCpy $OrgBootPending "0"\n  Quit')
  assert.equal(r.status,0)
  assert.equal(r.log,'')
})
test('refused Prepare does not replay a retained snapshot through failure or exit hooks',()=>{
  const r=execute('preflight',`  StrCpy $OrgBootPending "0"
  StrCpy $OrgBootAction "Prepare"
  Push "synthetic snapshot persistence failure"
  Push "2"
  !insertmacro BootResult`)
  assert.equal(r.status,2)
  assert.match(r.log,/\[boot-result\] action=Prepare; exit=2; synthetic snapshot persistence failure/)
  assert.doesNotMatch(r.log,/\[boot-rollback\]/)
})
test('interactive Cancel uses the same restoration function through MUI',()=>{
  assert.match(source,/!define MUI_CUSTOMFUNCTION_ABORT orgtreeRestoreBootTasks/)
  // The MUI-generated callback has no independent task mutation or launch.
  // Native Cancel dispatch is a release UI check; this pins the shared hook.
  assert.ok(func('orgtreeRestoreBootTasks'))
  const prepare=source.slice(source.indexOf('        !insertmacro BootHelpers'),source.indexOf('    SectionEnd',source.indexOf('        !insertmacro BootHelpers')))
  assert.match(prepare,/StrCpy \$OrgBootPending "0"[\s\S]*-Action Prepare[\s\S]*!insertmacro BootResult\s+StrCpy \$OrgBootPending "1"/,'a refused Prepare must not arm exit rollback against an older snapshot')
})
