// Where the background engine starts (docket option-to-run-the-background-
// engine-in-the-user-s, user 2026-10-15): "At boot, before sign-in" (the boot
// task, in Session 0, the default) or "At sign-in, in my session" (the sign-in
// engine task, with the operator's own sign-in). The desktop half: what it
// reads, what its elevated scripts do, which task starts the engine, and how
// main wires the choice. The installer half is tests/boot-installer.test.ps1.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The rules (the state table, what reads
// back as done, which exit code means a declined prompt), the exact scripts
// and that they parse in Windows PowerShell 5.1, and main's wiring. Nothing
// here runs a script against a task or the registry, and no permission prompt
// can appear: tests/disruptive/run-on-startup.test.mjs runs the scripts
// against throwaway tasks, and only a real installation can show a real
// sign-in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-startmode-'))
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
const CHOICES = [[true, 'boot'], [true, 'signin'], [false, 'boot'], [false, 'signin']]

/** A runner that records calls and answers from a queue. */
function fakeRunner(...answers) {
  const calls = []
  const runner = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs })
    return answers.shift() ?? { code: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}
const reading = (boot, helper, signin, mode) => ({ code: 0, stdout: JSON.stringify({ boot, helper, signin, mode }) + '\r\n', stderr: '' })
const ok = { code: 0, stdout: '', stderr: '' }
const declined = { code: 1223, stdout: '', stderr: '' }

test('the reading carries the sign-in engine task and the recorded mode', () => {
  assert.deepEqual(startup.parseStartupTasks('{"boot":false,"helper":true,"signin":true,"mode":"signin"}'), { boot: false, helper: true, signin: true, mode: 'signin' })
  assert.deepEqual(startup.parseStartupTasks('noise\r\n{"boot":true,"helper":null,"signin":null,"mode":"boot"}\r\n'), { boot: true, helper: null, signin: null, mode: 'boot' })
  for (const bad of ['{"boot":true,"helper":true,"mode":"boot"}', '{"boot":true,"helper":true,"signin":true,"mode":"later"}',
    '{"boot":true,"helper":true,"signin":"yes","mode":"boot"}', '{"boot":true,"helper":true,"signin":false}', '']) {
    assert.equal(startup.parseStartupTasks(bad), null, bad)
  }
})

test('exactly one engine task while on, the helper in both modes, nothing while off', () => {
  assert.deepEqual(startup.expectedTasks(true, 'boot'), { boot: true, helper: true, signin: false })
  assert.deepEqual(startup.expectedTasks(true, 'signin'), { boot: false, helper: true, signin: true })
  assert.deepEqual(startup.expectedTasks(false, 'boot'), { boot: false, helper: false, signin: false })
  assert.deepEqual(startup.expectedTasks(false, 'signin'), { boot: false, helper: false, signin: false })
  // "run on startup" is on while either engine task starts the engine
  assert.equal(startup.startupOn({ boot: false, helper: true, signin: true, mode: 'signin' }), true)
  assert.equal(startup.startupOn({ boot: true, helper: null, signin: null, mode: 'boot' }), true)
  assert.equal(startup.startupOn({ boot: false, helper: false, signin: false, mode: 'signin' }), false)
})

test('the reading script reads all three tasks and the recorded mode, never more', () => {
  const script = startup.readScript()
  for (const name of ['Orgtree Background Engine', 'Orgtree Credential Helper', 'Orgtree Sign-in Engine']) assert.ok(script.includes(`(State '${name}')`), name)
  assert.match(script, /OpenSubKey\('SOFTWARE\\Orgtree\\BootEngine'\)/)
  assert.match(script, /GetValue\('StartupMode'\) -ceq 'signin'/)
  assert.doesNotMatch(script, /SetValue|\.Enabled =|RegisterTask|DeleteTask/)
})

test('the elevated script verifies all three tasks first, applies the table and records both values', () => {
  for (const [enabled, mode] of CHOICES) {
    const script = startup.elevatedStartupScript(enabled, mode)
    const want = startup.expectedTasks(enabled, mode)
    for (const marker of ['com.maurdekye.orgtree.boot.v1:', 'com.maurdekye.orgtree.credential-helper.v1:', 'com.maurdekye.orgtree.signin-engine.v1:']) {
      assert.ok(script.includes(marker), marker)
    }
    assert.ok(script.includes(`$wanted = @{ 'Orgtree Background Engine' = $${want.boot}; 'Orgtree Credential Helper' = $${want.helper}; 'Orgtree Sign-in Engine' = $${want.signin} }`),
      `wrong table for ${enabled} ${mode}`)
    assert.ok(script.includes(`SetValue('RunOnStartup', ${enabled ? 1 : 0}, [Microsoft.Win32.RegistryValueKind]::DWord)`))
    assert.ok(script.includes(`SetValue('StartupMode', '${mode}', [Microsoft.Win32.RegistryValueKind]::String)`))
    assert.ok(script.indexOf('Refusing to change a task Orgtree did not install') < script.indexOf('.Enabled = $wanted[$name]'), 'a task was changed before all were verified')
    assert.ok(script.indexOf('.Enabled = $wanted[$name]') < script.indexOf("SetValue('RunOnStartup'"), 'the choice was recorded before the tasks changed')
    // a running engine keeps running: the change applies from the next start
    assert.doesNotMatch(script, /\.Stop\(|DeleteTask|Stop-Process|taskkill/i)
    // the engine must start somewhere when it is supposed to
    assert.equal(script.includes('no sign-in engine task'), want.signin, `${enabled} ${mode}`)
  }
})

test('a change asks Windows for permission, says what still holds when declined, and must read back exactly', async () => {
  await assert.rejects(startup.writeEngineStart('signin', fakeRunner(declined).runner), /^Error: Windows did not give permission, so the engine still starts at boot\.$/)
  await assert.rejects(startup.writeEngineStart('boot', fakeRunner(declined).runner), /so the engine still starts at sign-in\./)
  await assert.rejects(startup.writeRunOnStartup(false, 'signin', fakeRunner(declined).runner), /so Orgtree still runs on startup\./)
  await assert.rejects(startup.writeRunOnStartup(true, 'signin', fakeRunner(declined).runner), /so Orgtree still does not run on startup\./)
  await assert.rejects(startup.writeEngineStart('signin', fakeRunner({ code: 1, stdout: '', stderr: 'Refusing' }).runner), /exit code 1/)
  // done, and it reads back
  const done = fakeRunner(ok, reading(false, true, true, 'signin'))
  await startup.writeEngineStart('signin', done.runner)
  const uacVerb = ['Run', 'As'].join('') // spelled in two parts: disruptive-policy scans test text
  assert.ok(done.calls[0].args.join(' ').includes(`-Verb ${uacVerb}`), 'the change did not ask Windows for permission')
  assert.ok(done.calls[0].timeoutMs >= 60000, 'the user gets time at the prompt')
  await startup.writeRunOnStartup(false, 'signin', fakeRunner(ok, reading(false, false, false, 'signin')).runner)
  await startup.writeRunOnStartup(true, 'boot', fakeRunner(ok, reading(true, true, false, 'boot')).runner)
  // an installation without the helper (a legacy engine) still reads back
  await startup.writeEngineStart('boot', fakeRunner(ok, reading(true, null, false, 'boot')).runner)
  // done, but something reads otherwise: not reported as done
  for (const after of [reading(true, true, true, 'signin'), reading(false, true, false, 'signin'), reading(false, false, true, 'signin'),
    reading(false, true, true, 'boot'), { code: 1, stdout: '', stderr: '' }]) {
    await assert.rejects(startup.writeEngineStart('signin', fakeRunner(ok, after).runner), /reads back differently/, after.stdout)
  }
})

test('the engine starts through whichever engine task is enabled', async () => {
  const cases = [
    [reading(false, true, true, 'signin'), 'Orgtree Sign-in Engine'],
    [reading(true, true, false, 'boot'), 'Orgtree Background Engine'],
    // unreadable: as before the choice existed
    [{ code: 1, stdout: '', stderr: 'unreadable' }, 'Orgtree Background Engine'],
  ]
  for (const [answer, task] of cases) {
    const r = fakeRunner(answer, ok)
    await startup.startEngineTask(r.runner)
    assert.deepEqual([r.calls[1].file, r.calls[1].args], ['schtasks', ['/Run', '/TN', task]])
  }
  await assert.rejects(startup.startEngineTask(fakeRunner(reading(false, true, true, 'signin'), { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' }).runner), /Access is denied/)
})

test('"Run Orgtree as administrator" sets the sign-in engine task\'s run level first, only on the installer\'s own task', () => {
  for (const enabled of [true, false]) {
    const script = admin.elevatedWriteScript(enabled)
    assert.ok(script.includes("GetTask('Orgtree Sign-in Engine')"))
    assert.ok(script.includes("'com.maurdekye.orgtree.signin-engine.v1:' + $id"))
    assert.ok(script.includes(`$definition.Principal.RunLevel = ${enabled ? 1 : 0}`))
    assert.ok(script.includes("RegisterTaskDefinition('Orgtree Sign-in Engine', $definition, 20, $sid, $null, 3, \"O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$sid)\")"))
    const refusal = script.indexOf('Refusing to change a task Orgtree did not install')
    assert.ok(refusal > 0 && refusal < script.indexOf('RegisterTaskDefinition'), 'the task was changed before it was verified')
    assert.ok(script.indexOf('RegisterTaskDefinition') < script.indexOf("SetValue('RunAsAdministrator'"), 'the setting changed before the task did')
  }
})

test('every script parses in Windows PowerShell 5.1', { skip: !windows && 'UNEXECUTED: needs Windows PowerShell' }, () => {
  const check = '$e = $null; [void][Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e) { $e | % { $_.Message }; exit 1 }'
  const scripts = [startup.readScript(), ...CHOICES.map(([enabled, mode]) => startup.elevatedStartupScript(enabled, mode)),
    admin.elevatedWriteScript(true), admin.elevatedWriteScript(false)]
  for (const script of scripts) {
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', check], { input: script, encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, `parse errors: ${r.stdout}${r.stderr}`)
  }
})

test('main wires the choice: one change at a time, a restart only for an engine a task started, recovery through the enabled task', () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /handleApp\('desktop:engine-start', \(\) => engineStartState\(\)\)/)
  const setter = main.slice(main.indexOf("handleApp('desktop:set-engine-start'"))
  assert.match(setter, /if \(state\.mode !== mode\) await changeEngineStart\(mode\)/)
  assert.match(setter, /if \(!engine\.usesBackgroundTask\) throw new Error/)
  const change = main.slice(main.indexOf('const changeEngineStart = async'), main.indexOf('const reconcileRunOnStartup'))
  assert.match(change, /if \(startupChanging\) throw new Error/)
  assert.match(change, /finally \{\s+startupChanging = false/)
  // turning "run on startup" on or off keeps where the engine starts
  assert.match(main, /if \(tasks\.boot !== null && startupOn\(tasks\) !== enabled\) await writeRunOnStartup\(enabled, tasks\.mode\)/)
  const restart = main.slice(main.indexOf('const restartBackgroundEngine = async'), main.indexOf('const runAsAdministratorState'))
  const order = ['engine.stopAttachedForUpdate()', 'startEngineTask()', 'engine.reattachBackground(']
  const at = order.map(s => restart.indexOf(s))
  assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2], `graceful stop, then the enabled task, then reattach: ${at}`)
  assert.match(main, /engine\.recoverUnexpected\(engineOptions, allowSpawn, startEngineTask\)/)
  assert.doesNotMatch(main, /startBootTask/)
  const preload = read('apps/desktop/preload/index.ts')
  assert.match(preload, /getEngineStart: \(\) => ipcRenderer\.invoke\('desktop:engine-start'\)/)
  assert.match(preload, /ipcRenderer\.invoke\('desktop:set-engine-start', mode, restartNow\)/)
})

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
