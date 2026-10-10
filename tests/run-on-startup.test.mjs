// "Run on startup" on an all-users Windows installation (docket
// start-at-login-off-means-nothing-of-orgtree-star): the desktop reads the
// boot engine and credential helper tasks without elevation, and switches both
// (and records the choice in the installer's record) through a Windows
// permission prompt (apps/desktop/main/runonstartup.ts).
//
// WHAT THIS FILE CAN AND CANNOT PROVE. Anywhere: the rules (what the reading
// returns, which exit code means a declined prompt, that a change must read
// back). On Windows: both PowerShell scripts parse in Windows PowerShell 5.1,
// and both RUN, unelevated, against THROWAWAY tasks registered for the current
// user and a throwaway HKCU key, all removed afterwards. Never against Orgtree's
// own tasks or its HKLM record. It cannot click a real permission prompt.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

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

test('the reading: enabled, disabled or absent per task; anything else is unreadable', () => {
  assert.deepEqual(startup.parseStartupTasks('{"boot":true,"helper":false}\r\n'), { boot: true, helper: false })
  assert.deepEqual(startup.parseStartupTasks('noise\n{"boot":false,"helper":null}'), { boot: false, helper: null })
  assert.equal(startup.parseStartupTasks(''), null)
  assert.equal(startup.parseStartupTasks('{"boot":"yes","helper":true}'), null)
  assert.equal(startup.parseStartupTasks('{"helper":true}'), null)
})

test('the switch asks for permission, says what still holds when it is declined, and must read back', async () => {
  const calls = []
  const runner = answers => async (file, args) => {
    calls.push([file, ...args].join(' '))
    return answers.shift() ?? { code: 0, stdout: '', stderr: '' }
  }
  // declined at the prompt: nothing changed, and the message says what still holds
  await assert.rejects(startup.writeRunOnStartup(false, runner([{ code: admin.UAC_CANCELLED, stdout: '', stderr: '' }])),
    /Windows did not give permission, so Orgtree still runs on startup\./)
  await assert.rejects(startup.writeRunOnStartup(true, runner([{ code: admin.UAC_CANCELLED, stdout: '', stderr: '' }])),
    /still does not run on startup/)
  // a failure inside the elevated script
  await assert.rejects(startup.writeRunOnStartup(false, runner([{ code: 1, stdout: '', stderr: 'Refusing' }])), /exit code 1/)
  // done, and it reads back
  await startup.writeRunOnStartup(false, runner([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '{"boot":false,"helper":false}', stderr: '' }]))
  // done, but the boot task still reads enabled: not reported as done
  await assert.rejects(startup.writeRunOnStartup(false, runner([{ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '{"boot":true,"helper":false}', stderr: '' }])),
    /reads back differently/)
  // the change goes through the elevated launcher (a Windows permission prompt)
  assert.ok(calls.some(c => c.includes('-Verb RunAs')), 'the switch did not ask Windows for permission')
})

test('the elevated script changes only the installer\'s own tasks, never stops or deletes one, and records the choice', () => {
  const off = startup.elevatedStartupScript(false)
  assert.match(off, /OpenBaseKey\('LocalMachine', 'Registry64'\)/)
  assert.match(off, /OpenSubKey\('SOFTWARE\\Orgtree\\BootEngine', \$true\)/)
  assert.match(off, /com\.maurdekye\.orgtree\.boot\.v1:/)
  assert.match(off, /com\.maurdekye\.orgtree\.credential-helper\.v1:/)
  assert.match(off, /Refusing to change a task Orgtree did not install/)
  assert.match(off, /\$task\.Enabled = \$false/)
  assert.match(off, /SetValue\('RunOnStartup', 0, \[Microsoft\.Win32\.RegistryValueKind\]::DWord\)/)
  assert.match(startup.elevatedStartupScript(true), /\$task\.Enabled = \$true[\s\S]*SetValue\('RunOnStartup', 1,/)
  // a running engine keeps running: the switch applies from the next start
  assert.doesNotMatch(off, /\.Stop\(|DeleteTask|Stop-Process|taskkill/i)
  // every task is verified before any is changed
  assert.ok(off.indexOf('Refusing to change') < off.indexOf('$task.Enabled ='), 'a task was changed before all were verified')
})

test('both scripts parse in Windows PowerShell 5.1', { skip: !windows && 'Windows only' }, () => {
  const check = '$e = $null; [void][Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e) { $e | % { $_.Message }; exit 1 }'
  for (const script of [startup.readScript(), startup.elevatedStartupScript(false), startup.elevatedStartupScript(true)]) {
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', check], { input: script, encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, `parse errors: ${r.stdout}${r.stderr}`)
  }
})

// MEASURED: both scripts run, unelevated, against throwaway tasks and a
// throwaway HKCU key that stand in for the installer's tasks and record.
test('measured: the scripts read, switch and record throwaway startup tasks, and refuse a foreign one', { skip: !windows && 'Windows only', timeout: 120000 }, async () => {
  const tag = `Orgtree Run On Startup Test ${randomUUID()}`
  const id = randomUUID()
  const target = { hive: 'CurrentUser', key: `Software\\${tag}`, boot: `${tag} boot`, helper: `${tag} helper` }
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
    `Remove-Item -LiteralPath ${q('HKCU:\\' + target.key)} -Recurse -Force -ErrorAction SilentlyContinue`,
  ].join('\n'))
  const recorded = () => {
    const r = ps(`(Get-ItemProperty -LiteralPath ${q('HKCU:\\' + target.key)} -Name RunOnStartup -ErrorAction Stop).RunOnStartup`)
    return r.status === 0 ? Number(r.stdout.trim()) : null
  }
  const runElevatedScript = enabled => ps(startup.elevatedStartupScript(enabled, target))
  try {
    let r = ps(`New-Item -Path ${q('HKCU:\\' + target.key)} -Force | Out-Null; Set-ItemProperty -LiteralPath ${q('HKCU:\\' + target.key)} -Name Id -Value ${q(id)}`)
    assert.equal(r.status, 0, `could not create the throwaway key: ${r.stderr}`)
    // nothing registered yet: both absent
    assert.deepEqual(await startup.readStartupTasks(undefined, target), { boot: null, helper: null })
    r = register(target.boot, `com.maurdekye.orgtree.boot.v1:${id}`)
    assert.equal(r.status, 0, `could not register the throwaway boot task: ${r.stderr}`)
    r = register(target.helper, `com.maurdekye.orgtree.credential-helper.v1:${id}`)
    assert.equal(r.status, 0, `could not register the throwaway helper task: ${r.stderr}`)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), { boot: true, helper: true })

    r = runElevatedScript(false)
    assert.equal(r.status, 0, `switching off failed: ${r.stdout}${r.stderr}`)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), { boot: false, helper: false })
    assert.equal(recorded(), 0)

    r = runElevatedScript(true)
    assert.equal(r.status, 0, `switching on failed: ${r.stdout}${r.stderr}`)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), { boot: true, helper: true })
    assert.equal(recorded(), 1)

    // a task whose description is not the installer's: refused, and nothing changes
    r = ps(`Unregister-ScheduledTask -TaskName ${q(target.helper)} -Confirm:$false`)
    r = register(target.helper, 'someone else\'s task')
    assert.equal(r.status, 0)
    r = runElevatedScript(false)
    assert.notEqual(r.status, 0, 'a foreign task was switched')
    assert.match(r.stderr + r.stdout, /Refusing to change a task Orgtree did not install/)
    assert.deepEqual(await startup.readStartupTasks(undefined, target), { boot: true, helper: true })
    assert.equal(recorded(), 1)
  } finally {
    cleanup()
  }
  assert.deepEqual(await startup.readStartupTasks(undefined, target), { boot: null, helper: null }, 'the throwaway tasks were not removed')
})

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }) })
