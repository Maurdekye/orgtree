import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'

/** "Run Orgtree as administrator" — whether the background engine and the
 *  agents it starts keep administrator rights.
 *
 *  The boot task's S4U logon gives an administrator account its FULL token,
 *  so the boot host drops those rights before it starts the engine
 *  (engine/unelevated.py) unless this setting is on (engine/service_host.py,
 *  engine_spawner).
 *
 *  ⚠ THE SETTING LIVES IN HKLM, UNDER A KEY ONLY SYSTEM AND ADMINISTRATORS
 *  CAN WRITE — never in the data folder or desktop-settings.json. Every agent
 *  runs as the normal user and can write both of those, so a setting there
 *  would let any agent grant itself administrator rights at the next engine
 *  start. Writing it therefore goes through a UAC prompt, and the key is
 *  (re)created with the same protected ACL the installer gives its boot
 *  record. */

export const RUN_AS_ADMIN_KEY = 'SOFTWARE\\Orgtree\\Runtime'
export const RUN_AS_ADMIN_VALUE = 'RunAsAdministrator'
export const BOOT_TASK = 'Orgtree Background Engine'
/** The sign-in helper, which also starts the boot engine's agent CLIs in the
 *  operator's signed-in session (docket
 *  option-to-run-the-background-engine-in-the-user-s): with "Run Orgtree as
 *  administrator" on, its task runs with the highest privileges, and so do
 *  the CLIs it starts; off, with least privilege (coordinator ruling C,
 *  2026-10-16). */
export const HELPER_TASK = 'Orgtree Credential Helper'
/** ERROR_CANCELLED: the user declined the UAC prompt. */
export const UAC_CANCELLED = 1223
const PROTECTED_KEY_SDDL = 'O:BAG:BAD:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;KR;;;BU)'
export const POWERSHELL = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

/** Where an elevated script leaves its failure message for the launcher: the
 *  hidden elevated PowerShell's own output never reaches the launcher, which
 *  gets only its exit code. `key` is in `hive`, and `nonce` is this change's.
 *  For the installation that is the protected Runtime key (SYSTEM and
 *  Administrators write it, users only read it), never a file: an elevated
 *  write to a path the user can write could be redirected by a link an agent
 *  planted there. The nonce keeps an earlier change's message from being
 *  shown as this one's. */
export interface FailureReport { hive: 'LocalMachine' | 'CurrentUser'; key: string; nonce: string }
export const FAILURE_VALUE = 'LastChangeFailure'
/** The launcher's output line that carries the message, base64 UTF-8. */
export const FAILURE_MARKER = 'ORGTREE-ELEVATED-FAILURE '

/** The report place for one change, with a nonce of its own. */
export function failureReport(hive: FailureReport['hive'] = 'LocalMachine', key: string = RUN_AS_ADMIN_KEY): FailureReport {
  return { hive, key, nonce: randomBytes(16).toString('hex') }
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

/** PowerShell for an elevated script's catch block, after its rollback, with
 *  the script's own `$hive`: leave "<nonce> <message>" for the launcher,
 *  followed by what the rollback could not restore (`$notes`). It never
 *  throws, so the script still ends with the change's own failure. */
export function reportFailureLines(report: FailureReport): string[] {
  return [
    '  try {',
    '    $reportAcl = [Security.AccessControl.RegistrySecurity]::new()',
    `    $reportAcl.SetSecurityDescriptorSddlForm('${PROTECTED_KEY_SDDL}')`,
    `    $reportKey = $hive.CreateSubKey(${psQuote(report.key)}, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $reportAcl)`,
    `    try { $reportKey.SetValue('${FAILURE_VALUE}', ('${report.nonce} ' + ((@([string]$failure.Exception.Message) + $notes) -join '; ')), [Microsoft.Win32.RegistryValueKind]::String) } finally { $reportKey.Dispose() }`,
    '  } catch {}',
  ]
}

/** PowerShell for the end of a change that succeeded: an earlier change's
 *  failure message no longer stands. It never throws. */
export function clearFailureLines(report: FailureReport): string[] {
  return [
    `    try { $reportKey = $hive.OpenSubKey(${psQuote(report.key)}, $true); if ($reportKey) { try { $reportKey.DeleteValue('${FAILURE_VALUE}', $false) } finally { $reportKey.Dispose() } } } catch {}`,
  ]
}

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>

export const run: Runner = (file, args, timeoutMs) => new Promise(resolve => {
  execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
    const code = !error ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
  })
})

/** True only for `RunAsAdministrator REG_DWORD 0x1` — the same rule the boot
 *  host applies: anything else, including absence, is off. */
export function parseRegQuery(stdout: string): boolean {
  const match = new RegExp(`^\\s*${RUN_AS_ADMIN_VALUE}\\s+(\\S+)\\s+(\\S+)\\s*$`, 'im').exec(stdout)
  return !!match && match[1].toUpperCase() === 'REG_DWORD' && /^0x0*1$/i.test(match[2])
}

export async function readRunAsAdministrator(runner: Runner = run): Promise<boolean> {
  const result = await runner('reg', ['query', `HKLM\\${RUN_AS_ADMIN_KEY}`, '/v', RUN_AS_ADMIN_VALUE, '/reg:64'], 4000)
  return result.code === 0 && parseRegQuery(result.stdout)
}

/** PowerShell for the elevated scripts of Run as admin and Run on boot: a
 *  task's operator as a SID, or $null. Its XML holds what the installer registered
 *  and checks, the SID; Task Scheduler's COM principal can give that
 *  account's NAME instead (alpha.34 on the user's PC, 2026-10-22: both owned
 *  tasks read UserId '<account name>'), which a raw comparison with the
 *  record's SID refused. A name is translated; anything that does not
 *  resolve is $null, and $null never matches. */
export const OPERATOR_FUNCTIONS = [
  'function ConvertTo-Sid([string]$Account) {',
  '  if (-not $Account) { return $null }',
  '  try {',
  "    if ($Account -match '^S-1-') { return ([Security.Principal.SecurityIdentifier]::new($Account)).Value }",
  '    return ([Security.Principal.NTAccount]::new($Account)).Translate([Security.Principal.SecurityIdentifier]).Value',
  '  } catch { return $null }',
  '}',
  'function Get-TaskOperatorSid($Task) {',
  '  try { $user = [string]([xml]$Task.Xml).Task.Principals.Principal.UserId } catch { $user = $null }',
  '  if (-not $user) { $user = [string]$Task.Definition.Principal.UserId }',
  '  return ConvertTo-Sid $user',
  '}',
]

/** The script the ELEVATED PowerShell runs: set the run level of both tasks
 *  the installer owns, the Session 0 boot engine and the sign-in helper, to
 *  the same level (both elevated or neither: invariant 7), then create (or
 *  re-protect) the key with the protected ACL and set the DWORD. The tasks
 *  come first, so a refusal leaves the setting as it was, and a failed write
 *  restores them. Only the installer's own tasks are changed: each
 *  description carries the installer record's id. One UAC prompt per change
 *  (invariant 8); every later start runs a task at its stored level. A
 *  user-session task an earlier 4.4.0 alpha left is not touched: the next
 *  update deletes it (decision 94). */
export function elevatedWriteScript(enabled: boolean, report?: FailureReport): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...OPERATOR_FUNCTIONS,
    "$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')",
    '$updated = @(); $originalXml = @{}; $logons = @{}; $notes = @()',
    'try {',
    "  $record = $hive.OpenSubKey('SOFTWARE\\Orgtree\\BootEngine')",
    '  if ($null -ne $record) {',
    '    try {',
    "      $id = [string]$record.GetValue('Id'); $sid = [string]$record.GetValue('OperatorSid'); $operator = ConvertTo-Sid $sid",
    '      $service = New-Object -ComObject Schedule.Service',
    '      $service.Connect()',
    "      $folder = $service.GetFolder('\\')",
    // One "Run as admin" for both owned tasks (the user, 2026-10-21 15:27Z and
    // 2026-10-22 07:29Z): the Session 0 boot engine (S4U, logon 2) and the
    // sign-in helper (interactive token, 3).
    `      $markers = @{ '${BOOT_TASK}' = 'com.maurdekye.orgtree.boot.v1:'; '${HELPER_TASK}' = 'com.maurdekye.orgtree.credential-helper.v1:' }`,
    `      $logonOf = @{ '${BOOT_TASK}' = 2; '${HELPER_TASK}' = 3 }`,
    '      $tasks = @{}',
    // Validate every task before changing any. Enabling with another administrator's
    // credentials cannot give a standard operator an elevated interactive token.
    ...(enabled ? ["      if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $sid) { throw 'Enable Run as admin using the installed operator administrator account.' }"] : []),
    '      foreach ($name in @($markers.Keys)) {',
    '        $task = $null',
    '        try { $task = $folder.GetTask($name) } catch { if ($_.Exception.GetBaseException().HResult -ne -2147024894) { throw } }',
    '        if ($null -eq $task) { continue }',
    '        if (-not $id -or [string]([xml]$task.Xml).Task.RegistrationInfo.Description -cne ($markers[$name] + $id)) { throw "Refusing to change a task Orgtree did not install: $name" }',
    '        if (-not $operator -or (Get-TaskOperatorSid $task) -cne $operator -or $task.Definition.Principal.LogonType -ne $logonOf[$name]) { throw "Task operator does not match the installation: $name" }',
    '        $tasks[$name] = $task',
    '        $originalXml[$name] = [string]$task.Xml; $logons[$name] = $task.Definition.Principal.LogonType',
    '      }',
    '      foreach ($name in @($tasks.Keys)) {',
    '        $task = $tasks[$name]',
    '        $definition = $task.Definition',
    // 1 = TASK_RUNLEVEL_HIGHEST, 0 = least privilege
    `        $definition.Principal.RunLevel = ${enabled ? 1 : 0}`,
    // 20 = TASK_UPDATE | TASK_DONT_ADD_PRINCIPAL_ACE, the task's own logon type, the installer's ACL
    '        $null = $folder.RegisterTaskDefinition($name, $definition, 20, $sid, $null, $logons[$name], "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$sid)")',
    '        $updated += $name',
    '      }',
    '    } finally { $record.Dispose() }',
    '  }',
    '  $acl = [Security.AccessControl.RegistrySecurity]::new()',
    `  $acl.SetSecurityDescriptorSddlForm('${PROTECTED_KEY_SDDL}')`,
    `  $key = $hive.CreateSubKey('${RUN_AS_ADMIN_KEY}', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $acl)`,
    '  try {',
    // An existing key keeps whatever ACL it had unless it is set again.
    '    $key.SetAccessControl($acl)',
    `    $key.SetValue('${RUN_AS_ADMIN_VALUE}', ${enabled ? 1 : 0}, [Microsoft.Win32.RegistryValueKind]::DWord)`,
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

/** The NON-elevated command that asks Windows (UAC) to run the script above
 *  elevated, waits for it and returns its exit code; a declined prompt exits
 *  UAC_CANCELLED. */
export function elevationArgs(enabled: boolean, report?: FailureReport): string[] {
  return elevatedArgs(elevatedWriteScript(enabled, report), report)
}

/** The NON-elevated command that asks Windows (UAC) to run `script` in an
 *  elevated, hidden PowerShell, waits for it and returns its exit code; a
 *  declined prompt exits UAC_CANCELLED. With a `report`, a failed script's
 *  own message for this change follows on a FAILURE_MARKER line. */
export function elevatedArgs(script: string, report?: FailureReport): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const launcher = [
    'try {',
    `  $p = Start-Process -FilePath '${POWERSHELL}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`,
    '  $code = $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    '  while ($e -and -not ($e -is [ComponentModel.Win32Exception])) { $e = $e.InnerException }',
    `  if ($e -and $e.NativeErrorCode -eq ${UAC_CANCELLED}) { exit ${UAC_CANCELLED} }`,
    '  exit 2',
    '}',
    ...(report ? [
      'if ($code -ne 0) {',
      '  try {',
      `    $failureHive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('${report.hive}', 'Registry64')`,
      `    try { $failureKey = $failureHive.OpenSubKey(${psQuote(report.key)}); if ($failureKey) { try { $said = [string]$failureKey.GetValue('${FAILURE_VALUE}') } finally { $failureKey.Dispose() } } } finally { $failureHive.Dispose() }`,
      `    if ($said -and $said.StartsWith('${report.nonce} ', [StringComparison]::Ordinal)) { [Console]::Out.WriteLine('${FAILURE_MARKER}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($said.Substring(${report.nonce.length + 1})))) }`,
      '  } catch {}',
      '}',
    ] : []),
    'exit $code',
  ].join('\n')
  return ['-NoProfile', '-NonInteractive', '-Command', launcher]
}

/** The elevated script's own failure message, from the launcher's output, or
 *  null when it left none for this change. */
export function elevatedFailure(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find(l => l.startsWith(FAILURE_MARKER))
  if (!line) return null
  const said = Buffer.from(line.slice(FAILURE_MARKER.length).trim(), 'base64').toString('utf8').replace(/\s+/g, ' ').trim()
  if (!said) return null
  return said.length > 400 ? `${said.slice(0, 399)}…` : said
}

/** "<what> failed: <the elevated script's own message>.", or the exit code
 *  when it left none. */
export function elevatedFailureMessage(what: string, result: RunResult): string {
  const said = elevatedFailure(result.stdout)
  if (!said) return `${what} (exit code ${result.code}).`
  return `${what}: ${said}${/[.!?…]$/.test(said) ? '' : '.'}`
}

export async function writeRunAsAdministrator(enabled: boolean, runner: Runner = run): Promise<void> {
  const report = failureReport()
  // The user may take a while at the UAC prompt.
  const result = await runner(POWERSHELL, elevationArgs(enabled, report), 5 * 60_000)
  if (result.code === UAC_CANCELLED) throw new Error('Windows did not give permission, so the setting was not changed.')
  if (result.code !== 0) throw new Error(elevatedFailureMessage('Changing the setting failed', result))
  if (await readRunAsAdministrator(runner) !== enabled) throw new Error('The setting was written but reads back differently; it was not changed.')
}

/** Start one of the installer's engine tasks. Their ACL gives the operator
 *  read and execute, so this needs no elevation. */
export async function startTask(name: string, runner: Runner = run): Promise<void> {
  const result = await runner('schtasks', ['/Run', '/TN', name], 15000)
  if (result.code !== 0) throw new Error(`Could not start the background engine task: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`)
}

/** Start the boot task. */
export function startBootTask(runner: Runner = run): Promise<void> {
  return startTask(BOOT_TASK, runner)
}
