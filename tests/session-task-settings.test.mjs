// Executes the emitted PowerShell against in-memory Registry/Task Scheduler
// doubles. No real task, registry write, process launcher or UAC can be reached.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {build} from 'esbuild'

const output = process.env.ORGTREE_TEST_OUTPUT
if (!output) throw Error('ORGTREE_TEST_OUTPUT must name an owned build directory')
fs.mkdirSync(output, {recursive:true})
const load = async name => {
  const file = path.join(output, name + '.cjs')
  await build({entryPoints:[`apps/desktop/main/${name}.ts`],outfile:file,bundle:true,platform:'node',format:'cjs',logLevel:'error'})
  return createRequire(import.meta.url)(file)
}
const startup = await load('runonstartup'), admin = await load('runasadmin')
const fixture = String.raw`
$ErrorActionPreference='Stop'
$sid='S-1-5-21-111-222-333-1001'
$events=[Collections.Generic.List[string]]::new()
$values=@{Id='fixture';OperatorSid=$sid;RunAsAdministrator=0;RunOnStartup=0}
$store=@{}
foreach($name in @('Orgtree Background Engine','Orgtree Credential Helper','Orgtree User Session Engine')) {
  $marker=switch($name) {'Orgtree Background Engine' {'boot'} 'Orgtree Credential Helper' {'credential-helper'} default {'user-session'}}
  $store[$name]=@{Marker="com.maurdekye.orgtree.$marker.v1:fixture";Level=0;Trigger=$false;Enabled=$true;Logon=3;User=$null;XmlUser=$null}
}
$store['Orgtree Background Engine'].Logon=2
# User: the COM principal's UserId (the operator's SID unless set); XmlUser: a
# <Principals> UserId in the task XML (none unless set)
function Task([string]$Name) {
 $s=$store[$Name]
 $principal=if($s.XmlUser){"<Principals><Principal><UserId>$($s.XmlUser)</UserId></Principal></Principals>"}else{''}
 $xml="<Task><RegistrationInfo><Description>$($s.Marker)</Description></RegistrationInfo>$principal<Level>$($s.Level)</Level><Trigger>$($s.Trigger)</Trigger><Enabled>$($s.Enabled)</Enabled><Logon>$($s.Logon)</Logon></Task>"
 return [pscustomobject]@{Xml=$xml;Enabled=$s.Enabled;Definition=[pscustomobject]@{
  Principal=[pscustomobject]@{UserId=$(if($null -ne $s.User){$s.User}else{$sid});LogonType=$s.Logon;RunLevel=$s.Level}
  Settings=[pscustomobject]@{Enabled=$s.Enabled};Triggers=@([pscustomobject]@{Enabled=$s.Trigger})}}
}
$folder=[pscustomobject]@{}
$folder | Add-Member ScriptMethod GetTask {param($name) return (Task $name)}
$folder | Add-Member ScriptMethod RegisterTaskDefinition {
 param($name,$definition,$flags,$operator,$password,$logon,$acl)
 $events.Add("register:$name")
 if($flags -ne 20 -or $operator -cne $sid -or $password -or $acl -notmatch '^O:BAG:BAD:P') {throw 'unsafe registration'}
 if($failSecond -and @($events | Where-Object {$_ -like 'register:*'}).Count -eq 2) {throw 'injected task failure'}
 $store[$name].Level=$definition.Principal.RunLevel
 $store[$name].Trigger=$definition.Triggers[0].Enabled
 $store[$name].Enabled=$definition.Settings.Enabled
 $store[$name].Logon=$logon
}
$folder | Add-Member ScriptMethod RegisterTask {
 param($name,$xml,$flags,$operator,$password,$logon,$acl)
 $events.Add("restore:$name");if($failRestore) {throw 'injected restore failure'};$d=([xml]$xml).Task
 $store[$name].Level=[int]$d.Level;$store[$name].Trigger=[bool]::Parse($d.Trigger)
 $store[$name].Enabled=[bool]::Parse($d.Enabled);$store[$name].Logon=[int]$d.Logon
}
$service=[pscustomobject]@{}
$service | Add-Member ScriptMethod Connect {}
$service | Add-Member ScriptMethod GetFolder {param($name) return $folder}
function New-Object {param([string]$ComObject) if($ComObject -cne 'Schedule.Service') {throw 'unexpected COM access'};return $service}
$key=[pscustomobject]@{}
$key | Add-Member ScriptMethod GetValue {param($name) return $values[$name]}
$key | Add-Member ScriptMethod SetValue {param($name,$value,$kind) if($failWrite) {throw 'injected registry failure'};$events.Add("write:$name");$values[$name]=$value}
$key | Add-Member ScriptMethod DeleteValue {param($name,$throwIfMissing) $events.Add("delete:$name");$values.Remove($name)}
$key | Add-Member ScriptMethod SetAccessControl {param($acl)}
$key | Add-Member ScriptMethod Dispose {}
$fakeHive=[pscustomobject]@{}
$fakeHive | Add-Member ScriptMethod OpenSubKey {param($name,$write) return $key}
$fakeHive | Add-Member ScriptMethod CreateSubKey {param($name,$permission,$acl) return $key}
$fakeHive | Add-Member ScriptMethod Dispose {}
`
function execute(script, setup='') {
  const registry = /\[Microsoft\.Win32\.RegistryKey\]::OpenBaseKey\('[^']+', 'Registry64'\)/g
  const safe = script.replace(registry,'$fakeHive').replace('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value','$sid')
  assert.doesNotMatch(safe, /::OpenBaseKey|WindowsIdentity|Start-Process|schtasks|Invoke-WebRequest/)
  const program = fixture + '\n' + setup + '\n$failure=$null\ntry {\n' + safe + '\n} catch {$failure=$_.Exception.Message}\n' +
    '[pscustomobject]@{failure=$failure;events=@($events);values=$values;tasks=$store} | ConvertTo-Json -Depth 9 -Compress'
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(program,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true})
  assert.equal(r.status,0,r.stderr)
  const line=r.stdout.split(/\r?\n/).findLast(l=>l.startsWith('{"failure"'))
  assert.ok(line, r.stdout+'\n'+r.stderr)
  return JSON.parse(line)
}
/** The NON-elevated launcher with its elevated start and its registry
 *  replaced: the elevated script "exits" with `code`, having left `planted`
 *  (or nothing) as the report value. */
function launch(report, code, planted) {
  const launcher = admin.elevatedArgs('Write-Output elevated', report)[3]
  const safe = launcher.replace(/\$p = Start-Process [^\n]*/, `$p = [pscustomobject]@{ExitCode=${code}}`)
    .replace(/\[Microsoft\.Win32\.RegistryKey\]::OpenBaseKey\('[^']+', 'Registry64'\)/g, '$fakeHive')
  assert.doesNotMatch(safe, /Start-Process|::OpenBaseKey/)
  const prelude = [
    `$planted=${planted == null ? '$null' : `'${planted.replace(/'/g, "''")}'`}`,
    '$reportKey=[pscustomobject]@{}',
    "$reportKey | Add-Member ScriptMethod GetValue {param($name) if($name -ceq 'LastChangeFailure') {return $planted}}",
    '$reportKey | Add-Member ScriptMethod Dispose {}',
    '$fakeHive=[pscustomobject]@{}',
    `$fakeHive | Add-Member ScriptMethod OpenSubKey {param($name) if($name -ceq '${report.key}') {return $reportKey}}`,
    '$fakeHive | Add-Member ScriptMethod Dispose {}',
  ].join('\n')
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(prelude+'\n'+safe,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true})
  return {status:r.status, reason:admin.elevatedFailure(r.stdout), output:r.stdout+r.stderr}
}
// Decision 94 retires the "Orgtree User Session Engine" task: the next update
// deletes it. A leftover one (this fixture's third task) is never changed here.
const USER_SESSION = 'Orgtree User Session Engine'
test('startup off removes automatic triggers from the boot and helper tasks but preserves demand launch',()=>{
  for (const on of [true,false]) for (const asAdmin of [0,1]) {
    const r=execute(startup.elevatedStartupScript(on), `$values.RunAsAdministrator=${asAdmin}; $store.Values | ForEach-Object {$_.Enabled=$false;$_.Trigger=$true}`)
    assert.equal(r.failure,null)
    for(const name of [startup.BOOT_TASK, startup.HELPER_TASK]){
      assert.equal(r.tasks[name].Enabled,true,`${name} keeps demand launch`)
      assert.equal(r.tasks[name].Trigger,on,`${name} trigger (startup ${on}, admin ${asAdmin})`)
    }
    assert.ok(!r.events.includes(`register:${USER_SESSION}`),'the retired user-session task is left alone')
    assert.equal(r.values.RunOnStartup,Number(on))
  }
})
test('invariants 7 and 8: admin on and off set the boot and helper tasks together, keeping each logon type',()=>{
  for(const on of [true,false]) for (const runs of [0,1]) {
    const r=execute(admin.elevatedWriteScript(on),`$values.RunOnStartup=${runs}; $store.Values | ForEach-Object {$_.Level=1;$_.Trigger=${runs===1 ? '$true' : '$false'}}`)
    assert.equal(r.failure,null)
    // one prompt sets both run levels: the Session 0 engine and the session-1 helper
    for(const name of [admin.BOOT_TASK, admin.HELPER_TASK]) assert.equal(r.tasks[name].Level,Number(on),name)
    assert.equal(r.tasks[admin.BOOT_TASK].Logon,2,'the boot task stays S4U')
    assert.equal(r.tasks[admin.HELPER_TASK].Logon,3)
    assert.equal(r.tasks[admin.BOOT_TASK].Trigger,runs===1,'Run as admin never changes the boot trigger')
    assert.equal(r.tasks[admin.HELPER_TASK].Trigger,runs===1,'nor the helper trigger')
    assert.ok(!r.events.includes(`register:${USER_SESSION}`),'the retired user-session task is left alone')
    assert.equal(r.tasks[USER_SESSION].Level,1,'and keeps what it had')
    assert.equal(r.values.RunAsAdministrator,Number(on))
  }
})
test('Run as admin no longer needs the user-session task',()=>{
  const r=execute(admin.elevatedWriteScript(true),`$store.Remove('${USER_SESSION}')`)
  assert.equal(r.failure,null)
  for(const name of [admin.BOOT_TASK, admin.HELPER_TASK]) assert.equal(r.tasks[name].Level,1,name)
  assert.equal(r.values.RunAsAdministrator,1)
})
test('an owned task with an unexpected logon type refuses before any change',()=>{
  for (const [name,logon] of [[admin.BOOT_TASK,3],[admin.HELPER_TASK,2]]) {
    const r=execute(admin.elevatedWriteScript(true),`$store['${name}'].Logon=${logon}`)
    assert.match(r.failure,/operator does not match/)
    assert.deepEqual(r.events,[])
  }
})
test('a foreign task refuses all writes before changing any task',()=>{
  for(const script of [startup.elevatedStartupScript(false),admin.elevatedWriteScript(true)]){
    const r=execute(script,"$store['Orgtree Credential Helper'].Marker='foreign'")
    assert.match(r.failure,/Refusing to change/)
    assert.deepEqual(r.events,[])
  }
})
test('failed admin task update restores preceding task updates and preserves the setting',()=>{
  const r=execute(admin.elevatedWriteScript(true),'$failSecond=$true')
  assert.match(r.failure,/injected task failure/)
  assert.equal(r.values.RunAsAdministrator,0)
  for(const task of Object.values(r.tasks)) assert.equal(task.Level,0)
  assert.equal(r.events.filter(e=>e.startsWith('restore:')).length,1)
})
test('failed protected setting write rolls every task back',()=>{
  const r=execute(admin.elevatedWriteScript(true),'$failWrite=$true')
  assert.match(r.failure,/injected registry failure/)
  assert.equal(r.values.RunAsAdministrator,0)
  for(const task of Object.values(r.tasks)) assert.equal(task.Level,0)
  assert.equal(r.events.filter(e=>e.startsWith('restore:')).length,2,'the boot and helper tasks')
})
test('failed startup changes restore prior triggers and never rewrite the stored choice',()=>{
  for(const failure of ['$failSecond=$true','$failWrite=$true']) {
    const r=execute(startup.elevatedStartupScript(true),failure)
    assert.match(r.failure,/injected/)
    assert.equal(r.values.RunOnStartup,0)
    for(const name of [startup.BOOT_TASK, startup.HELPER_TASK]) assert.equal(r.tasks[name].Trigger,false,name)
  }
})
// The installer registers its tasks by SID, and Task Scheduler's COM principal
// can name the account instead: on alpha.34 both tasks read UserId '<account
// name>' while their XML held the SID (measured read-only on the user's PC,
// 2026-10-22 13:10Z), so the raw comparison refused the installer's own tasks
// ("Changing the setting failed (exit code 1)"). These cases resolve the
// account that runs the test, through Windows.
const ACCOUNT='$me=[Security.Principal.WindowsIdentity]::GetCurrent();$sid=$me.User.Value;$values.OperatorSid=$sid'
test('the installer\'s tasks match by SID when Task Scheduler gives their account name',()=>{
  for(const user of ['$me.Name.Split([char]92)[-1]','$me.Name','$sid']) {
    const setup=`${ACCOUNT};$store.Values | ForEach-Object {$_.User=${user}}`
    for(const on of [true,false]) {
      const r=execute(admin.elevatedWriteScript(on),setup)
      assert.equal(r.failure,null,`Run as admin ${on}, principal ${user}`)
      for(const name of [admin.BOOT_TASK, admin.HELPER_TASK]) assert.equal(r.tasks[name].Level,Number(on),name)
      assert.equal(r.values.RunAsAdministrator,Number(on))
      const s=execute(startup.elevatedStartupScript(on),setup)
      assert.equal(s.failure,null,`Run on boot ${on}, principal ${user}`)
      for(const name of [startup.BOOT_TASK, startup.HELPER_TASK]) assert.equal(s.tasks[name].Trigger,on,name)
      assert.equal(s.values.RunOnStartup,Number(on))
    }
  }
})
test('a principal of another account or of none, or a record without an operator, refuses before any change',()=>{
  const scripts=[admin.elevatedWriteScript(true),admin.elevatedWriteScript(false),startup.elevatedStartupScript(true)]
  for(const user of ["'SYSTEM'","'S-1-5-18'","'no-such-account-7f3a9c'","''"]) for(const script of scripts) {
    const r=execute(script,`$store.Values | ForEach-Object {$_.User=${user}}`)
    assert.match(r.failure ?? '',/operator does not match/,user)
    assert.deepEqual(r.events,[],`${user}: nothing changed`)
  }
  // an empty principal never matches a record that names no operator
  for(const script of scripts) {
    const r=execute(script,"$values.Remove('OperatorSid');$store.Values | ForEach-Object {$_.User=''}")
    assert.match(r.failure ?? '',/operator does not match/)
    assert.deepEqual(r.events,[])
  }
})
test('the XML principal, which the installer registered and checks, comes before the COM name',()=>{
  // its SID decides even when the COM side names no account Windows knows
  const xmlSid="$store.Values | ForEach-Object {$_.XmlUser=$sid;$_.User='no-such-account-7f3a9c'}"
  const r=execute(admin.elevatedWriteScript(true),xmlSid)
  assert.equal(r.failure,null)
  assert.equal(r.values.RunAsAdministrator,1)
  assert.equal(execute(startup.elevatedStartupScript(false),xmlSid).failure,null)
  // and an XML principal of another account refuses, whatever the COM side says
  for(const script of [admin.elevatedWriteScript(true),startup.elevatedStartupScript(true)]) {
    const other=execute(script,"$store.Values | ForEach-Object {$_.XmlUser='S-1-5-18'}")
    assert.match(other.failure ?? '',/operator does not match/)
    assert.deepEqual(other.events,[])
  }
})
// A failure's own words (alpha.34 showed only "exit code 1"): the elevated
// script leaves them in the protected Runtime key under this change's nonce,
// and the launcher reads them back once the elevated PowerShell has exited.
const REPORT={hive:'LocalMachine',key:'SOFTWARE\\Orgtree\\Runtime',nonce:'0123456789abcdef0123456789abcdef'}
test('a refused change leaves its message under this change\'s nonce, and writes nothing else',()=>{
  for(const script of [admin.elevatedWriteScript(true,REPORT),admin.elevatedWriteScript(false,REPORT),startup.elevatedStartupScript(true,startup.INSTALLED,REPORT)]) {
    const r=execute(script,"$store['Orgtree Credential Helper'].Marker='foreign'")
    assert.match(r.failure,/Refusing to change/)
    assert.equal(r.values.LastChangeFailure,`${REPORT.nonce} Refusing to change a task Orgtree did not install: Orgtree Credential Helper`)
    assert.deepEqual(r.events,['write:LastChangeFailure'],'the message is the only write')
  }
})
test('a failed change also reports what its rollback could not restore',()=>{
  const r=execute(admin.elevatedWriteScript(true,REPORT),'$failSecond=$true;$failRestore=$true')
  assert.match(r.failure,/injected task failure/)
  // PowerShell words a failing method as 'Exception calling "<method>" with
  // "7" argument(s): "<its message>"', a real COM failure too
  assert.match(r.values.LastChangeFailure ?? '',new RegExp(`^${REPORT.nonce} .*"injected task failure"; the task Orgtree (Background Engine|Credential Helper) could not be restored: .*"injected restore failure"$`))
  assert.equal(r.values.RunAsAdministrator,0)
})
test('a change that succeeds clears an earlier failure message',()=>{
  for(const script of [admin.elevatedWriteScript(true,REPORT),startup.elevatedStartupScript(true,startup.INSTALLED,REPORT)]) {
    const r=execute(script,"$values.LastChangeFailure='fedcba earlier failure'")
    assert.equal(r.failure,null)
    assert.equal(r.values.LastChangeFailure,undefined)
    assert.ok(r.events.includes('delete:LastChangeFailure'),r.events.join())
  }
})
test('the launcher passes back only this change\'s message, and keeps the exit code',()=>{
  const said='Zugriff verweigert — ü (0x80070005)'
  const failed=launch(REPORT,1,`${REPORT.nonce} ${said}`)
  assert.equal(failed.status,1)
  assert.equal(failed.reason,said,failed.output)
  assert.equal(launch(REPORT,1,`fedcba9876543210fedcba9876543210 ${said}`).reason,null,'an earlier change\'s message')
  assert.equal(launch(REPORT,1,null).reason,null,'none left')
  const done=launch(REPORT,0,`${REPORT.nonce} ${said}`)
  assert.equal(done.status,0)
  assert.equal(done.reason,null,'a change that succeeded shows no failure')
})
test('the elevated script and the launcher agree: a refused change shows its own reason',()=>{
  for(const script of [admin.elevatedWriteScript(true,REPORT),startup.elevatedStartupScript(false,startup.INSTALLED,REPORT)]) {
    const r=execute(script,"$store['Orgtree Background Engine'].Marker='foreign'")
    assert.equal(launch(REPORT,1,r.values.LastChangeFailure).reason,'Refusing to change a task Orgtree did not install: Orgtree Background Engine')
  }
})
