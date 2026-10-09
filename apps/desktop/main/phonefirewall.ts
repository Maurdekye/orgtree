import { POWERSHELL, UAC_CANCELLED, run } from './runasadmin'
import type { Runner } from './runasadmin'

/** "Chat from your phone" › Turn on phone access: one inbound Windows
 *  Firewall rule for the mail hub's relay-only door (port 7371), limited to
 *  Tailscale's addresses, or to the local subnet for "Use my home Wi-Fi
 *  instead". Adding it needs administrator rights, so it goes through ONE UAC
 *  prompt here, in the desktop: the engine may run under the boot task's
 *  S4U logon, which has no desktop to show a prompt on. The engine only reads
 *  the rule back (engine/rs/orgtree-engine/src/phone.rs). */

export const PHONE_RULE = 'Orgtree phone access'
export const PHONE_DOOR_PORT = 7371
/** Tailscale's address ranges: its CGNAT IPv4 block and its ULA IPv6 prefix. */
export const TAILNET_REMOTE = '100.64.0.0/10,fd7a:115c:a1e0::/48'
export type PhoneScope = 'tailnet' | 'lan'

export function phoneRemote(scope: PhoneScope): string {
  return scope === 'tailnet' ? TAILNET_REMOTE : 'LocalSubnet'
}

/** The script the ELEVATED PowerShell runs: replace the rule. */
export function phoneFirewallScript(scope: PhoneScope): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `Remove-NetFirewallRule -DisplayName '${PHONE_RULE}' -ErrorAction SilentlyContinue`,
    `New-NetFirewallRule -DisplayName '${PHONE_RULE}' -Description 'Lets Hubchat on your phone reach the Orgtree mail hub (its relay-only door). Added by Connect your phone.'`
      + ` -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PHONE_DOOR_PORT} -RemoteAddress ${phoneRemote(scope)} -Profile Any | Out-Null`,
  ].join('\n')
}

/** The NON-elevated command that asks Windows (UAC) to run the script above
 *  elevated and returns its exit code; a declined prompt exits UAC_CANCELLED. */
export function phoneFirewallArgs(scope: PhoneScope): string[] {
  const encoded = Buffer.from(phoneFirewallScript(scope), 'utf16le').toString('base64')
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

/** What the prompt came to: `declined` is the user's No (nothing changed). */
export type PhoneFirewallResult = { ok: true } | { ok: false; declined: boolean; error: string }

export async function addPhoneFirewallRule(scope: PhoneScope, runner: Runner = run): Promise<PhoneFirewallResult> {
  if (process.platform !== 'win32') return { ok: false, declined: false, error: 'Only Windows has this firewall.' }
  // the user may take a while at the UAC prompt
  const result = await runner(POWERSHELL, phoneFirewallArgs(scope), 5 * 60_000)
  if (result.code === UAC_CANCELLED) return { ok: false, declined: true, error: 'Nothing changed: phone access stays as it was.' }
  if (result.code !== 0) return { ok: false, declined: false, error: `The firewall rule could not be added (exit code ${result.code}).` }
  return { ok: true }
}
