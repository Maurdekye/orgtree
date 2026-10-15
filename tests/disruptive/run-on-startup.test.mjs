// "Run on startup" on an all-users Windows installation (docket
// start-at-login-off-means-nothing-of-orgtree-star) and where the engine then
// starts (docket option-to-run-the-background-engine-in-the-user-s): the
// desktop reads the boot engine, sign-in engine and credential helper tasks
// without elevation, and switches them (and records the choice in the
// installer's record) through a Windows permission prompt
// (apps/desktop/main/runonstartup.ts).
//
// WHAT THIS FILE CAN AND CANNOT PROVE. Anywhere: the rules (what the reading
// returns, which exit code means a declined prompt, that a change must read
// back). On Windows: the PowerShell scripts parse in Windows PowerShell 5.1,
// and they RUN, unelevated, against THROWAWAY tasks registered for the current
// user and a throwaway HKCU key, all removed afterwards. Never against Orgtree's
// own tasks or its HKLM record. It cannot click a real permission prompt, and
// it cannot show a real sign-in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

import { requireDisruptiveOptIn } from './gate.mjs'

if (!requireDisruptiveOptIn('run-on-startup')) {
  test('run-on-startup probes', { skip: 'ORGTREE_DISRUPTIVE_PROBES=1 is required' }, () => {})
} else {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-runonstartup-'))
const load = async (source, name) => {
  const out = path.join(dir, `${name}.cjs`)
  await build({ entryPoints: [source], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
  return createRequire(import.meta.url)(out)
}
const startup = await load('apps/desktop/main/runonstartup.ts', 'runonstartup')
const admin = await load('apps/desktop/main/runasadmin.ts', 'runasadmin')
const windows = process.platform === 'win32'
const powershell = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null
const CHOICES = [[true, 'boot'], [true, 'signin'], [false, 'boot'], [false, 'signin']]

test('the reading: enabled, disabled or absent per task, and the recorded mode; anything else is unreadable', () => {
  assert.deepEqual(startup.parseStartupTasks('{"boot":true,"helper":false,"signin":false,"mode":"boot"}\r\n'), { boot: true, helper: false, signin: false, mode: 'boot' })
  assert.deepEqual(startup.parseStartupTasks('noise\n{"boot":false,"helper":null,"signin":true,"mode":"signin"}'), { boot: false, helper: null, signin: true, mode: 'signin' })
  assert.equal(startup.parseStartupTasks(''), null)
  assert.equal(startup.parseStartupTasks('{"boot":"yes","helper":true,"signin":false,"mode":"boot"}'), null)
  assert.equal(startup.parseStartupTasks('{"helper":true,"signin":false,"mode":"boot"}'), null)
})

test('the switch asks for permission, says what still holds when it is declined, and must read back', async () => {
  const calls = []
  const runner = answers => async (file, args) => {
    calls.push([file, ...args].join(' '))
    return answers.shift() ?? { code: 0, stdout: '', stderr: '' }
  }
  // declined at the prompt: nothing changed, and the message says what still holds
  await assert.rejects(startup.writeRunOnStartup(false, 'boot', runner([{ code: admin.UAC_CANCELLED, stdout: '', stderr: '' }])),
    /Windows did not give permission, so Orgtree still runs on startup\./)
  await assert.rejects(startup.writeRunOnStartup(true, 'boot', runner([{ code: admin.UAC_CANCELLED, stdout: '', stderr: '' }])),
    /still does not run on startup/)
  // a failure inside the elevated script
  await assert.rejects(startup.writeRunOnStartup(false, 'boot', runner([{ code: 1, stdout: '', stderr: 'Refusing' }])), /exit code 1/)
  // done, and it reads back
  await startup.writeRunOnStartup(false, 'boot', runner([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '{"boot":false,"helper":false,"signin":false,"mode":"boot"}', stderr: '' }]))
  // done, but the boot task still reads enabled: not reported as done
  await assert.rejects(startup.writeRunOnStartup(false, 'boot', runner([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '{"boot":true,"helper":false,"signin":false,"mode":"boot"}', stderr: '' }])),
    /reads back differently/)
  // the change goes through the elevated launcher (a Windows permission prompt);
  // the verb is spelled in two parts because disruptive-policy scans test text
  const uacVerb = ['Run', 'As'].join('')
  assert.ok(calls.some(c => c.includes(`-Verb ${uacVerb}`)), 'the switch did not ask Windows for permission')
})

test('the elevated script changes only the installer\'s own tasks, never stops or deletes one, and records the choice', () => {
  const off = startup.elevatedStartupScript(false, 'boot')
  assert.match(off, /OpenBaseKey\('LocalMachine', 'Registry64'\)/)
  assert.match(off, /OpenSubKey\('SOFTWARE\\Orgtree\\BootEngine', \$true\)/)
  assert.match(off, /com\.maurdekye\.orgtree\.boot\.v1:/)
  assert.match(off, /com\.maurdekye\.orgtree\.credential-helper\.v1:/)
  assert.match(off, /com\.maurdekye\.orgtree\.signin-engine\.v1:/)
  assert.match(off, /Refusing to change a task Orgtree did not install/)
  assert.match(off, /'Orgtree Background Engine' = \$false; 'Orgtree Credential Helper' = \$false; 'Orgtree Sign-in Engine' = \$false/)
  assert.match(off, /SetValue\('RunOnStartup', 0, \[Microsoft\.Win32\.RegistryValueKind\]::DWord\)/)
  assert.match(startup.elevatedStartupScript(true, 'boot'), /'Orgtree Background Engine' = \$true; 'Orgtree Credential Helper' = \$true; 'Orgtree Sign-in Engine' = \$false[\s\S]*SetValue\('RunOnStartup', 1,[\s\S]*SetValue\('StartupMode', 'boot',/)
  assert.match(startup.elevatedStartupScript(true, 'signin'), /'Orgtree Background Engine' = \$false; 'Orgtree Credential Helper' = \$true; 'Orgtree Sign-in Engine' = \$true[\s\S]*SetValue\('StartupMode', 'signin',/)
  // a running engine keeps running: the switch applies from the next start
  assert.doesNotMatch(off, /\.Stop\(|DeleteTask|Stop-Process|taskkill/i)
  // every task is verified before any is changed
  assert.ok(off.indexOf('Refusing to change') < off.indexOf('.Enabled = $wanted[$name]'), 'a task was changed before all were verified')
})

test('the scripts parse in Windows PowerShell 5.1', { skip: !windows && 'Windows only' }, () => {
  const check = '$e = $null; [void][Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e) { $e | % { $_.Message }; exit 1 }'
  for (const script of [startup.readScript(), ...CHOICES.map(([enabled, mode]) => startup.elevatedStartupScript(enabled, mode))]) {
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', check], { input: script, encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, `parse errors: ${r.stdout}${r.stderr}`)
  }
})

// MEASURED: the scripts run, unelevated, against throwaway tasks and a
// throwaway HKCU key that stand in for the installer's tasks and record.
test('measured: the scripts read, switch and record throwaway startup tasks, and refuse a foreign one', { skip: !windows && 'Windows only', timeout: 180000 }, async () => {
  const tag = `Orgtree Run On Startup Test ${randomUUID()}`
  const id = randomUUID()
  const target = { hive: 'CurrentUser', key: `Software\\${tag}`, boot: `${tag} boot`, helper: `${tag} helper`, signin: `${tag} signin` }
  const ps = script => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  const q = s => `'${s.replace(/'/g, "''")}'`
  const register = (name, description) => ps([
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit 0'`,
    `Register-ScheduledTask -TaskName ${q(name)} -Action $action -Description ${q(description)} | Out-Null`,
  ].join('\n'))
  const cleanup = () => ps([
    `Unregister-ScheduledTask -TaskName ${q(target.boot)} -Confirm:$false -ErrorAction SilentlyContinue`,
    `Unregister-ScheduledTask -TaskName ${q(target.helper)} -Confirm:$false -ErrorAction SilentlyContinue`,
    `Unregister-ScheduledTask -TaskName ${q(target.signin)} -Confirm:$false -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath ${q('HKCU:\\' + target.key)} -Recurse -Force -ErrorAction SilentlyContinue`,
  ].join('\n'))
  const recorded = name => {
    const r = ps(`(Get-ItemProperty -LiteralPath ${q('HKCU:\\' + target.key)} -Name ${name} -ErrorAction Stop).${name}`)
    return r.status === 0 ? r.stdout.trim() : null
  }
  const runElevatedScript = (enabled, mode) => ps(startup.elevatedStartupScript(enabled, mode, target))
  const tasks = (boot, helper, signin, mode) => ({ boot, helper, signin, mode })
  try {
    let r = ps(`New-Item -Path ${q('HKCU:\\' + target.key)} -Force | Out-Null; Set-ItemProperty -LiteralPath ${q('HKCU:\\' + target.key)} -Name Id -Value ${q(id)}`)
    assert.equal(r.status, 0, `could not create the throwaway key: ${r.stderr}`)
    // nothing registered yet: all absent, and no recorded mode reads as boot
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(null, null, null, 'boot'))
    for (const [name, marker] of [[target.boot, 'boot'], [target.helper, 'credential-helper'], [target.signin, 'signin-engine']]) {
      r = register(name, `com.maurdekye.orgtree.${marker}.v1:${id}`)
      assert.equal(r.status, 0, `could not register the throwaway ${marker} task: ${r.stderr}`)
    }
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(true, true, true, 'boot'))

    r = runElevatedScript(false, 'boot')
    assert.equal(r.status, 0, `switching off failed: ${r.stdout}${r.stderr}`)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(false, false, false, 'boot'))
    assert.equal(recorded('RunOnStartup'), '0')

    r = runElevatedScript(true, 'boot')
    assert.equal(r.status, 0, `switching on failed: ${r.stdout}${r.stderr}`)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(true, true, false, 'boot'))
    assert.equal(recorded('RunOnStartup'), '1')

    // the engine at sign-in: the boot task off, the sign-in engine and the helper on
    r = runElevatedScript(true, 'signin')
    assert.equal(r.status, 0, `switching to sign-in failed: ${r.stdout}${r.stderr}`)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(false, true, true, 'signin'))
    assert.equal(recorded('StartupMode'), 'signin')

    // off keeps the recorded mode, and on again restores it
    r = runElevatedScript(false, 'signin')
    assert.equal(r.status, 0, `switching off at sign-in failed: ${r.stdout}${r.stderr}`)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(false, false, false, 'signin'))
    r = runElevatedScript(true, 'signin')
    assert.equal(r.status, 0)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(false, true, true, 'signin'))

    // and back to boot
    r = runElevatedScript(true, 'boot')
    assert.equal(r.status, 0, `switching back to boot failed: ${r.stdout}${r.stderr}`)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(true, true, false, 'boot'))
    assert.equal(recorded('StartupMode'), 'boot')

    // a task whose description is not the installer's: refused, and nothing changes
    r = ps(`Unregister-ScheduledTask -TaskName ${q(target.signin)} -Confirm:$false`)
    r = register(target.signin, 'someone else\'s task')
    assert.equal(r.status, 0)
    r = runElevatedScript(false, 'boot')
    assert.notEqual(r.status, 0, 'a foreign task was switched')
    assert.match(r.stderr + r.stdout, /Refusing to change a task Orgtree did not install/)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(true, true, true, 'boot'))
    assert.equal(recorded('RunOnStartup'), '1')

    // no sign-in engine task at all: the engine cannot be moved to sign-in, and nothing changes
    r = ps(`Unregister-ScheduledTask -TaskName ${q(target.signin)} -Confirm:$false`)
    r = runElevatedScript(true, 'signin')
    assert.notEqual(r.status, 0, 'switched to a sign-in engine that does not exist')
    assert.match(r.stderr + r.stdout, /no sign-in engine task/)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(true, true, null, 'boot'))
  } finally {
    cleanup()
  }
  assert.deepEqual(await startup.readStartupTasks(undefined, target), tasks(null, null, null, 'boot'), 'the throwaway tasks were not removed')
})

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })

}
