// Executes the product readers/routing and main's real initializer/reconcile
// closures with synthetic boundaries. No real task, registry or engine starts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
const require = createRequire(process.env.ORGTREE_TEST_DEPS || import.meta.url)
const {buildSync, transformSync} = require('esbuild')
const product = name => {
  const module = {exports:{}}
  vm.runInNewContext(buildSync({entryPoints:[`apps/desktop/main/${name}.ts`],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,
    {module,exports:module.exports,require,process,Buffer,URL,Error,console,setTimeout,clearTimeout})
  return module.exports
}
const startup = product('runonstartup'), launch = product('sessionlaunch')
const main = fs.readFileSync('apps/desktop/main/index.ts','utf8')
const reading = tasks => ({code:0,stdout:JSON.stringify(tasks),stderr:''})

test('reader distinguishes a disabled task from enabled tasks with triggers off', () => {
  const script = startup.readScript()
  for (const enabled of [false,true]) {
    const fake = `$ErrorActionPreference='Stop'
$task=[pscustomobject]@{Enabled=$${enabled};Definition=[pscustomobject]@{Triggers=@([pscustomobject]@{Enabled=$true})}}
$folder=[pscustomobject]@{}
$folder|Add-Member ScriptMethod GetTask {param($name) return $task}
$service=[pscustomobject]@{}
$service|Add-Member ScriptMethod Connect {}
$service|Add-Member ScriptMethod GetFolder {param($name) return $folder}
function New-Object {param($ComObject) if($ComObject -ne 'Schedule.Service'){throw 'Unexpected COM'};return $service}
${script}`
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(fake,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true})
    assert.equal(result.status,0,result.stderr)
    const tasks=startup.parseStartupTasks(result.stdout)
    assert.equal(tasks?.bootEnabled,enabled,'task enablement must be retained independently')
    assert.equal(tasks?.bootTriggers,true,'trigger choice must survive task disablement')
    assert.equal(startup.startupOn(tasks),true,'damaged task does not turn operator choice off')
  }
})

test('fully disabled boot task refuses before schtasks and never becomes a managed launch', async () => {
  const calls=[]
  const runner=async(file,args)=>{calls.push([file,...args]);return reading({boot:false,helper:false,bootEnabled:false,helperEnabled:false,bootTriggers:true,helperTriggers:true})}
  await assert.rejects(launch.launchBackground({},true,runner),/disabled/i)
  assert.equal(calls.length,1,'read only: no demand launch or fallback process')
})

test('triggers off preserves demand launch through Session 0', async () => {
  const calls=[]
  const runner=async(file,args)=>{calls.push([file,...args]);return file==='schtasks'?{code:0,stdout:'',stderr:''}:reading({boot:false,helper:false,bootEnabled:true,helperEnabled:true,bootTriggers:false,helperTriggers:false})}
  assert.equal(await launch.launchBackground({},true,runner),'boot')
  assert.deepEqual(calls.filter(c=>c[0]==='schtasks'),[['schtasks','/Run','/TN','Orgtree Background Engine']])
})

test('actual startup initializer shows launch refusal and Retry settles it without an external wake', async () => {
  const start=main.indexOf('      let automaticStartupRetry = true')
  const end=main.indexOf('      if (coreLifecycle) { await coreLifecycle.complete()',start)
  assert.ok(start>=0 && end>start)
  const messages=[];let attempts=0
  const context={Error,AbortController,CONVERSION_FAILED:'conversion failed:',quitting:false,app:{isPackaged:true},resumeEngineStartup:undefined,
    coreLifecycle:{configureRecovery(){}},console,
    initialEngine:async()=>{if(++attempts===1)throw new Error('The boot task is disabled')},
    dialog:{showMessageBox:async options=>{messages.push(options);return {response:0}}}}
  const code=transformSync(`(async()=>{${main.slice(start,end)};return 'ready'})()`,{loader:'ts'}).code
  const outcome=vm.runInNewContext(code,context)
  const settled=await Promise.race([outcome,new Promise(resolve=>setTimeout(()=>resolve('hung'),50))])
  assert.equal(messages.length,1,'failure must be visible before recovery waits')
  assert.match(messages[0].detail,/disabled/)
  assert.ok(messages[0].buttons.includes('Retry'))
  assert.equal(settled,'ready','Retry must resume the same initializer')
  assert.equal(attempts,2)
})

test('reconciliation retains Run on boot while the task itself is damaged', async () => {
  const start=main.indexOf('  const reconcileRunOnStartup = async () => {')
  const end=main.indexOf('  const setEffectiveTheme =',start)
  const changes=[]
  const context={process:{platform:'win32'},app:{isPackaged:true},bootTask:true,console,
    preferences:{get:()=>({startAtLogin:true})},setPreferences:change=>changes.push(change),rebuildTray(){},
    readStartupTasks:async()=>({boot:false,helper:false,bootEnabled:false,helperEnabled:false,bootTriggers:true,helperTriggers:true}),startupOn:startup.startupOn}
  await vm.runInNewContext(transformSync(`${main.slice(start,end)};reconcileRunOnStartup()`,{loader:'ts'}).code,context)
  assert.equal(changes.length,0,'task damage must not persist a new operator preference')
})
