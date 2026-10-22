// Where the desktop starts the background engine (decision 94; the user,
// 2026-10-22 07:27Z and 07:28Z: "the main engine should always run in session
// 0, through restarts, updates, reboots, etc."). Fakes only: no task, UAC
// prompt, registry or engine is reached.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {buildSync} from 'esbuild'
const require=createRequire(import.meta.url),module={exports:{}}
vm.runInNewContext(buildSync({entryPoints:['apps/desktop/main/sessionlaunch.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,
  {module,exports:module.exports,require,process,Buffer,URL,setTimeout,clearTimeout,console})
const {route,launchBackground}=module.exports
// a verified console session: decision 93 sent every start from here into it
const atConsole={session:7,console:7,ownsConsole:true,known:true,operatorSid:'fixture',elevated:false}

test('invariant 1: every start goes to the Session 0 boot task while it is installed, at the console too',()=>{
  for (const tasks of [{boot:true,helper:true},{boot:true,helper:true,interactive:true},{boot:true,helper:null}]) {
    assert.equal(route(tasks,atConsole),'boot',JSON.stringify(tasks))
    assert.equal(route(tasks,null),'boot',JSON.stringify(tasks))
  }
  assert.equal(route({boot:false,helper:false},atConsole),'boot','Run on boot off: the task still starts it on demand, in Session 0 (coordinator Q4)')
  assert.equal(route({boot:null,helper:null},atConsole),'managed','no boot task (a per-user installation): this desktop starts its own')
  assert.equal(route(null,atConsole),'managed','no installer tasks readable (development)')
})

const tasksOutput=json=>({code:0,stdout:`${JSON.stringify(json)}\r\n`,stderr:''})

test('invariant 1: a start or recovery runs only the boot task, never another task or a session launcher',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orgtree-route-test-'))
  const calls=[]
  const runner=async(file,args)=>{
    calls.push([file,...args])
    if (file.toLowerCase().endsWith('powershell.exe')) return tasksOutput({boot:true,helper:true,interactive:true})
    if (args[0]==='session-launch') return {code:0,stdout:JSON.stringify(atConsole),stderr:''}
    return {code:0,stdout:'',stderr:''}
  }
  const options={binary:'C:\\Program Files\\Orgtree\\resources\\engine\\orgtree-engine.exe',dataRoot:root,forbiddenRoot:path.join(os.tmpdir(),'orgtree-route-forbidden')}
  assert.equal(await launchBackground(options,false,runner),'boot')
  assert.deepEqual(calls.filter(c=>c[0]==='schtasks'),[['schtasks','/Run','/TN','Orgtree Background Engine']],JSON.stringify(calls))
  assert.ok(!calls.some(c=>c.includes('session-launch')),'no session launcher is asked where the desktop runs')
  assert.deepEqual(fs.readdirSync(root),[],'no ask or attempt file is written')
})

test('the session-1 launch and the one-off "Run this session as admin" are gone from the desktop (user Q2)',()=>{
  for (const name of ['inConsole','launchContext','startInSession','runSessionAsAdmin','elevationScript','parseAttempt','readAttempt','lastFailure','failureMessage','writeAsk']) {
    assert.equal(module.exports[name],undefined,name)
  }
})
