import { POWERSHELL, SIGNIN_TASK, UAC_CANCELLED, elevatedArgs, run, startTask, type Runner } from './runasadmin'

/** "Run on startup" on an all-users Windows installation (docket
 *  start-at-login-off-means-nothing-of-orgtree-star; the user, 2026-10-10:
 *  "if i have start on boot disabled, then nothing should run at all on boot
 *  ever until i manually start orgtree").
 *
 *  The installer registers three tasks that start Orgtree without anyone
 *  opening it (tools/boot-engine-task.ps1): "Orgtree Background Engine" at
 *  boot, "Orgtree Sign-in Engine" at the operator's sign-in, and "Orgtree
 *  Credential Helper" at sign-in. WHERE THE ENGINE STARTS is the operator's
 *  choice (docket option-to-run-the-background-engine-in-the-user-s, user
 *  2026-10-15): "At boot, before sign-in" (the boot task, in Session 0, the
 *  default) or "At sign-in, in my session" (the sign-in engine task, with
 *  their own sign-in). Exactly one of the two is enabled while the setting is
 *  on; the helper runs in both modes, because the engine's lifecycle counts it
 *  as a member wherever a task's host started the engine (coordinator
 *  2026-10-15 11:13Z). Off disables all three, together with the window's own
 *  sign-in entry. Disabled, not deleted: the installer's ownership of them
 *  stays intact, and on again simply re-enables them. A task that is running
 *  is not stopped; the change applies from the next boot or sign-in.
 *
 *  ⚠ ONLY ADMINISTRATORS MAY CHANGE THE TASKS. Their ACL gives the operator
 *  read and execute and nothing else, on purpose: every agent runs as the
 *  operator, and a task it could rewrite would start whatever it liked at
 *  boot. So a change goes through a Windows permission prompt, exactly as
 *  "Run Orgtree as administrator" does, and it is also written to the
 *  installer's protected record (HKLM\SOFTWARE\Orgtree\BootEngine,
 *  RunOnStartup and StartupMode), which is what the next update applies.
 *  What the switch shows is the tasks' real state, so it never says off while
 *  a task still starts the engine. */

export const BOOT_TASK = 'Orgtree Background Engine'
export const HELPER_TASK = 'Orgtree Credential Helper'
export { SIGNIN_TASK }

/** Where the engine starts while "Run on startup" is on. */
export type EngineStartMode = 'boot' | 'signin'

/** Where the tasks and the installer's record are. Only tests name another
 *  (throwaway tasks and an HKCU key), so the scripts can be measured without
 *  touching a real installation or needing administrator rights. */
export interface StartupTarget { hive: 'LocalMachine' | 'CurrentUser'; key: string; boot: string; helper: string; signin: string }
export const INSTALLED: StartupTarget = { hive: 'LocalMachine', key: 'SOFTWARE\\Orgtree\\BootEngine', boot: BOOT_TASK, helper: HELPER_TASK, signin: SIGNIN_TASK }

/** Each task's state: true enabled, false disabled, null not installed; and
 *  the start mode the installer's record holds (boot when none is recorded). */
export interface StartupTasks { boot: boolean | null; helper: boolean | null; signin: boolean | null; mode: EngineStartMode }

/** Whether anything of Orgtree's starts by itself: an engine task enabled. */
export const startupOn = (tasks: StartupTasks): boolean => tasks.boot === true || tasks.signin === true

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Reads the tasks through the Task Scheduler's COM interface, which says
 *  "no such task" as an error code rather than in the system's language, and
 *  the recorded start mode, which the operator may read. */
export function readScript(target: StartupTarget = INSTALLED): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$service = New-Object -ComObject Schedule.Service',
    '$service.Connect()',
    "$folder = $service.GetFolder('\\')",
    'function State([string] $Name) {',
    '  try { $task = $folder.GetTask($Name) } catch {',
    "    if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return 'null' }",
    '    throw',
    '  }',
    "  if ($task.Enabled) { return 'true' }",
    "  return 'false'",
    '}',
    "$mode = 'boot'",
    `$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('${target.hive}', 'Registry64')`,
    'try {',
    `  $key = $hive.OpenSubKey(${psQuote(target.key)})`,
    "  if ($null -ne $key) { try { if ([string]$key.GetValue('StartupMode') -ceq 'signin') { $mode = 'signin' } } finally { $key.Dispose() } }",
    '} finally { $hive.Dispose() }',
    `Write-Output ('{"boot":' + (State ${psQuote(target.boot)}) + ',"helper":' + (State ${psQuote(target.helper)}) + ',"signin":' + (State ${psQuote(target.signin)}) + ',"mode":"' + $mode + '"}')`,
  ].join('\n')
}

export function parseStartupTasks(stdout: string): StartupTasks | null {
  const line = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? ''
  try {
    const value = JSON.parse(line) as { boot?: unknown; helper?: unknown; signin?: unknown; mode?: unknown }
    const state = (v: unknown) => (v === true || v === false || v === null ? v : undefined)
    const boot = state(value.boot), helper = state(value.helper), signin = state(value.signin)
    if (boot === undefined || helper === undefined || signin === undefined) return null
    if (value.mode !== 'boot' && value.mode !== 'signin') return null
    return { boot, helper, signin, mode: value.mode }
  } catch { return null }
}

/** The tasks as the operator sees them (reading needs no elevation), or null
 *  when they cannot be read. */
export async function readStartupTasks(runner: Runner = run, target: StartupTarget = INSTALLED): Promise<StartupTasks | null> {
  const result = await runner(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', readScript(target)], 15000)
  return result.code === 0 ? parseStartupTasks(result.stdout) : null
}

/** What each task reads once a choice is applied. */
export function expectedTasks(enabled: boolean, mode: EngineStartMode): { boot: boolean; helper: boolean; signin: boolean } {
  return { boot: enabled && mode === 'boot', helper: enabled, signin: enabled && mode === 'signin' }
}

/** The script the ELEVATED PowerShell runs: only the installer's own tasks
 *  (their description carries the installer record's id) are switched, and
 *  the choice is recorded where the next update reads it. A task is never
 *  stopped or deleted here: one that is running keeps running. */
export function elevatedStartupScript(enabled: boolean, mode: EngineStartMode, target: StartupTarget = INSTALLED): string {
  const want = expectedTasks(enabled, mode)
  const flag = (value: boolean) => (value ? '$true' : '$false')
  return [
    "$ErrorActionPreference = 'Stop'",
    `$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('${target.hive}', 'Registry64')`,
    'try {',
    `  $key = $hive.OpenSubKey(${psQuote(target.key)}, $true)`,
    "  if ($null -eq $key) { throw 'This installation has no startup tasks of its own.' }",
    '  try {',
    "    $id = [string]$key.GetValue('Id')",
    "    if (-not $id) { throw 'The installation record has no id.' }",
    '    $service = New-Object -ComObject Schedule.Service',
    '    $service.Connect()',
    "    $folder = $service.GetFolder('\\')",
    `    $markers = @{ ${psQuote(target.boot)} = 'com.maurdekye.orgtree.boot.v1:'; ${psQuote(target.helper)} = 'com.maurdekye.orgtree.credential-helper.v1:'; ${psQuote(target.signin)} = 'com.maurdekye.orgtree.signin-engine.v1:' }`,
    `    $wanted = @{ ${psQuote(target.boot)} = ${flag(want.boot)}; ${psQuote(target.helper)} = ${flag(want.helper)}; ${psQuote(target.signin)} = ${flag(want.signin)} }`,
    // every task is verified before any is changed: a foreign one refuses all
    '    $tasks = @{}',
    '    foreach ($name in @($markers.Keys)) {',
    '      $task = $null',
    '      try { $task = $folder.GetTask($name) } catch { if ($_.Exception.GetBaseException().HResult -ne -2147024894) { throw } }',
    '      if ($null -eq $task) { continue }',
    '      $xml = [xml]$task.Xml',
    '      if ([string]$xml.Task.RegistrationInfo.Description -cne ($markers[$name] + $id)) { throw "Refusing to change a task Orgtree did not install: $name" }',
    '      $tasks[$name] = $task',
    '    }',
    // the engine must start somewhere when it is supposed to
    ...(want.signin ? [`    if (-not $tasks.ContainsKey(${psQuote(target.signin)})) { throw 'This installation has no sign-in engine task. Install this version of Orgtree again to start the engine at sign-in.' }`] : []),
    '    foreach ($name in @($tasks.Keys)) { $tasks[$name].Enabled = $wanted[$name] }',
    `    $key.SetValue('RunOnStartup', ${enabled ? 1 : 0}, [Microsoft.Win32.RegistryValueKind]::DWord)`,
    `    $key.SetValue('StartupMode', '${mode}', [Microsoft.Win32.RegistryValueKind]::String)`,
    '  } finally { $key.Dispose() }',
    '} finally { $hive.Dispose() }',
  ].join('\n')
}

/** Apply a choice through a Windows permission prompt. Throws, with nothing
 *  changed, when permission is declined or the change does not read back.
 *  `unchanged` says what still holds when the user declines. */
export async function writeStartup(enabled: boolean, mode: EngineStartMode, unchanged: string, runner: Runner = run, target: StartupTarget = INSTALLED): Promise<void> {
  // The user may take a while at the prompt.
  const result = await runner(POWERSHELL, elevatedArgs(elevatedStartupScript(enabled, mode, target)), 5 * 60_000)
  if (result.code === UAC_CANCELLED) throw new Error(`Windows did not give permission, so ${unchanged}.`)
  if (result.code !== 0) throw new Error(`Changing how Orgtree starts failed (exit code ${result.code}).`)
  const after = await readStartupTasks(runner, target)
  const want = expectedTasks(enabled, mode)
  const reads = (actual: boolean | null, expected: boolean) => actual === null || actual === expected
  if (!after || after.boot !== want.boot || !reads(after.signin, want.signin) || !reads(after.helper, want.helper) || after.mode !== mode) {
    throw new Error('The change was made but reads back differently; Orgtree may still start as before.')
  }
}

/** Switch "Run on startup" on or off, keeping where the engine starts. */
export function writeRunOnStartup(enabled: boolean, mode: EngineStartMode, runner: Runner = run, target: StartupTarget = INSTALLED): Promise<void> {
  return writeStartup(enabled, mode, enabled ? 'Orgtree still does not run on startup' : 'Orgtree still runs on startup', runner, target)
}

/** Switch where the engine starts; "Run on startup" stays on. */
export function writeEngineStart(mode: EngineStartMode, runner: Runner = run, target: StartupTarget = INSTALLED): Promise<void> {
  return writeStartup(true, mode, mode === 'signin' ? 'the engine still starts at boot' : 'the engine still starts at sign-in', runner, target)
}

/** Start whichever engine task is enabled: the sign-in engine when it is,
 *  else the boot task, as before the choice existed (also when the tasks
 *  cannot be read). The operator may run either without elevation. */
export async function startEngineTask(runner: Runner = run, target: StartupTarget = INSTALLED): Promise<void> {
  const tasks = await readStartupTasks(runner, target)
  await startTask(tasks?.signin === true ? target.signin : target.boot, runner)
}
