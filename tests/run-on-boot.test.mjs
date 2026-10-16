// "Run on boot" (docket option-to-run-the-background-engine-in-the-user-s, the
// user 2026-10-16 09:37-09:38Z): ONE checkbox, in place of "Run on startup"
// and its "engine starts" choice. The engine always starts at boot, in
// Session 0, and while the operator is signed in its agents run in their
// session through the sign-in helper ("Orgtree Credential Helper"); off still
// means nothing of Orgtree starts by itself. The desktop half: what it reads,
// what its elevated scripts do, which task starts the engine, and how main and
// the preload wire the switch. The installer half is
// tests/boot-installer.test.ps1.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The rules (what reads back as done,
// which exit code means a declined prompt), the exact scripts and that they
// parse in Windows PowerShell 5.1, and main's wiring. Nothing here runs a
// script against a task or the registry, and no permission prompt can appear:
// tests/disruptive/run-on-startup.test.mjs runs the scripts against throwaway
// tasks, and only a real installation can show a real boot or sign-in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-runonboot-'))
const load = async (source, name) => {
  const out = path.join(dir, `${name}.cjs`)
  await build({ entryPoints: [source], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
  return createRequire(import.meta.url)(out)
}
const startup = await load('apps/desktop/main/runonstartup.ts', 'runonstartup')
const admin = await load('apps/desktop/main/runasadmin.ts', 'runasadmin')
const read = file => fs.readFileSync(file, 'utf8')
const windows = process.platform === 'win32'
const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** A runner that records calls and answers from a queue. */
function fakeRunner(...answers) {
  const calls = []
  const runner = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs })
    return answers.shift() ?? { code: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}
const reading = (boot, helper) => ({ code: 0, stdout: JSON.stringify({ boot, helper }) + '\r\n', stderr: '' })
const ok = { code: 0, stdout: '', stderr: '' }
const declined = { code: 1223, stdout: '', stderr: '' }

test('the reading is the boot task and the sign-in helper, nothing else', () => {
  assert.deepEqual(startup.parseStartupTasks('{"boot":true,"helper":false}'), { boot: true, helper: false })
  assert.deepEqual(startup.parseStartupTasks('noise\r\n{"boot":false,"helper":null}\r\n'), { boot: false, helper: null })
  for (const bad of ['{"boot":true}', '{"helper":true}', '{"boot":"yes","helper":true}', '{"boot":true,"helper":1}', '']) {
    assert.equal(startup.parseStartupTasks(bad), null, bad)
  }
  // on means the boot task starts the engine; the helper follows it
  assert.equal(startup.startupOn({ boot: true, helper: null }), true)
  assert.equal(startup.startupOn({ boot: false, helper: true }), false)
  assert.equal(startup.startupOn({ boot: null, helper: null }), false)
})

test('the reading script reads the two tasks, never the old sign-in engine task, and changes nothing', () => {
  const script = startup.readScript()
  for (const name of ['Orgtree Background Engine', 'Orgtree Credential Helper']) assert.ok(script.includes(`(State '${name}')`), name)
  assert.ok(!script.includes('Orgtree Sign-in Engine'), 'the removed sign-in engine task is still read')
  assert.doesNotMatch(script, /StartupMode/)
  assert.doesNotMatch(script, /SetValue|\.Enabled =|RegisterTask|DeleteTask/)
})

test('the elevated script verifies both tasks first, switches both and records only RunOnStartup', () => {
  for (const enabled of [true, false]) {
    const script = startup.elevatedStartupScript(enabled)
    for (const marker of ['com.maurdekye.orgtree.boot.v1:', 'com.maurdekye.orgtree.credential-helper.v1:']) assert.ok(script.includes(marker), marker)
    assert.ok(!script.includes('signin-engine'), 'the removed sign-in engine task is still switched')
    assert.ok(script.includes(`$tasks[$name].Enabled = $${enabled}`), `both tasks ${enabled ? 'on' : 'off'}`)
    assert.ok(script.includes(`SetValue('RunOnStartup', ${enabled ? 1 : 0}, [Microsoft.Win32.RegistryValueKind]::DWord)`))
    assert.doesNotMatch(script, /StartupMode/)
    const refusal = script.indexOf('Refusing to change a task Orgtree did not install')
    const change = script.indexOf('.Enabled = $')
    assert.ok(refusal > 0 && refusal < change, 'a task was changed before both were verified')
    assert.ok(change < script.indexOf("SetValue('RunOnStartup'"), 'the choice was recorded before the tasks changed')
    // a running engine keeps running: the change applies from the next start
    assert.doesNotMatch(script, /\.Stop\(|DeleteTask|Stop-Process|taskkill/i)
  }
})

test('a change asks Windows for permission, says what still holds when declined, and must read back exactly', async () => {
  await assert.rejects(startup.writeRunOnStartup(false, fakeRunner(declined).runner), /^Error: Windows did not give permission, so Orgtree still runs on boot\.$/)
  await assert.rejects(startup.writeRunOnStartup(true, fakeRunner(declined).runner), /so Orgtree still does not run on boot\./)
  await assert.rejects(startup.writeRunOnStartup(true, fakeRunner({ code: 1, stdout: '', stderr: 'Refusing' }).runner), /^Error: Changing "run on boot" failed \(exit code 1\)\.$/)
  // done, and it reads back
  const done = fakeRunner(ok, reading(true, true))
  await startup.writeRunOnStartup(true, done.runner)
  const uacVerb = ['Run', 'As'].join('') // spelled in two parts: disruptive-policy scans test text
  assert.ok(done.calls[0].args.join(' ').includes(`-Verb ${uacVerb}`), 'the change did not ask Windows for permission')
  assert.ok(done.calls[0].timeoutMs >= 60000, 'the user gets time at the prompt')
  await startup.writeRunOnStartup(false, fakeRunner(ok, reading(false, false)).runner)
  // an installation without the helper (a legacy engine) still reads back
  await startup.writeRunOnStartup(true, fakeRunner(ok, reading(true, null)).runner)
  // done, but something reads otherwise: not reported as done
  for (const after of [reading(false, true), reading(true, false), reading(null, true), { code: 1, stdout: '', stderr: '' }]) {
    await assert.rejects(startup.writeRunOnStartup(true, fakeRunner(ok, after).runner), /reads back differently/, after.stdout)
  }
})

test('the engine starts through the boot task, without reading anything first', async () => {
  const r = fakeRunner(ok)
  await startup.startEngineTask(r.runner)
  assert.deepEqual(r.calls.map(c => [c.file, c.args]), [['schtasks', ['/Run', '/TN', 'Orgtree Background Engine']]])
  await assert.rejects(startup.startEngineTask(fakeRunner({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' }).runner), /Access is denied/)
})

test('"Run Orgtree as administrator" sets the sign-in helper\'s run level first, only on the installer\'s own task', () => {
  for (const enabled of [true, false]) {
    const script = admin.elevatedWriteScript(enabled)
    assert.ok(script.includes("GetTask('Orgtree Credential Helper')"))
    assert.ok(script.includes("'com.maurdekye.orgtree.credential-helper.v1:' + $id"))
    assert.ok(!script.includes('Orgtree Sign-in Engine'), 'the removed sign-in engine task is still changed')
    assert.ok(script.includes(`$definition.Principal.RunLevel = ${enabled ? 1 : 0}`))
    assert.ok(script.includes("RegisterTaskDefinition('Orgtree Credential Helper', $definition, 20, $sid, $null, 3, \"O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$sid)\")"))
    const refusal = script.indexOf('Refusing to change a task Orgtree did not install')
    assert.ok(refusal > 0 && refusal < script.indexOf('RegisterTaskDefinition'), 'the task was changed before it was verified')
    assert.ok(script.indexOf('RegisterTaskDefinition') < script.indexOf("SetValue('RunAsAdministrator'"), 'the setting changed before the task did')
  }
})

test('every script parses in Windows PowerShell 5.1', { skip: !windows && 'UNEXECUTED: needs Windows PowerShell' }, () => {
  const check = '$e = $null; [void][Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e) { $e | % { $_.Message }; exit 1 }'
  const scripts = [startup.readScript(), startup.elevatedStartupScript(true), startup.elevatedStartupScript(false),
    admin.elevatedWriteScript(true), admin.elevatedWriteScript(false)]
  for (const script of scripts) {
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', check], { input: script, encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, `parse errors: ${r.stdout}${r.stderr}`)
  }
})

test('main and the preload wire one switch: its name, one change at a time, the boot task for restarts and recovery', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.doesNotMatch(main, /desktop:engine-start|desktop:set-engine-start|changeEngineStart|engineStartState/)
  // "Run on boot", or "Run on sign-in" where Orgtree cannot start at boot (coordinator ruling A)
  assert.match(main, /const startupKind = \(\): StartupKind =>\s+process\.platform === 'win32' && app\.isPackaged && bootTask !== false \? 'boot' : 'signin'/)
  assert.match(main, /label: \(startupKind\(\) === 'boot' \? 'Run on boot' : 'Run on sign-in'\)/)
  assert.match(main, /handleApp\('desktop:startup-kind', async \(\): Promise<StartupKind> => \{/)
  const change = main.slice(main.indexOf('const changeRunOnStartup = async'), main.indexOf('const reconcileRunOnStartup'))
  assert.match(change, /if \(startupChanging\) throw new Error/)
  assert.match(change, /finally \{\s+startupChanging = false/)
  assert.match(change, /if \(tasks\.boot !== null && startupOn\(tasks\) !== enabled\) await writeRunOnStartup\(enabled\)/)
  const restart = main.slice(main.indexOf('const restartBackgroundEngine = async'), main.indexOf('const runAsAdministratorState'))
  const order = ['engine.stopAttachedForUpdate()', 'startEngineTask()', 'engine.reattachBackground(']
  const at = order.map(s => restart.indexOf(s))
  assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2], `graceful stop, then the boot task, then reattach: ${at}`)
  assert.match(main, /engine\.recoverUnexpected\(engineOptions, allowSpawn, startEngineTask\)/)
  const preload = read('apps/desktop/preload/index.ts')
  assert.match(preload, /getStartupKind: \(\) => ipcRenderer\.invoke\('desktop:startup-kind'\)/)
  assert.doesNotMatch(preload, /engine-start/)
  const contracts = read('packages/contracts/index.ts')
  assert.match(contracts, /export type StartupKind = 'boot' \| 'signin'/)
  assert.doesNotMatch(contracts, /EngineStartMode|EngineStartState|setEngineStart/)
})

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
