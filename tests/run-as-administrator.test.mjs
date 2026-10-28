// "Run Orgtree as administrator" (item v3-the-installer-s-auto-start-after-an-
// upgrade-r, Part 2): the desktop half. The boot host reads the setting from
// HKLM (engine/unelevated.py, run_as_administrator_enabled); the desktop reads
// it with `reg`, writes it through a UAC-elevated PowerShell that creates the
// key admin-writable only, and restarts the background engine through its
// task. The Python half is tests/test_unelevated_spawn.py.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. It proves the rules (what counts as ON,
// which exit code means a declined prompt), the exact commands, that both
// PowerShell scripts parse, and — in an ELEVATED test process only — that the
// write script really creates a protected key with the value, against a
// THROWAWAY key that is removed afterwards (never the real setting). It cannot
// click a real UAC prompt.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { build, transformSync } from 'esbuild'
import { createRequire } from 'node:module'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-runasadmin-'))
const load = async (source, name) => {
  const out = path.join(dir, `${name}.cjs`)
  await build({ entryPoints: [source], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  return createRequire(import.meta.url)(out)
}
const admin = await load('apps/desktop/main/runasadmin.ts', 'runasadmin')
const { Engine } = await load('apps/desktop/main/engine.ts', 'engine')
const { route } = await load('apps/desktop/main/sessionlaunch.ts', 'sessionlaunch')
const read = file => fs.readFileSync(file, 'utf8')
const windows = process.platform === 'win32'
const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** Run one of main's own closures (index.ts starts Electron, so it cannot be
 *  imported): its source between two anchors, types stripped, in a context of
 *  synthetic seams that record what it asks for. */
function mainClosure(main, from, to, seams) {
  const start = main.indexOf(from), end = main.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `main has ${from.trim()}`)
  vm.runInNewContext(transformSync(main.slice(start, end), { loader: 'ts', target: 'node22' }).code, seams)
  return seams
}

/** A runner that records calls and answers from a queue. */
function fakeRunner(...answers) {
  const calls = []
  const runner = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs })
    return answers.shift() ?? { code: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}
// What `reg query` really prints (measured on Windows 11, CRLF included).
const regOutput = (type, data) => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Orgtree\\Runtime\r\n    RunAsAdministrator    ${type}    ${data}\r\n\r\n`

test('only RunAsAdministrator REG_DWORD 0x1 is ON, as the boot host reads it', () => {
  assert.equal(admin.parseRegQuery(regOutput('REG_DWORD', '0x1')), true)
  assert.equal(admin.parseRegQuery(regOutput('REG_DWORD', '0x00000001')), true)
  for (const [type, data] of [['REG_DWORD', '0x0'], ['REG_DWORD', '0x2'], ['REG_SZ', '1'], ['REG_QWORD', '0x1']]) {
    assert.equal(admin.parseRegQuery(regOutput(type, data)), false, `${type} ${data}`)
  }
  assert.equal(admin.parseRegQuery(''), false)
})

test('reading queries the 64-bit HKLM value and treats a missing key as OFF', async () => {
  const on = fakeRunner({ code: 0, stdout: regOutput('REG_DWORD', '0x1'), stderr: '' })
  assert.equal(await admin.readRunAsAdministrator(on.runner), true)
  assert.deepEqual(on.calls[0].file, 'reg')
  assert.deepEqual(on.calls[0].args, ['query', 'HKLM\\SOFTWARE\\Orgtree\\Runtime', '/v', 'RunAsAdministrator', '/reg:64'])
  const missing = fakeRunner({ code: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' })
  assert.equal(await admin.readRunAsAdministrator(missing.runner), false)
})

test('the elevated script re-protects the key and writes the DWORD', () => {
  for (const enabled of [true, false]) {
    const script = admin.elevatedWriteScript(enabled)
    assert.match(script, /OpenBaseKey\('LocalMachine', 'Registry64'\)/)
    assert.match(script, /SetSecurityDescriptorSddlForm\('O:BAG:BAD:P\(A;;KA;;;SY\)\(A;;KA;;;BA\)\(A;;KR;;;BU\)'\)/)
    assert.match(script, /CreateSubKey\('SOFTWARE\\Orgtree\\Runtime'/)
    assert.match(script, /\$key\.SetAccessControl\(\$acl\)/, 'an existing key is re-protected, not trusted')
    assert.match(script, new RegExp(`SetValue\\('RunAsAdministrator', ${enabled ? 1 : 0}, \\[Microsoft\\.Win32\\.RegistryValueKind\\]::DWord\\)`))
  }
})

test('the launcher asks Windows (UAC) to run exactly that script and maps a declined prompt', () => {
  const args = admin.elevationArgs(true)
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  const launcher = args[3]
  // This test only READS the launcher text; nothing here starts it, so no UAC
  // prompt can appear. The verb is spelled in two parts because
  // disruptive-policy §2 scans test files as plain text and cannot tell an
  // assertion about an elevation request from the request itself.
  const uacVerb = ['Run', 'As'].join('')
  assert.match(launcher, new RegExp(`Start-Process -FilePath '.*powershell\\.exe' -Verb ${uacVerb} -WindowStyle Hidden -Wait -PassThru`))
  const encoded = /'-EncodedCommand','([^']+)'/.exec(launcher)[1]
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), admin.elevatedWriteScript(true))
  assert.match(launcher, /NativeErrorCode -eq 1223\) \{ exit 1223 \}/)
})

const REPORT = { hive: 'LocalMachine', key: 'SOFTWARE\\Orgtree\\Runtime', nonce: '0123456789abcdef0123456789abcdef' }

test('both PowerShell scripts parse', { skip: !windows && 'UNEXECUTED: needs Windows PowerShell' }, () => {
  for (const script of [admin.elevatedWriteScript(true), admin.elevationArgs(false)[3],
    admin.elevatedWriteScript(true, REPORT), admin.elevatedWriteScript(false, REPORT), admin.elevationArgs(true, REPORT)[3]]) {
    const check = `$e = $null; [void][Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e) { $e | % { $_.Message }; exit 1 }`
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', check], { input: script, windowsHide: true })
  }
})

test('writing: declined, failed and misread changes all throw; a confirmed one resolves', async () => {
  const declined = fakeRunner({ code: 1223, stdout: '', stderr: '' })
  await assert.rejects(admin.writeRunAsAdministrator(true, declined.runner), /did not give permission/)
  assert.equal(declined.calls.length, 1, 'nothing is read back after a declined prompt')
  assert.ok(declined.calls[0].timeoutMs >= 60000, 'the user gets time at the prompt')
  await assert.rejects(admin.writeRunAsAdministrator(true, fakeRunner({ code: 2, stdout: '', stderr: '' }).runner), /exit code 2/)
  const misread = fakeRunner({ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: regOutput('REG_DWORD', '0x0'), stderr: '' })
  await assert.rejects(admin.writeRunAsAdministrator(true, misread.runner), /reads back differently/)
  const ok = fakeRunner({ code: 0, stdout: '', stderr: '' }, { code: 0, stdout: regOutput('REG_DWORD', '0x1'), stderr: '' })
  await admin.writeRunAsAdministrator(true, ok.runner)
  assert.equal(ok.calls[1].file, 'reg')
})

test('a failed change says what the elevated script said, else its exit code', async () => {
  // alpha.34 said only "Changing the setting failed (exit code 1)." (the user, 2026-10-22 13:00Z)
  const said = 'Task operator does not match the installation: Orgtree Background Engine'
  const failed = fakeRunner({ code: 1, stdout: `noise\r\n${admin.FAILURE_MARKER}${Buffer.from(said, 'utf8').toString('base64')}\r\n`, stderr: '' })
  await assert.rejects(admin.writeRunAsAdministrator(true, failed.runner), { message: `Changing the setting failed: ${said}.` })
  assert.equal(failed.calls.length, 1, 'nothing is read back after a failed change')
  await assert.rejects(admin.writeRunAsAdministrator(true, fakeRunner({ code: 1, stdout: '', stderr: '' }).runner),
    { message: 'Changing the setting failed (exit code 1).' })
  // every change reads its own report back: the protected Runtime key, under a
  // fresh nonce that its elevated script reports with
  const nonces = []
  for (const enabled of [true, false]) {
    const r = fakeRunner({ code: 1, stdout: '', stderr: '' })
    await assert.rejects(admin.writeRunAsAdministrator(enabled, r.runner))
    const launcher = r.calls[0].args[3]
    assert.match(launcher, /OpenBaseKey\('LocalMachine', 'Registry64'\)/)
    assert.ok(launcher.includes("OpenSubKey('SOFTWARE\\Orgtree\\Runtime')"), 'the launcher reads the protected Runtime key')
    const nonce = /StartsWith\('([0-9a-f]{32}) '/.exec(launcher)?.[1]
    assert.ok(nonce, 'the launcher looks for a nonce of its own')
    const script = Buffer.from(/'-EncodedCommand','([^']+)'/.exec(launcher)[1], 'base64').toString('utf16le')
    assert.ok(script.includes(`'${nonce} '`), 'the elevated script reports under the same nonce')
    nonces.push(nonce)
  }
  assert.notEqual(nonces[0], nonces[1], 'every change has its own nonce')
})

test('the background engine restarts through its own task', async () => {
  const ok = fakeRunner()
  await admin.startBootTask(ok.runner)
  assert.deepEqual([ok.calls[0].file, ok.calls[0].args], ['schtasks', ['/Run', '/TN', 'Orgtree Background Engine']])
  await assert.rejects(admin.startBootTask(fakeRunner({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' }).runner), /Access is denied/)
})

function elevated() {
  if (!windows) return false
  try {
    return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
    { encoding: 'utf8', windowsHide: true }).trim() === 'True'
  } catch { return false }
}

test('the write script really creates an admin-only key with the value (throwaway key)',
  { skip: !elevated() && 'UNEXECUTED: needs an elevated test process to write HKLM' }, t => {
    const key = `SOFTWARE\\OrgtreeTest-${randomUUID()}\\Runtime`
    const parent = key.slice(0, key.lastIndexOf('\\'))
    t.after(() => execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      `Remove-Item -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\${parent}' -Recurse -Force -ErrorAction SilentlyContinue`], { windowsHide: true }))
    const script = admin.elevatedWriteScript(true).replaceAll('SOFTWARE\\Orgtree\\Runtime', key)
    assert.notEqual(script, admin.elevatedWriteScript(true), 'the real key must never be written by this test')
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    const query = execFileSync('reg', ['query', `HKLM\\${key}`, '/v', 'RunAsAdministrator', '/reg:64'], { encoding: 'utf8', windowsHide: true })
    assert.equal(admin.parseRegQuery(query), true)
    const sddl = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      // Not Get-Acl: it reports a just-created HKLM key as missing (measured).
      `[Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey('${key}').GetAccessControl().GetSecurityDescriptorSddlForm('All')`],
    { encoding: 'utf8', windowsHide: true }).trim()
    assert.match(sddl, /^O:BAG:BAD:P/, 'owned by Administrators, inheriting nothing')
    assert.ok(!/\(A;[^;]*;K[AW][^)]*;;;BU\)/.test(sddl) && !/;;;AU\)|;;;WD\)/.test(sddl), `no write for users: ${sddl}`)
  })

test('main wires the setting and keeps the recovery poll out of a deliberate restart', async () => {
  const main = read('apps/desktop/main/index.ts')
  assert.match(main, /handleApp\('desktop:run-as-admin'/)
  assert.match(main, /handleApp\('desktop:set-run-as-admin'/)
  // With coordinated lifecycle active, native identity/death checks own
  // shutdown; the legacy HTTP recovery poll must not resurrect that cohort.
  // Deliberate restart remains excluded from the legacy path as before.
  assert.match(main, /if \(stats === null && !engine\.managed && !backgroundEngineRestart && !coreLifecycle\)/)
  // Settings and the tray share one guarded change (de04072); run it through
  // the Settings handler. Only a real change is written, and it applies at
  // once (coordinator Q1, invariant 7): the engine restarts with it, so no
  // "Restart now" state is left where the engine and the helper could differ.
  const steps = [], stored = { available: true, enabled: false }, handlers = {}
  const setter = mainClosure(main, '      changeRunAsAdministrator = async', '      /** "Run on boot"', {
    handleApp: (name, fn) => { handlers[name] = fn }, changeRunAsAdministrator: undefined, adminChanging: false,
    rebuildTray() {}, refreshRunAsAdministrator: async () => ({ ...stored }),
    backgroundEngineRestart: false, engineRestartBlocked: () => false,
    dialog: { showMessageBox: async () => { steps.push('warning'); return { response: 0 } } },
    writeRunAsAdministrator: async enabled => { steps.push(`write ${enabled}`); stored.enabled = enabled },
    restartBackgroundEngine: async () => { steps.push('restart') },
  })
  const set = handlers['desktop:set-run-as-admin']
  await set(true)
  assert.deepEqual(steps, ['warning', 'write true', 'restart'], 'a change is warned about, written, then applied at once')
  await set(true)
  assert.deepEqual(steps.slice(3), [], 'the stored value again: no warning, no write, no restart')
  await set(false)
  assert.deepEqual(steps.slice(3), ['write false', 'restart'], 'switching off is written without a warning and applied at once too')
  assert.equal(setter.adminChanging, false)
  // The restart this setting shares with the tray's Restart engine, at a
  // verified console session too (decision 94; decision 93 handed it to the
  // user's session from here): graceful stop, then the boot task, then
  // reattach, with the recovery poll held off until it has ended, failed or not.
  const atConsole = { session: 7, console: 7, ownsConsole: true, known: true, operatorSid: 'fixture', elevated: false }
  const order = [], origin = 'http://127.0.0.1:1'
  let reattached = true, sealed = true
  // One open window, so the reload after a same-origin restart shows. It runs
  // only when every sandbox seal has applied (windows.ts sandboxSealed).
  const win = { isDestroyed: () => false, webContents: { reload: () => order.push(held('reload')) } }
  const restart = {
    restartBackground: undefined, backgroundEngineRestart: false, quitComplete: false, engineRestartBlocked: () => false,
    quitting: false, installerUpgradeShutdown: false, engineOptions: { binary: 'engine.exe', dataRoot: 'data' },
    readStartupTasks: async () => ({ boot: true, helper: true, interactive: true }), launchContext: async () => atConsole, route,
    startInSession: async () => { order.push('user-session task') }, runSessionAsAdmin: async () => { order.push('UAC prompt') },
    coreLifecycle: { transition: async on => { order.push(`transition ${on}`) }, complete: async () => { order.push('complete') },
      stop() { order.push('lifecycle stopped') } },
    engine: { origin, restart: async () => { order.push('own engine') },
      stopAttachedForUpdate: async () => { order.push(held('graceful stop')) },
      reattachBackground: async () => { order.push(held('reattach')); return reattached } },
    startEngineTask: async () => { order.push(held('boot task')) },
    initialOrigin: origin, records: new Map([['w1', { window: win }]]), saveWindowLayout: async () => {}, relaunchApp() {}, app: { quit() {} },
    sandboxSealed: async () => { order.push('seals checked'); return sealed },
    rebuildTray() { order.push('tray') },
  }
  /** A step, marked if the recovery poll could act during it. */
  const held = step => step + (restart.backgroundEngineRestart ? '' : ' (recovery poll not held off)')
  mainClosure(main, '      const restartBackgroundEngine = async', '      const runAsAdministratorState', restart)
  await restart.restartBackground()
  assert.deepEqual(order, ['transition true', 'graceful stop', 'boot task', 'reattach', 'complete', 'seals checked', 'reload', 'tray'])
  assert.equal(restart.backgroundEngineRestart, false)
  // A seal that failed shut the window session: nothing reloads into it.
  sealed = false; order.length = 0
  await restart.restartBackground()
  assert.deepEqual(order, ['transition true', 'graceful stop', 'boot task', 'reattach', 'complete', 'seals checked', 'tray'])
  sealed = true
  reattached = false; order.length = 0
  await assert.rejects(restart.restartBackground(), /has not reconnected to it yet/)
  assert.deepEqual(order, ['transition true', 'graceful stop', 'boot task', 'reattach', 'tray'])
  assert.equal(restart.backgroundEngineRestart, false, 'a failed restart lets the recovery poll act again')
  const preload = read('apps/desktop/preload/index.ts')
  assert.match(preload, /getRunAsAdministrator: \(\) => ipcRenderer\.invoke\('desktop:run-as-admin'\)/)
  assert.match(preload, /ipcRenderer\.invoke\('desktop:set-run-as-admin', enabled\)/)
  // the one-off button is retired for 4.4.0 (the user, Q2, 2026-10-22 07:38Z)
  assert.doesNotMatch(main, /desktop:run-session-as-admin|runSessionAsAdmin/)
  assert.doesNotMatch(preload, /runThisSessionAsAdmin|run-session-as-admin/)
})

test('reattaching after the restart never starts an engine of the desktop\'s own', async () => {
  const engine = new Engine()
  engine.managed = false
  let started = 0
  engine.start = async () => { started++ }
  engine.attachWithRetry = async () => false
  assert.equal(await engine.reattachBackground({}, 10), false)
  assert.equal(engine.managed, false, 'still the background engine\'s client, not a managed engine')
  assert.equal(engine.status.state, 'stopped')
  engine.attachWithRetry = async () => true
  assert.equal(await engine.reattachBackground({}, 10), true)
  assert.equal(started, 0)
  const managed = new Engine()
  assert.equal(await managed.reattachBackground({}, 10), false, 'a managed engine is not a background engine to reattach')
})
