import { execFile } from 'node:child_process'

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
/** ERROR_CANCELLED: the user declined the UAC prompt. */
export const UAC_CANCELLED = 1223
const PROTECTED_KEY_SDDL = 'O:BAG:BAD:P(A;;KA;;;SY)(A;;KA;;;BA)(A;;KR;;;BU)'
const POWERSHELL = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

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

/** The script the ELEVATED PowerShell runs: create (or re-protect) the key
 *  with the protected ACL, then set the DWORD. */
export function elevatedWriteScript(enabled: boolean): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')",
    'try {',
    '  $acl = [Security.AccessControl.RegistrySecurity]::new()',
    `  $acl.SetSecurityDescriptorSddlForm('${PROTECTED_KEY_SDDL}')`,
    `  $key = $hive.CreateSubKey('${RUN_AS_ADMIN_KEY}', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $acl)`,
    '  try {',
    // An existing key keeps whatever ACL it had unless it is set again.
    '    $key.SetAccessControl($acl)',
    `    $key.SetValue('${RUN_AS_ADMIN_VALUE}', ${enabled ? 1 : 0}, [Microsoft.Win32.RegistryValueKind]::DWord)`,
    '  } finally { $key.Dispose() }',
    '} finally { $hive.Dispose() }',
  ].join('\n')
}

/** The NON-elevated command that asks Windows (UAC) to run the script above
 *  elevated, waits for it and returns its exit code; a declined prompt exits
 *  UAC_CANCELLED. */
export function elevationArgs(enabled: boolean): string[] {
  const encoded = Buffer.from(elevatedWriteScript(enabled), 'utf16le').toString('base64')
  const launcher = [
    'try {',
    `  $p = Start-Process -FilePath '${POWERSHELL}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`,
    '  exit $p.ExitCode',
    '} catch {',
    '  $e = $_.Exception',
    '  while ($e -and -not ($e -is [ComponentModel.Win32Exception])) { $e = $e.InnerException }',
    `  if ($e -and $e.NativeErrorCode -eq ${UAC_CANCELLED}) { exit ${UAC_CANCELLED} }`,
    '  exit 2',
    '}',
  ].join('\n')
  return ['-NoProfile', '-NonInteractive', '-Command', launcher]
}

export async function writeRunAsAdministrator(enabled: boolean, runner: Runner = run): Promise<void> {
  // The user may take a while at the UAC prompt.
  const result = await runner(POWERSHELL, elevationArgs(enabled), 5 * 60_000)
  if (result.code === UAC_CANCELLED) throw new Error('Windows did not give permission, so the setting was not changed.')
  if (result.code !== 0) throw new Error(`Changing the setting failed (exit code ${result.code}).`)
  if (await readRunAsAdministrator(runner) !== enabled) throw new Error('The setting was written but reads back differently; it was not changed.')
}

/** Start the boot task. Its ACL gives the operator read and execute, so this
 *  needs no elevation. */
export async function startBootTask(runner: Runner = run): Promise<void> {
  const result = await runner('schtasks', ['/Run', '/TN', BOOT_TASK], 15000)
  if (result.code !== 0) throw new Error(`Could not start the background engine task: ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`)
}
