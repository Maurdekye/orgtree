import { HELPER_TASK, OPERATOR_FUNCTIONS, POWERSHELL, RUN_AS_ADMIN_KEY, UAC_CANCELLED, clearFailureLines, elevatedArgs, elevatedFailureMessage,
  failureReport, reportFailureLines, run, startTask, type FailureReport, type Runner } from './runasadmin'

/** "Run on boot" on an all-users Windows installation (docket
 *  option-to-run-the-background-engine-in-the-user-s; the user, 2026-10-16
 *  09:37Z: "agents always start at boot, and then automatically get upgraded
 *  when signed in"; 09:38Z: one checkbox, "Run on boot", in place of "Run on
 *  startup" and its "engine starts" choice). Off still means nothing of
 *  Orgtree starts by itself (the user, 2026-10-10: "if i have start on boot
 *  disabled, then nothing should run at all on boot ever until i manually
 *  start orgtree").
 *
 *  The installer registers two tasks that start Orgtree without anyone
 *  opening it (tools/boot-engine-task.ps1): "Orgtree Background Engine" at
 *  boot, in Session 0, and "Orgtree Credential Helper" at the operator's
 *  sign-in. The helper is also the launcher through which the engine starts
 *  its agents' CLIs in the operator's signed-in session while they are signed
 *  in (engine runtime/session_host.rs). On enables both; off disables both,
 *  together with the window's own sign-in entry. Disabled, not deleted: the
 *  installer's ownership of them stays intact, and on again simply re-enables
 *  them. A task that is running is not stopped; the change applies from the
 *  next boot or sign-in.
 *
 *  ⚠ ONLY ADMINISTRATORS MAY CHANGE THE TASKS. Their ACL gives the operator
 *  read and execute and nothing else, on purpose: every agent runs as the
 *  operator, and a task it could rewrite would start whatever it liked at
 *  boot. So a change goes through a Windows permission prompt, exactly as
 *  "Run Orgtree as administrator" does, and it is also written to the
 *  installer's protected record (HKLM\SOFTWARE\Orgtree\BootEngine,
 *  RunOnStartup), which is what the next update applies. What the switch
 *  shows is the boot task's real state, so it never says off while the task
 *  still starts the engine. */

export const BOOT_TASK = 'Orgtree Background Engine'
export { HELPER_TASK }

/** Where the tasks and the installer's record are. Only tests name another
 *  (throwaway tasks and an HKCU key), so the scripts can be measured without
 *  touching a real installation or needing administrator rights. `report`
 *  (in `hive`) is where the elevated script leaves a failure message for the
 *  launcher; without it, a failure shows its exit code only. */
export interface StartupTarget { hive: 'LocalMachine' | 'CurrentUser'; key: string; boot: string; helper: string; report?: string }
export const INSTALLED: StartupTarget = { hive: 'LocalMachine', key: 'SOFTWARE\\Orgtree\\BootEngine', boot: BOOT_TASK, helper: HELPER_TASK, report: RUN_AS_ADMIN_KEY }

/** Each task's state: true enabled, false disabled, null not installed. */
export interface StartupTasks {
  boot: boolean | null; helper: boolean | null
  // Separate damage/installer suspension from the operator's trigger choice.
  // Optional only for callers retaining the older two-field reading.
  bootEnabled?: boolean | null; helperEnabled?: boolean | null
  bootTriggers?: boolean | null; helperTriggers?: boolean | null
}

/** Whether anything of Orgtree's starts by itself: the boot task enabled. */
export const startupOn = (tasks: StartupTasks): boolean => (tasks.bootTriggers ?? tasks.boot) === true

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** Reads the tasks through the Task Scheduler's COM interface, which says
 *  "no such task" as an error code rather than in the system's language. */
export function readScript(target: StartupTarget = INSTALLED): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$service = New-Object -ComObject Schedule.Service',
    '$service.Connect()',
    "$folder = $service.GetFolder('\\')",
    'function State([string] $Name) {',
    '  try { $task = $folder.GetTask($Name) } catch {',
    "    if ($_.Exception.GetBaseException().HResult -eq -2147024894) { return [pscustomobject]@{on=$null;enabled=$null;triggers=$null} }",
    '    throw',
    '  }',
    '  $triggers = @($task.Definition.Triggers | Where-Object { $_.Enabled }).Count -gt 0',
    '  return [pscustomobject]@{on=[bool]($task.Enabled -and $triggers);enabled=[bool]$task.Enabled;triggers=$triggers}',
    '}',
    `$boot = (State ${psQuote(target.boot)})`,
    `$helper = (State ${psQuote(target.helper)})`,
    '[ordered]@{boot=$boot.on;helper=$helper.on;bootEnabled=$boot.enabled;helperEnabled=$helper.enabled;bootTriggers=$boot.triggers;helperTriggers=$helper.triggers} | ConvertTo-Json -Compress',
  ].join('\n')
}

export function parseStartupTasks(stdout: string): StartupTasks | null {
  const line = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? ''
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    const state = (v: unknown) => (v === true || v === false || v === null ? v : undefined)
    const boot = state(value.boot), helper = state(value.helper)
    if (boot === undefined || helper === undefined) return null
    const tasks: StartupTasks = { boot, helper }
    for (const name of ['bootEnabled', 'helperEnabled', 'bootTriggers', 'helperTriggers'] as const) {
      if (!(name in value)) continue
      const read = state(value[name])
      if (read === undefined) return null
      tasks[name] = read
    }
    for (const name of ['boot', 'helper'] as const) {
      const enabled = tasks[`${name}Enabled`], triggers = tasks[`${name}Triggers`]
      if (enabled === undefined && triggers === undefined) continue
      if (enabled === undefined || triggers === undefined || (enabled === null) !== (triggers === null)
        || tasks[name] !== (enabled === null ? null : enabled && triggers)) return null
    }
    return tasks
  } catch { return null }
}

/** The tasks as the operator sees them (reading needs no elevation), or null
 *  when they cannot be read. */
export async function readStartupTasks(runner: Runner = run, target: StartupTarget = INSTALLED): Promise<StartupTasks | null> {
  const result = await runner(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', readScript(target)], 15000)
  return result.code === 0 ? parseStartupTasks(result.stdout) : null
}

/** The script the ELEVATED PowerShell runs: only the installer's own tasks
 *  (their description carries the installer record's id) are switched, and
 *  the choice is recorded where the next update reads it. A task is never
 *  stopped or deleted here: one that is running keeps running. */
export function elevatedStartupScript(enabled: boolean, target: StartupTarget = INSTALLED, report?: FailureReport): string {
  const flag = enabled ? '$true' : '$false'
  return [
    "$ErrorActionPreference = 'Stop'",
    ...OPERATOR_FUNCTIONS,
    `$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('${target.hive}', 'Registry64')`,
    '$updated = @(); $originalXml = @{}; $logons = @{}; $notes = @()',
    'try {',
    `  $key = $hive.OpenSubKey(${psQuote(target.key)}, $true)`,
    "  if ($null -eq $key) { throw 'This installation has no startup tasks of its own.' }",
    '  try {',
    "    $id = [string]$key.GetValue('Id')",
    "    $sid = [string]$key.GetValue('OperatorSid'); $operator = ConvertTo-Sid $sid",
    "    if (-not $id) { throw 'The installation record has no id.' }",
    '    $service = New-Object -ComObject Schedule.Service',
    '    $service.Connect()',
    "    $folder = $service.GetFolder('\\')",
    `    $markers = @{ ${psQuote(target.boot)} = 'com.maurdekye.orgtree.boot.v1:'; ${psQuote(target.helper)} = 'com.maurdekye.orgtree.credential-helper.v1:' }`,
    // every task is verified before any is changed: a foreign one refuses all
    '    $tasks = @{}',
    '    foreach ($name in @($markers.Keys)) {',
    '      $task = $null',
    '      try { $task = $folder.GetTask($name) } catch { if ($_.Exception.GetBaseException().HResult -ne -2147024894) { throw } }',
    '      if ($null -eq $task) { continue }',
    '      $xml = [xml]$task.Xml',
    '      if ([string]$xml.Task.RegistrationInfo.Description -cne ($markers[$name] + $id)) { throw "Refusing to change a task Orgtree did not install: $name" }',
    '      if (-not $operator -or (Get-TaskOperatorSid $task) -cne $operator) { throw "Task operator does not match the installation: $name" }',
    '      $tasks[$name] = $task',
    '      $originalXml[$name] = [string]$task.Xml; $logons[$name] = $task.Definition.Principal.LogonType',
    '    }',
    '    foreach ($name in @($tasks.Keys)) {',
    '      $definition = $tasks[$name].Definition',
    '      $definition.Settings.Enabled = $true',
    `      foreach ($trigger in $definition.Triggers) { $trigger.Enabled = ${flag} }`,
    '      $logon = $definition.Principal.LogonType',
    '      $null = $folder.RegisterTaskDefinition($name, $definition, 20, $sid, $null, $logon, "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$sid)")',
    '      $updated += $name',
    '    }',
    `    $key.SetValue('RunOnStartup', ${enabled ? 1 : 0}, [Microsoft.Win32.RegistryValueKind]::DWord)`,
    ...(report ? clearFailureLines(report) : []),
    '  } finally { $key.Dispose() }',
    '} catch {',
    '  $failure = $_',
    '  foreach ($name in $updated) { try { $null = $folder.RegisterTask($name, $originalXml[$name], 20, $sid, $null, $logons[$name], "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$sid)") } catch { $notes += "the task $name could not be restored: $($_.Exception.Message)"; Write-Warning "Could not restore task $name after failed change: $_" } }',
    ...(report ? reportFailureLines(report) : []),
    '  throw $failure',
    '} finally { $hive.Dispose() }',
  ].join('\n')
}

/** Switch "Run on boot" through a Windows permission prompt. Throws, with
 *  nothing changed, when permission is declined or the change does not read
 *  back. */
export async function writeRunOnStartup(enabled: boolean, runner: Runner = run, target: StartupTarget = INSTALLED): Promise<void> {
  const report = target.report ? failureReport(target.hive, target.report) : undefined
  // The user may take a while at the prompt.
  const result = await runner(POWERSHELL, elevatedArgs(elevatedStartupScript(enabled, target, report), report), 5 * 60_000)
  const unchanged = enabled ? 'Orgtree still does not run on boot' : 'Orgtree still runs on boot'
  if (result.code === UAC_CANCELLED) throw new Error(`Windows did not give permission, so ${unchanged}.`)
  if (result.code !== 0) throw new Error(elevatedFailureMessage('Changing "run on boot" failed', result))
  const after = await readStartupTasks(runner, target)
  if (!after || after.boot !== enabled || after.bootEnabled === false || after.helperEnabled === false
    || (after.helper !== null && after.helper !== enabled)) {
    throw new Error('The change was made but reads back differently; Orgtree may still start as before.')
  }
}

/** Start the boot engine task, which the operator may run without
 *  elevation: crash recovery and "Restart the background engine now". */
export function startEngineTask(runner: Runner = run, target: StartupTarget = INSTALLED): Promise<void> {
  return startTask(target.boot, runner)
}
