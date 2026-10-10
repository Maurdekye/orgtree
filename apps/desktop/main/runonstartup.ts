import { POWERSHELL, UAC_CANCELLED, elevatedArgs, run, type Runner } from './runasadmin'

/** "Run on startup" on an all-users Windows installation (docket
 *  start-at-login-off-means-nothing-of-orgtree-star; the user, 2026-10-10:
 *  "if i have start on boot disabled, then nothing should run at all on boot
 *  ever until i manually start orgtree").
 *
 *  The installer registers two tasks that start Orgtree without anyone opening
 *  it: "Orgtree Background Engine" at boot and "Orgtree Credential Helper" at
 *  sign-in (tools/boot-engine-task.ps1). The setting turns both on or off,
 *  together with the window's own sign-in entry. Disabled, not deleted: the
 *  installer's ownership of them stays intact, and on again simply re-enables
 *  them. A task that is running is not stopped; the change applies from the
 *  next boot.
 *
 *  ⚠ ONLY ADMINISTRATORS MAY CHANGE THE TASKS. Their ACL gives the operator
 *  read and execute and nothing else, on purpose: every agent runs as the
 *  operator, and a task it could rewrite would start whatever it liked at
 *  boot. So a change goes through a Windows permission prompt, exactly as
 *  "Run Orgtree as administrator" does, and it is also written to the
 *  installer's protected record (HKLM\SOFTWARE\Orgtree\BootEngine,
 *  RunOnStartup), which is what the next update applies. What the switch
 *  shows is the boot task's real state, so it never says off while the task
 *  still starts at boot. */

export const BOOT_TASK = 'Orgtree Background Engine'
export const HELPER_TASK = 'Orgtree Credential Helper'

/** Where the tasks and the installer's record are. Only tests name another
 *  (throwaway tasks and an HKCU key), so the scripts can be measured without
 *  touching a real installation or needing administrator rights. */
export interface StartupTarget { hive: 'LocalMachine' | 'CurrentUser'; key: string; boot: string; helper: string }
export const INSTALLED: StartupTarget = { hive: 'LocalMachine', key: 'SOFTWARE\\Orgtree\\BootEngine', boot: BOOT_TASK, helper: HELPER_TASK }

/** Each task's state: true enabled, false disabled, null not installed. */
export interface StartupTasks { boot: boolean | null; helper: boolean | null }

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Reads both tasks through the Task Scheduler's COM interface, which says
 *  "no such task" as an error code rather than in the system's language. */
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
    `Write-Output ('{"boot":' + (State ${psQuote(target.boot)}) + ',"helper":' + (State ${psQuote(target.helper)}) + '}')`,
  ].join('\n')
}

export function parseStartupTasks(stdout: string): StartupTasks | null {
  const line = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? ''
  try {
    const value = JSON.parse(line) as { boot?: unknown; helper?: unknown }
    const state = (v: unknown) => (v === true || v === false || v === null ? v : undefined)
    const boot = state(value.boot), helper = state(value.helper)
    if (boot === undefined || helper === undefined) return null
    return { boot, helper }
  } catch { return null }
}

/** Both tasks as the operator sees them (reading needs no elevation), or null
 *  when they cannot be read. */
export async function readStartupTasks(runner: Runner = run, target: StartupTarget = INSTALLED): Promise<StartupTasks | null> {
  const result = await runner(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', readScript(target)], 15000)
  return result.code === 0 ? parseStartupTasks(result.stdout) : null
}

/** The script the ELEVATED PowerShell runs: only the installer's own tasks
 *  (their description carries the installer record's id) are switched, and
 *  the choice is recorded where the next update reads it. A task is never
 *  stopped or deleted here: one that is running keeps running. */
export function elevatedStartupScript(enabled: boolean, target: StartupTarget = INSTALLED): string {
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
    `    $markers = @{ ${psQuote(target.boot)} = 'com.maurdekye.orgtree.boot.v1:'; ${psQuote(target.helper)} = 'com.maurdekye.orgtree.credential-helper.v1:' }`,
    // every task is verified before any is changed: a foreign one refuses all
    '    $tasks = @()',
    '    foreach ($name in @($markers.Keys)) {',
    '      $task = $null',
    '      try { $task = $folder.GetTask($name) } catch { if ($_.Exception.GetBaseException().HResult -ne -2147024894) { throw } }',
    '      if ($null -eq $task) { continue }',
    '      $xml = [xml]$task.Xml',
    '      if ([string]$xml.Task.RegistrationInfo.Description -cne ($markers[$name] + $id)) { throw "Refusing to change a task Orgtree did not install: $name" }',
    '      $tasks += $task',
    '    }',
    `    foreach ($task in $tasks) { $task.Enabled = $${enabled ? 'true' : 'false'} }`,
    `    $key.SetValue('RunOnStartup', ${enabled ? 1 : 0}, [Microsoft.Win32.RegistryValueKind]::DWord)`,
    '  } finally { $key.Dispose() }',
    '} finally { $hive.Dispose() }',
  ].join('\n')
}

/** Switch both tasks through a Windows permission prompt. Throws, with nothing
 *  changed, when permission is declined or the change does not read back. */
export async function writeRunOnStartup(enabled: boolean, runner: Runner = run, target: StartupTarget = INSTALLED): Promise<void> {
  // The user may take a while at the prompt.
  const result = await runner(POWERSHELL, elevatedArgs(elevatedStartupScript(enabled, target)), 5 * 60_000)
  if (result.code === UAC_CANCELLED) {
    throw new Error(`Windows did not give permission, so Orgtree ${enabled ? 'still does not run' : 'still runs'} on startup.`)
  }
  if (result.code !== 0) throw new Error(`Changing "run on startup" failed (exit code ${result.code}).`)
  const after = await readStartupTasks(runner, target)
  if (!after || after.boot !== enabled) throw new Error('The change was made but reads back differently; Orgtree may still run on startup.')
}
