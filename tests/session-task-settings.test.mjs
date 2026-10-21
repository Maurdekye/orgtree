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
  $store[$name]=@{Marker="com.maurdekye.orgtree.$marker.v1:fixture";Level=0;Trigger=$false;Enabled=$true;Logon=3}
}
$store['Orgtree Background Engine'].Logon=2
function Task([string]$Name) {
 $s=$store[$Name]
 $xml="<Task><RegistrationInfo><Description>$($s.Marker)</Description></RegistrationInfo><Level>$($s.Level)</Level><Trigger>$($s.Trigger)</Trigger><Enabled>$($s.Enabled)</Enabled><Logon>$($s.Logon)</Logon></Task>"
 return [pscustomobject]@{Xml=$xml;Enabled=$s.Enabled;Definition=[pscustomobject]@{
  Principal=[pscustomobject]@{UserId=$sid;LogonType=$s.Logon;RunLevel=$s.Level}
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
 $events.Add("restore:$name");$d=([xml]$xml).Task
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
const USER_SESSION = 'Orgtree User Session Engine'
test('startup off removes automatic triggers from every owned task but preserves demand launch',()=>{
  for (const on of [true,false]) for (const asAdmin of [0,1]) {
    const r=execute(startup.elevatedStartupScript(on), `$values.RunAsAdministrator=${asAdmin}; $store.Values | ForEach-Object {$_.Enabled=$false;$_.Trigger=$true}`)
    assert.equal(r.failure,null)
    assert.equal(Object.keys(r.tasks).length,3)
    for(const [name,task] of Object.entries(r.tasks)){
      assert.equal(task.Enabled,true,`${name} keeps demand launch`)
      // the user-session engine moves in at sign-in only while Run as admin is on too (coordinator Q1)
      assert.equal(task.Trigger,name===USER_SESSION ? on && asAdmin===1 : on,`${name} trigger (startup ${on}, admin ${asAdmin})`)
    }
    assert.equal(r.values.RunOnStartup,Number(on))
  }
})
test('admin on and off update all three owned tasks, keeping each logon type',()=>{
  for(const on of [true,false]) for (const runs of [0,1]) {
    const r=execute(admin.elevatedWriteScript(on),`$values.RunOnStartup=${runs}; $store.Values | ForEach-Object {$_.Level=1;$_.Trigger=${runs===1 ? '$true' : '$false'}}`)
    assert.equal(r.failure,null)
    // the Session 0 boot engine follows the one toggle too (coordinator Q2)
    for(const name of [admin.BOOT_TASK, admin.HELPER_TASK, USER_SESSION]) assert.equal(r.tasks[name].Level,Number(on),name)
    assert.equal(r.tasks[admin.BOOT_TASK].Logon,2,'the boot task stays S4U')
    assert.equal(r.tasks[admin.HELPER_TASK].Logon,3)
    assert.equal(r.tasks[USER_SESSION].Logon,3)
    assert.equal(r.tasks[USER_SESSION].Trigger,on && runs===1,'the sign-in move follows Run as admin and Run on boot')
    assert.equal(r.tasks[admin.BOOT_TASK].Trigger,runs===1,'Run as admin never changes the boot trigger')
    assert.equal(r.tasks[admin.HELPER_TASK].Trigger,runs===1,'nor the helper trigger')
    assert.equal(r.values.RunAsAdministrator,Number(on))
  }
})
test('an owned task with an unexpected logon type refuses before any change',()=>{
  for (const [name,logon] of [[admin.BOOT_TASK,3],[USER_SESSION,2]]) {
    const r=execute(admin.elevatedWriteScript(true),`$store['${name}'].Logon=${logon}`)
    assert.match(r.failure,/operator does not match/)
    assert.deepEqual(r.events,[])
  }
})
test('a foreign task refuses all writes before changing any task',()=>{
  for(const script of [startup.elevatedStartupScript(false),admin.elevatedWriteScript(true)]){
    const r=execute(script,"$store['Orgtree User Session Engine'].Marker='foreign'")
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
  assert.equal(r.events.filter(e=>e.startsWith('restore:')).length,3)
})
test('failed startup changes restore prior triggers and never rewrite the stored choice',()=>{
  for(const failure of ['$failSecond=$true','$failWrite=$true']) {
    const r=execute(startup.elevatedStartupScript(true),failure)
    assert.match(r.failure,/injected/)
    assert.equal(r.values.RunOnStartup,0)
    for(const task of Object.values(r.tasks)) assert.equal(task.Trigger,false)
  }
})
